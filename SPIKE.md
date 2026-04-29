# Outset — Week-1 Spike Report

**Date:** 2026-04-25
**SDK version:** `@anthropic-ai/claude-agent-sdk@0.2.119`
**Claude Code version reported by SDK:** `2.1.119`
**Goal:** validate that we can drive Claude from inside our own process using subscription auth, and that the streaming surface is rich enough to render a chat UI in week 2.

## TL;DR

Status: **closed, all three unknowns resolved. Proceed to week 2.**

| Question | Answer |
|---|---|
| Does the SDK pick up the user's existing `claude` CLI subscription auth without an API key? | **Yes.** Verified end-to-end on macOS: with `~/.claude/` present and no `ANTHROPIC_API_KEY` set, the SDK authenticated cleanly and ran a 3-turn agentic loop. Negative case (no auth) was also exercised in the Linux sandbox and produces a clean, machine-readable error. |
| Does it work as a child process with no TTY? | **Yes.** `parent.ts` spawns the spike with piped stdio, no TTY, and gets the first stdout chunk in **125 ms** on macOS (and 126 ms in the Linux sandbox). All events flow through. |
| Are streaming events rich enough for a chat UI? | **Yes.** Structured JSON, typed `type`/`subtype` discriminators, full content-block payloads (including thinking blocks and tool_use/tool_result pairs), session/UUID identifiers, and a terminal `result` message with cost + turns. |

## Verified end-to-end

Two run modes, both green on macOS (Node 24, Yarn 1.22.22, Claude Code config in `~/.claude/`):

**Direct** (`yarn spike`) — 13 messages, 3 turns, 12.3 s, exit 0, `sandbox/hello.md` created.

**Child process** (`yarn spike:child`) — 16 messages, 4 turns, 18.4 s, first stdout chunk in **125 ms**, exit 0, `sandbox/hello.md` created. The parent process used `spawn(node, ['--import', 'tsx', 'src/spike.ts'])` with `stdio: ['ignore', 'pipe', 'pipe']` and explicitly cleared `ANTHROPIC_API_KEY` to force the subscription path.

Negative case (sandbox, no auth) — `apiKeySource: "none"` on `system/init`, terminal `Error: Not logged in · Please run /login`, plus an `assistant` message carrying `error: "authentication_failed"`. Three independent signals make a "please log in" UX trivial to wire up.

## Surprise findings

- **Cost is reported even on subscription.** A direct run logged `total_cost_usd ≈ 0.031`; the child-process run logged `≈ 0.212`. This is the SDK reporting the *equivalent API cost* of the work, not money actually charged. We can surface it in the app as "estimated value used" or roll it up into per-project usage stats.
- **`hook_started` / `hook_response` system events fire before `init`.** The spike got two pairs of these on every macOS run, before the regular `system / init` event. They're hooks the user has installed locally (e.g. status-line, login monitors) running through Claude Code's hook surface — harmless to log, but the UI should ignore them or render them collapsed by default.
- **Run-to-run variance in turns.** The two macOS runs took 3 and 4 turns for the same prompt. Expected for an agentic loop, but worth designing the UI for: don't surface a fixed "step 2 of 3" indicator — render whatever turns happen.

## Event shapes observed

From `sandbox/events-*.jsonl`. Three messages per run, two runs (direct + child):

**`type: "system", subtype: "init"`** — fired once at session start. Notable fields:
- `session_id`, `uuid` — primary keys for persistence and resume
- `model` — `claude-sonnet-4-6`
- `tools` — the actual list available, after applying our `tools: ["Read", "Write", "Edit"]` filter (verified: only those three appeared)
- `permissionMode` — `"bypassPermissions"` as we set it
- `apiKeySource: "none"` — definitive answer to "does the SDK know about auth?" Yes
- `slash_commands`, `agents`, `skills`, `plugins`, `memory_paths` — every Claude Code surface area is exposed to the SDK consumer
- `claude_code_version: "2.1.119"` — matches the host CLI

**`type: "assistant"`** — one per assistant turn. Includes `message.content` blocks (text, tool_use, etc.), `parent_tool_use_id`, `session_id`, `uuid`, and on auth failure an `error: "authentication_failed"` field. The error code matches the `SDKAssistantMessageError` union in the SDK's `.d.ts`.

**`type: "result", subtype: "success" | "error_*"`** — one terminal message per run. Includes `num_turns`, `total_cost_usd`, `duration_ms`, `usage`. This is what we'd render as "session complete" in the UI.

Full event log preserved at `sandbox/events-2026-04-25T15-51-41-376Z.jsonl` (and the child-process equivalent next to it).

## Decisions worth remembering for the app

1. **Per-session sidecar process.** `parent.ts` proves the pattern: one Node process per Claude session, spawned by the Tauri shell, with stdio piped for IPC. Crashes are isolated, kill-switch is `process.kill`, and the streaming events go straight from Claude into the UI with one JSON parse step.
2. **Don't shell out to the `claude` binary directly.** The SDK gives us typed events, structured tool restrictions, programmatic `canUseTool`, and MCP server config — all things we'd otherwise have to scrape from the CLI. Use the SDK.
3. **Sandbox the agent's `cwd` per session.** We pointed `query()` at `./sandbox/` and combined with `tools: ["Read", "Write", "Edit"]` got effective path containment. For real projects we'll point `cwd` at the project folder and rely on the same tool-restriction surface.
4. **`persistSession: false` for ephemeral runs** (e.g. the spec-mode "ask a clarifying question" loop). Keeps `~/.claude/projects/` clean.
5. **Auth failure is graceful and machine-readable.** The SDK throws an `Error` whose message includes the `/login` instruction, AND we see `apiKeySource: "none"` on `system/init`, AND we get an `assistant` message with `error: "authentication_failed"`. Three independent signals — easy to render a clean "please log in" banner in the UI.
6. **`canUseTool` is the hook for the permission UI.** For the real app we'll replace `permissionMode: "bypassPermissions"` with a `canUseTool` callback that pops a permission dialog. The SDK passes us `title`, `displayName`, `description`, and `decisionReason` — the dialog content essentially writes itself.

## How to run the green-path validation on the Mac

From the project root, with `claude` already logged in (`claude login` if not):

```bash
yarn install                          # installs all workspaces
yarn workspace outset-spike spike     # direct
yarn workspace outset-spike spike:child  # child-process variant
```

Expected outcome: `sandbox/hello.md` is created, the script logs `messages=N elapsed=Ms`, exits 0, and the JSONL log shows `apiKeySource` set to a subscription-related value rather than `"none"`. Once those two runs go green, week 2 can start.

## Open items / followups

- **Permission UX design.** `canUseTool` returns a `Promise<PermissionResult>` — we need to design the modal (allow once / always allow this tool / always allow for this project / deny). The `suggestions` field on the callback gives us the data to power the "always allow" options.
- **Session resume.** The SDK exposes `getSessionInfo`, `listSessions`, `forkSession`, `unstable_v2_resumeSession`. Worth a focused spike in week 4 when we add multi-session UI.
- **MCP wiring.** `Options.mcpServers` and `AgentDefinition.mcpServers` exist; we'll lean on these in week 5 for Jira via MCP. No spike needed — it's plumbing.
