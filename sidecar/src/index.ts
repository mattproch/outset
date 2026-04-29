/**
 * Outset — Node sidecar.
 *
 * Spawned by the Tauri host with stdio: ["pipe", "pipe", "pipe"]. Stdin stays
 * open for the lifetime of the sidecar so the host can send permission
 * responses back during a query.
 *
 * Wire format
 * -----------
 * stdin (newline-delimited JSON, multiple messages over the lifetime):
 *
 *   First line — the start command:
 *     { "kind": "send",
 *       "cwd": "/abs/path/to/project",
 *       "prompt": "user's message",
 *       "resume": "session-uuid" | null,
 *       "mode": "free" | "spec",
 *       "permission_mode": "ask" | "acceptEdits" | "bypassAll" }
 *
 *     OR { "kind": "load_history",
 *          "cwd": "/abs/path/to/project",
 *          "sdk_session_id": "session-uuid" }
 *
 *   Subsequent lines — responses to permission_request events:
 *     { "kind": "permission_response",
 *       "request_id": "uuid",
 *       "decision": "allow" | "deny",
 *       "message": "optional reason for deny" }
 *
 * stdout (newline-delimited JSON, one event per line):
 *   { "kind": "ready" }                               // sidecar booted
 *   { "kind": "sdk", "event": <SDKMessage> }          // an SDK event verbatim
 *   { "kind": "permission_request",                   // canUseTool fired
 *     "request_id": "uuid",
 *     "tool": "Bash",
 *     "input": {...},
 *     "title": "Run command",
 *     "description": "...",
 *     "display_name": "Run",
 *     "blocked_path": "/path",
 *     "decision_reason": "..." }
 *   { "kind": "fatal", "message": "...", "stack": "..." }
 *   { "kind": "done", "ok": true|false }
 */

import {
  query,
  getSessionMessages,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type PermissionResult,
  type PreToolUseHookInput,
  type SDKMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

import { SPEC_MODE_PROMPT } from "./specPrompt.js";

// ---------- types ----------

type Mode = "free" | "spec";
type PermissionMode = "ask" | "acceptEdits" | "bypassAll";

type SendCommand = {
  kind: "send";
  cwd: string;
  prompt: string;
  resume: string | null;
  mode: Mode;
  permission_mode: PermissionMode;
};

type LoadHistoryCommand = {
  kind: "load_history";
  cwd: string;
  sdk_session_id: string;
};

type PermissionResponse = {
  kind: "permission_response";
  request_id: string;
  decision: "allow" | "deny";
  message?: string;
};

type Inbound = SendCommand | LoadHistoryCommand | PermissionResponse;

type Outbound =
  | { kind: "ready" }
  | { kind: "sdk"; event: SDKMessage }
  | {
      kind: "permission_request";
      request_id: string;
      tool: string;
      input: unknown;
      title?: string;
      description?: string;
      display_name?: string;
      blocked_path?: string;
      decision_reason?: string;
    }
  | { kind: "fatal"; message: string; stack?: string }
  | { kind: "done"; ok: boolean };

// ---------- io helpers ----------

function emit(msg: Outbound): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function logErr(line: string): void {
  process.stderr.write(`[sidecar] ${line}\n`);
}

// ---------- pending permission requests ----------

type PendingEntry = {
  resolve: (result: PermissionResult) => void;
  /** The original input passed to canUseTool — round-tripped through the
   * "allow" branch of PermissionResult so the SDK keeps the same args. */
  input: unknown;
};

const pendingPermissions = new Map<string, PendingEntry>();

function resolvePending(
  requestId: string,
  decision: "allow" | "deny",
  message?: string,
): boolean {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false;
  pendingPermissions.delete(requestId);
  if (decision === "allow") {
    entry.resolve({
      behavior: "allow",
      updatedInput: (entry.input ?? {}) as Record<string, unknown>,
    });
  } else {
    entry.resolve({
      behavior: "deny",
      message: message ?? "Denied by user",
    });
  }
  return true;
}

function rejectAllPending(reason: string): void {
  for (const [, entry] of pendingPermissions) {
    entry.resolve({ behavior: "deny", message: reason, interrupt: true });
  }
  pendingPermissions.clear();
}

// ---------- cwd-enforcement hook ----------

/**
 * PreToolUse hook with two layered guardrails:
 *
 *  1. CWD scope. Block any path outside the session's working directory.
 *     Without this, the model occasionally invents `/home/user/foo.txt`
 *     and the file lands in the wrong place.
 *
 *  2. .spec/ write fence. The planning-only app only ever wants the
 *     agent to WRITE inside `.spec/`. Reading source files anywhere in
 *     cwd is fine (and required during the fold step) — but Write,
 *     Edit, MultiEdit, NotebookEdit are denied outside `.spec/`.
 *
 * Both checks deny with a human-readable reason so the model can self-
 * correct on the next turn. We never rewrite the path; misinterpreting
 * intent is worse than asking for a retry.
 */
const PATH_FIELDS: readonly string[] = [
  "file_path",
  "path",
  "notebook_path",
];

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

const enforceCwdHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") {
    return {};
  }
  const pre = input as PreToolUseHookInput;
  const cwd = pre.cwd;
  if (!cwd) return {};
  const cwdResolved = path.resolve(cwd);
  const specDir = path.join(cwdResolved, ".spec");
  const isWrite = WRITE_TOOLS.has(pre.tool_name);

  const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const v = toolInput[field];
    if (typeof v !== "string" || v.length === 0) continue;
    const resolved = path.isAbsolute(v)
      ? path.resolve(v)
      : path.resolve(cwdResolved, v);

    // (1) Cwd scope — reject anything outside the project root.
    if (
      resolved !== cwdResolved &&
      !resolved.startsWith(cwdResolved + path.sep)
    ) {
      const reason =
        `The path "${v}" is outside the project working directory ` +
        `(${cwd}). Use a path relative to the project root (e.g. ` +
        `\`foo/bar.txt\`) or an absolute path inside ${cwd}. Do NOT use ` +
        `placeholder paths like \`/home/user/...\`.`;
      return {
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      } satisfies HookJSONOutput;
    }

    // (2) Write fence — write tools must target .spec/.
    if (
      isWrite &&
      resolved !== specDir &&
      !resolved.startsWith(specDir + path.sep)
    ) {
      const reason =
        `Outset is a spec maintainer; writes are restricted to .spec/. ` +
        `The path "${v}" is outside .spec/. You can READ source files ` +
        `anywhere in the project, but only edit files under \`.spec/\`. ` +
        `If the user implemented something outside .spec/, that's their ` +
        `editor's job — your job is to fold the change into the spec.`;
      return {
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      } satisfies HookJSONOutput;
    }
  }
  return {};
};

