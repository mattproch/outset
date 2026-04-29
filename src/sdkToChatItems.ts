import type { ChatItem, SdkContentBlock, SdkEvent } from "./types";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `i${counter.toString(36)}`;
}

/**
 * Convert one SDK event into zero or more chat items for display.
 *
 * Hidden by default (return []):
 *   - hook_started / hook_response system events (user-installed hooks)
 *   - stream_event (text deltas — we render the assembled assistant message instead)
 *
 * Visible:
 *   - assistant content blocks (text, thinking, tool_use)
 *   - user content blocks (tool_result)
 *   - result message (terminal summary)
 *   - error fields on assistant messages
 */
export function sdkEventToChatItems(ev: SdkEvent): ChatItem[] {
  switch (ev.type) {
    case "system": {
      // System events are noisy in the chat. The SDK emits init/hook_started/
      // hook_response on every sidecar spawn, but the actual session is
      // continuous (we resume by id). So suppress all system events here —
      // model info can live elsewhere in the UI when we want to surface it.
      return [];
    }

    case "assistant": {
      if (ev.error) {
        return [
          {
            kind: "error",
            message: `assistant error: ${ev.error}`,
            id: nextId(),
          },
        ];
      }
      const blocks = (ev.message?.content ?? []) as SdkContentBlock[];
      return blocks.flatMap((b) => blockToItems(b, "assistant"));
    }

    case "user": {
      const blocks = (ev.message?.content ?? []) as SdkContentBlock[];
      return blocks.flatMap((b) => blockToItems(b, "user"));
    }

    case "result": {
      return [
        {
          kind: "result",
          subtype: ev.subtype ?? "?",
          numTurns: ev.num_turns,
          costUsd: ev.total_cost_usd,
          durationMs: ev.duration_ms,
          id: nextId(),
        },
      ];
    }

    case "stream_event":
    case "rate_limit_event":
    default:
      return [];
  }
}

function blockToItems(
  b: SdkContentBlock,
  source: "assistant" | "user",
): ChatItem[] {
  switch (b.type) {
    case "text":
      if (typeof (b as { text?: unknown }).text !== "string") return [];
      // Text blocks within a user event are the SDK echoing the user's
      // prompt — render as a user-kind item so it picks up the user
      // bubble styling. (The host already adds the same item locally on
      // send; appendItem dedupes consecutive identical user items.)
      return [
        {
          kind: source === "user" ? "user" : "assistant_text",
          text: (b as { text: string }).text,
          id: nextId(),
        },
      ];
    case "thinking": {
      const t = (b as { thinking?: string; text?: string }).thinking
        ?? (b as { text?: string }).text
        ?? "";
      if (!t) return [];
      return [{ kind: "thinking", text: t, id: nextId() }];
    }
    case "tool_use":
      return [
        {
          kind: "tool_use",
          name: (b as { name: string }).name,
          input: (b as { input: unknown }).input,
          toolUseId: (b as { id: string }).id,
          id: nextId(),
        },
      ];
    case "tool_result": {
      const c = (b as {
        content?: string | Array<{ type: string; text?: string }>;
      }).content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((p) => p.text ?? "").join("")
            : "";
      return [
        {
          kind: "tool_result",
          toolUseId: (b as { tool_use_id: string }).tool_use_id,
          text,
          isError: Boolean((b as { is_error?: boolean }).is_error),
          id: nextId(),
        },
      ];
    }
    default:
      return [];
  }
}
