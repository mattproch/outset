# Outset

A macOS app for spec-driven development with Claude Code. Each project is a folder. Inside each project: a structured spec (markdown under `.spec/`), a task list, and one or more Claude Agent SDK sessions that execute work against the spec. Connectors (Jira, Linear, etc.) attach to projects via MCP.

> The repo folder is named `termi` for historical reasons; nothing inside references the folder name, so feel free to rename to `outset` locally.

## Status: v0.0.4

The app is usable day-to-day for its core loop: pick a folder, chat with Claude in the context of that folder, watch it draft and maintain a `.spec/` tree (product/codebase/tasks) while you implement in your own editor.

What works:
- Tauri 2 + React + Vite + Tailwind shell, with auto-updater wired through `tauri-plugin-updater`.
- A Node sidecar that wraps the Agent SDK and streams NDJSON events over stdio. One sidecar process per user message; multi-turn conversations resume by SDK session id.
- Multi-project sidebar with per-project color, permission mode, and persisted session history (single `state.json` in the OS app-data dir).
- Spec mode — Claude reads/writes `.spec/product/`, `.spec/codebase/`, and `.spec/tasks/TASK-NNN/` with a custom system prompt, clarifying-question loop, and a task dashboard rendered from the file tree.
- A right-hand git panel: status, per-file diff, commit, push, init, clone, set/remove origin.
- Filesystem watcher on `.spec/` — external edits (your editor, `git pull`, Claude mid-turn) are reflected in the UI within ~250 ms, without forcing a project switch or a manual refresh.
- Permission modes per project: `ask`, `acceptEdits`, `bypassAll`.

Not yet: MCP server config UI, code-sign + notarize for distributed builds, crash recovery.

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
- **Node 20+**.
- **Yarn 1.22.x** (`npm install -g yarn`).
- **`claude` CLI logged in** — `claude login` if not. Outset uses your subscription auth; no API key required.

## First-run setup

```bash
git clone <this repo>
cd outset            # or whatever you named the folder
yarn install         # pulls Tauri frontend + sidecar deps via Yarn workspaces
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

A separate filesystem watcher (Rust-side, via the `notify` crate) is bound to the active project's `.spec/` tree and emits a debounced `spec-files-changed` event. The frontend re-reads the spec tree on each event, so external edits show up automatically.

## Things you'll likely hit on the first run

- **"tsx not found at .../node_modules/.bin/tsx"** — `yarn install` didn't run, or the workspace root is wrong.
- **First Rust build takes forever** — that's normal; Tauri pulls a lot of crates the first time. Subsequent builds are fast.
- **macOS Gatekeeper complains on `yarn tauri build`** — code signing isn't wired yet for distributed builds. For dev, `tauri dev` doesn't bundle so you won't see this.
- **"Not logged in · Please run /login"** — the Agent SDK couldn't find your subscription auth. Run `claude login` and try again.
- **Icons missing on `yarn tauri build`** — generate them with `yarn tauri icon path/to/source.png`. `tauri dev` doesn't need them.

## Roadmap

- MCP server config per project (Jira via the Atlassian MCP, Linear, etc.).
- Code-sign + notarize for distributed builds, crash recovery.
- Settings panel (model selection, default permission mode, theme).