// ---------- canUseTool bridge ----------

const canUseTool: CanUseTool = (toolName, input, options) => {
  const requestId = randomUUID();
  emit({
    kind: "permission_request",
    request_id: requestId,
    tool: toolName,
    input,
    title: options.title,
    description: options.description,
    display_name: options.displayName,
    blocked_path: options.blockedPath,
    decision_reason: options.decisionReason,
  });
  return new Promise<PermissionResult>((resolve) => {
    pendingPermissions.set(requestId, { resolve, input });
    options.signal.addEventListener(
      "abort",
      () => {
        if (pendingPermissions.has(requestId)) {
          pendingPermissions.delete(requestId);
          resolve({
            behavior: "deny",
            message: "Aborted",
            interrupt: true,
          });
        }
      },
      { once: true },
    );
  });
};

// ---------- query runners ----------

async function runSend(cmd: SendCommand): Promise<boolean> {
  logErr(
    `send cwd=${cmd.cwd} resume=${cmd.resume ?? "<none>"} mode=${cmd.mode} perm=${cmd.permission_mode}`,
  );

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "outset/0.0.1";

  // Both modes get the full Claude Code tool preset. Spec mode is
  // distinguished only by an appended system prompt that gives the agent
  // the spec-maintainer persona and activity awareness — the agent still
  // needs Bash, code-edit access, etc. to execute tasks (no more
  // hand-off to a separate code session for implementation).
  const modeOptions = {
    systemPrompt:
      cmd.mode === "spec"
        ? {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: SPEC_MODE_PROMPT,
          }
        : {
            type: "preset" as const,
            preset: "claude_code" as const,
          },
    tools: { type: "preset" as const, preset: "claude_code" as const },
    disallowedTools: ["AskUserQuestion"],
  };

  const sdkPermissionMode: "default" | "acceptEdits" | "bypassPermissions" =
    cmd.permission_mode === "bypassAll"
      ? "bypassPermissions"
      : cmd.permission_mode === "ask"
        ? "default"
        : "acceptEdits";

  const q = query({
    prompt: cmd.prompt,
    options: {
      cwd: cmd.cwd,
      ...modeOptions,
      permissionMode: sdkPermissionMode,
      // Routes through pendingPermissions + the host's modal. The SDK only
      // calls this for tools that need permission given the active mode:
      //   bypassPermissions → never called
      //   acceptEdits       → called for non-edit tools (Bash, etc.)
      //   default ("ask")   → called for every permission-needing tool
      canUseTool,
      // Independent of permissionMode, the PreToolUse hook denies any tool
      // call referencing an absolute path outside the session cwd. Stops
      // the "/home/user/foo.txt" hallucination at the source.
      hooks: {
        PreToolUse: [{ hooks: [enforceCwdHook] }],
      },
      ...(cmd.resume ? { resume: cmd.resume } : {}),
      persistSession: true,
      env,
    },
  });

  for await (const event of q) {
    emit({ kind: "sdk", event });
  }
  return true;
}

