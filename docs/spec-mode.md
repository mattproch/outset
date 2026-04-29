# Spec mode

The headline feature of Outset. This document is the source of truth for what spec mode is, what files it produces, and how the agent behaves. Code drifts; this doc is the intent.

## Thesis

Most AI coding tools jump straight to code. The result is plausible-looking output that misses the requirements you forgot to mention. Outset forces a pre-coding loop: the agent maintains a structured spec organized by **audience** — what the product is (for the client/PM), how the codebase works (for the developer), and what's changing right now (for whoever's doing the work). Tasks complete by folding into the spec, leaving the spec current and the task backlog small. The whole tree is committed to git.

## File structure

```
.spec/
├── product/                 ← PRODUCT specification
│   ├── overview.md          ← what we're building, plain language
│   ├── users.md             ← who it's for
│   ├── goals.md             ← success criteria; non-goals
│   └── decisions.md         ← product decisions, newest first
├── codebase/                ← CODEBASE specification
│   ├── overview.md          ← architectural summary
│   ├── architecture.md      ← deeper how
│   ├── features/
│   │   └── FEAT-NNN.md      ← per-feature mechanics
│   └── decisions.md         ← technical decisions, newest first
└── tasks/                   ← WORK IN FLIGHT
    └── TASK-NNN/
        ├── requirements.md
        ├── questions.md
        └── subtasks.md
```

## The three specs

The boundary between specs is **audience**:

|         | product/                    | codebase/                        | tasks/                          |
|---------|-----------------------------|----------------------------------|---------------------------------|
| Reader  | Client / PM / non-developer | Developer onboarding the code    | Whoever's planning current work |
| Tense   | Present (the offering)      | Present (the code)               | Future (what's changing)        |
| Updates | Tasks with user-visible changes fold here | Tasks with code changes fold here | Created via "+ Add task"     |

Product and codebase are **peers**, not parent and child. A task that adds a user-visible feature folds into both (a goals/overview update on the product side, a new `FEAT-NNN.md` on the codebase side, a `Decisions` entry in each). A purely technical task folds only into codebase. A purely product-level task folds only into product.

## Naming

- **Task** = the unit of work in flight. Was previously called "topic". Lives at `tasks/TASK-NNN/`.
- **Subtask** = an individual checkbox inside a task's `subtasks.md`. Was previously called "task". Each subtask gets its own code session when executed.
- **Feature** = a piece of functionality that exists in the system. Lives at `codebase/features/FEAT-NNN.md`.

## No project-level loose backlog

`open-questions.md` and `open-tasks.md` are gone. Questions belong inside a task; ad-hoc questions get answered in chat without ceremony. Subtasks always live inside a task. If something is worth doing, it's a task; if it's not worth a task, it's nothing.

## Activities

When the user clicks a UI affordance that starts a guided flow, Outset prepends a marker to the next outgoing message. The displayed message stays clean; the agent sees the marker and runs the corresponding flow.

| Marker                      | Trigger                       | Writes to               |
|-----------------------------|-------------------------------|-------------------------|
| `[Define product]`          | + Define product (Product tab)| `product/`              |
| `[Map codebase]`             | + Map codebase (Codebase tab) | `codebase/`             |
| `[Creating a new task]`     | + Add task (Tasks tab)        | `tasks/TASK-NNN/`       |

Each activity has a tight scope. Outside an activity, the agent edits whatever the conversation calls for.

## Sessions

One spec session per project. All flows route through it via activity markers. Subtask execution still happens in dedicated code sessions (one per subtask).

The "Spec" tab from earlier iterations is gone — flows are surfaced from the relevant project tab (Product, Codebase, Tasks) via flow buttons. The session is implicit; clicking a flow button switches to the chat.

## Task lifecycle

1. **Create** — `+ Add task` opens the spec session with `[Creating a new task]`. Agent asks 1–3 scoping questions, then writes `TASK-NNN/`.
2. **Refine** — Walk the task's `questions.md` one item at a time.
3. **Gate** — Agent asks before starting subtasks.
4. **Execute** — Code-mode sessions implement individual subtasks. Spec mode keeps `subtasks.md` accurate.
5. **Fold** — When complete, agent proposes specific edits to product/ and/or codebase/, plus Decisions entries.
6. **Remove** — User clicks **Mark complete** on the task card; folder is deleted.

## Ask one at a time

The agent's reply contains **at most one question**. Everything else lives in `questions.md`.

## The system prompt

When `mode: "spec"` is sent, the sidecar configures the SDK with `systemPrompt: { type: "preset", preset: "claude_code", append: <our prompt> }`. The verbatim prompt lives in [`sidecar/src/specPrompt.ts`](../sidecar/src/specPrompt.ts).

## Tool strategy

Spec mode runs with Read, Write, Edit, Glob, Grep, LS. **No Bash.**

## UI

Implementation in progress (Phase B + C of the new-structure rewrite):

- Tabs become **`[Product] [Codebase] [Tasks]`** — three project-level views, each backed by its corresponding folder.
- Each tab has flow buttons in addition to its read-only browsing UI.
- The single project session is implicit; flow buttons activate it.

## What v0/v1 deliberately doesn't do

- No path-based tool restrictions (the prompt is the guardrail).
- No file watcher — refresh on each turn.
- No agent-driven task creation/removal — humans hold the trigger.
- No spec validation or schema enforcement (markdown is the contract).
- No automatic detection of "task is done" — agent proposes; human approves.
