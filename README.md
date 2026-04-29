# Outset

A macOS app for spec-driven development with Claude Code. Each project is a folder. Inside each project: a structured spec (markdown), a task list, and one or more Claude Agent SDK sessions that execute work against the spec. Connectors (Jira, Linear, etc.) attach to projects via MCP.

> The folder this repo lives in is currently named `termi` for historical reasons. Rename it to `outset` in Finder anytime — nothing inside references the folder name.

## Status: Week 2 — Tauri shell

Week 1 ([SPIKE.md](./SPIKE.md)) validated that the Claude Agent SDK works with subscription auth and streams cleanly through piped stdio. Week 2 wraps that into a real desktop app: pick a folder, chat with Claude in the context of that folder, watch it edit files.

What works in week 2:
- Tauri 2 + React + Vite + Tailwind shell
- A Node sidecar that wraps the Agent SDK and streams NDJSON events over stdio
- Folder picker via the system dialog
- Single chat session per app run, with multi-turn (sessions resume by id)
- Tool calls and results render distinctly from assistant text
- `acceptEdits` permission mode — Claude edits files without asking; we'll wire a real permission UI in week 3

Cuts: no project list, no spec system, no MCP yet, no settings panel.

## Repo layout

```
.
├── src/                  # React frontend (Vite)
├── src-tauri/            # Rust backend (Tauri 2)
├── sidecar/              # Node sidecar — wraps the Agent SDK
├── spike/                # Archived week-1 spike
├── package.json          # Yarn workspaces root
├── yarn.lock
└── SPIKE.md              # Week-1 findings
```

The `package.json` at the root declares Yarn workspaces for `sidecar` and `spike`, so a single `yarn install` covers everything.

## Prerequisites

- **macOS 12+** with command-line tools (`xcode-select --install`).
- **Rust toolchain** via [rustup](https://rustup.rs): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. The first build will pull a few hundred MB of crates; later builds are incremental.
- **Node 20+** (you're on 24, that's fine).
- **Yarn 1.22.x** (`npm install -g yarn`).
- **`claude` CLI logged in** — `claude login` if not. Outset uses your subscription auth; no API key required.

## First-run setup

You're coming from week 1 with a partial install at the repo root. Clean it up, then install fresh:

```bash
cd ~/Development/Matyas\ Prochazka/termi      # rename to outset whenever
rm -rf node_modules sandbox spike/node_modules spike/yarn.lock
yarn install                                   # pulls Tauri frontend + sidecar + spike deps
```

Then for the very first run, the Rust side will compile from scratch (~3 minutes the first time, then ~5–10 seconds incremental):

```bash
yarn tauri dev
```

This starts Vite (frontend, port 1420), then launches the Tauri shell pointed at it. The Outset window should open. Pick a folder, type a message, watch Claude work.

## Day-to-day commands

```bash
yarn tauri dev            # run the app in dev (with hot reload)
yarn tauri build          # build a production .app bundle
yarn typecheck            # typecheck the frontend
yarn sidecar:typecheck    # typecheck the sidecar
yarn workspace outset-spike spike  # re-run the week-1 spike if you ever need to
```

## How it fits together

```
React UI  ──invoke("send_message")──▶  Rust (Tauri command)
                                            │
                                            ▼
                                       spawns `tsx sidecar/src/index.ts`
                                            │
                                            ▼  stdin: { cwd, prompt, resume }
                                       Node sidecar
                                            │
                                            ▼  uses @anthropic-ai/claude-agent-sdk
                                       Claude (via subscription)
                                            │
                                            ▼  stdout: NDJSON events
                                       Rust forwards as Tauri events
                                            │
                                            ▼
React UI  ◀──listen("sidecar-event")──  app_handle.emit
```

One sidecar process per user message (preempted on the next message). The session id is captured from the SDK's first `system/init` event and passed back on subsequent turns as `resume`, so multi-turn conversations resume the same Claude session.

## Things you'll likely hit on the first run

- **"tsx not found at .../node_modules/.bin/tsx"** — `yarn install` didn't run, or the workspace root is wrong.
- **First Rust build takes forever** — that's normal; Tauri pulls a lot of crates the first time. Subsequent builds are fast.
- **macOS Gatekeeper complains on `yarn tauri build`** — code signing isn't wired yet (week 6). For dev, `tauri dev` doesn't bundle so you won't see this.
- **"Not logged in · Please run /login"** — the Agent SDK couldn't find your subscription auth. Run `claude login` and try again.
- **Icons missing on `yarn tauri build`** — `tauri.conf.json` references icons that don't exist yet. Generate them with `yarn tauri icon path/to/source.png`. `tauri dev` doesn't need them.

## Roadmap

- **Week 3:** spec mode — `.spec/` folder convention, custom system prompt, clarifying-question loop, task list rendered from `tasks.md`.
- **Week 4:** multi-project sidebar, multi-session per project, SQLite for metadata.
- **Week 5:** MCP server config per project (Jira via the Atlassian MCP).
- **Week 6:** code-sign + notarize, crash recovery, ship v0.1.