async function runLoadHistory(cmd: LoadHistoryCommand): Promise<boolean> {
  logErr(`load_history cwd=${cmd.cwd} sdk_session_id=${cmd.sdk_session_id}`);
  const messages: SessionMessage[] = await getSessionMessages(
    cmd.sdk_session_id,
    { dir: cmd.cwd },
  );
  for (const m of messages) {
    const ev = {
      type: m.type,
      uuid: m.uuid,
      session_id: m.session_id,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id,
    } as unknown as SDKMessage;
    emit({ kind: "sdk", event: ev });
  }
  return true;
}

// ---------- main loop ----------

/**
 * Stdin stays open across the lifetime of the sidecar. The first valid
 * `send` or `load_history` message kicks off the query in the background.
 * After that, the stdin reader keeps consuming `permission_response` lines
 * until the sidecar exits (which happens when the query completes).
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  let started = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Partial<Inbound> & { kind?: string };
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      logErr(`bad json on stdin: ${(err as Error).message}`);
      continue;
    }

    if (parsed.kind === "permission_response") {
      const p = parsed as PermissionResponse;
      const ok = resolvePending(p.request_id, p.decision, p.message);
      if (!ok) {
        logErr(`permission_response for unknown request_id=${p.request_id}`);
      }
      continue;
    }

    if (started) {
      logErr(`unexpected message after start: ${trimmed.slice(0, 80)}`);
      continue;
    }

    if (parsed.kind === "send" || parsed.kind === "load_history") {
      started = true;
      const cmd = validate(parsed);
      if (!cmd) {
        emit({
          kind: "fatal",
          message: `invalid ${parsed.kind} command`,
        });
        emit({ kind: "done", ok: false });
        process.exit(1);
      }
      emit({ kind: "ready" });
      // Run in background so the stdin loop keeps consuming responses.
      runStartCommand(cmd).catch((err: unknown) => {
        emit({
          kind: "fatal",
          message: (err as Error).message,
          stack: (err as Error).stack,
        });
        emit({ kind: "done", ok: false });
        process.exit(1);
      });
      continue;
    }

    logErr(`unknown stdin kind: ${String(parsed.kind)}`);
  }

  // stdin closed (parent killed us). Reject any outstanding permissions.
  rejectAllPending("Sidecar shutting down");
}

async function runStartCommand(
  cmd: SendCommand | LoadHistoryCommand,
): Promise<void> {
  let ok = true;
  try {
    if (cmd.kind === "send") {
      ok = await runSend(cmd);
    } else {
      ok = await runLoadHistory(cmd);
    }
  } catch (err) {
    ok = false;
    emit({
      kind: "fatal",
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
  rejectAllPending("Session done");
  emit({ kind: "done", ok });
  process.exit(ok ? 0 : 1);
}

function validate(
  parsed: Partial<Inbound> & { kind?: string },
): SendCommand | LoadHistoryCommand | null {
  if (parsed.kind === "send") {
    const p = parsed as Partial<SendCommand>;
    if (typeof p.cwd !== "string" || typeof p.prompt !== "string") return null;
    const pm: PermissionMode =
      p.permission_mode === "ask"
        ? "ask"
        : p.permission_mode === "bypassAll"
          ? "bypassAll"
          : "acceptEdits";
    return {
      kind: "send",
      cwd: p.cwd,
      prompt: p.prompt,
      resume: p.resume ?? null,
      mode: p.mode === "spec" ? "spec" : "free",
      permission_mode: pm,
    };
  }
  if (parsed.kind === "load_history") {
    const p = parsed as Partial<LoadHistoryCommand>;
    if (typeof p.cwd !== "string" || typeof p.sdk_session_id !== "string")
      return null;
    return {
      kind: "load_history",
      cwd: p.cwd,
      sdk_session_id: p.sdk_session_id,
    };
  }
  return null;
}

main().catch((err: unknown) => {
  emit({
    kind: "fatal",
    message: `uncaught: ${(err as Error).message}`,
    stack: (err as Error).stack,
  });
  emit({ kind: "done", ok: false });
  process.exit(1);
});
