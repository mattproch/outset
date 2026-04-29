/**
 * Chat-item model used by the App.
 *
 * The Tauri host streams sidecar events to us as raw NDJSON strings on the
 * `sidecar-event` Tauri event. We parse them into one of two outer shapes
 * (`SidecarOutbound`) and then flatten Claude's `SDKMessage` events into a
 * sequence of `ChatItem`s for display.
 */

/**
 * Outer wrapper produced by sidecar/src/index.ts. Stable across SDK upgrades.
 * Each shape matches the sidecar's emitted JSON 1:1 (no nested payload).
 */
export type SidecarOutbound =
  | { kind: "ready" }
  | { kind: "sdk"; event: SdkEvent }
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

/** Convenience alias for the permission_request variant. */
export type PermissionRequestPayload = Extract<
  SidecarOutbound,
  { kind: "permission_request" }
>;

/**
 * A loose, structural model of an SDK message. We don't pull the SDK's full
 * `.d.ts` into the frontend; this captures just the fields we read.
 */
export type SdkEvent = {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: {
    role?: "assistant" | "user";
    content?: SdkContentBlock[];
  };
  // result fields
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  // assistant error code, e.g. "authentication_failed"
  error?: string;
  // catch-all so we can JSON.stringify unknown fields when debugging
  [key: string]: unknown;
};

export type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string; text?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }
  | { type: string; [key: string]: unknown };

export type ChatItem =
  | { kind: "user"; text: string; id: string }
  | { kind: "assistant_text"; text: string; id: string }
  | { kind: "thinking"; text: string; id: string }
  | { kind: "tool_use"; name: string; input: unknown; toolUseId: string; id: string }
  | {
      kind: "tool_result";
      toolUseId: string;
      text: string;
      isError: boolean;
      id: string;
    }
  | { kind: "system"; subtype: string; details?: string; id: string }
  | {
      kind: "result";
      subtype: string;
      numTurns?: number;
      costUsd?: number;
      durationMs?: number;
      id: string;
    }
  | { kind: "error"; message: string; id: string };
