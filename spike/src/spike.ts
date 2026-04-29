/**
 * Outset — Week-1 spike
 *
 * Goal: prove that we can drive Claude Code from inside our own process via the
 * Agent SDK using the user's existing subscription auth (no API key), and that
 * the streaming events are rich enough to render a chat UI later.
 *
 * What this script does:
 *   1. Reports the auth state up-front (which env vars are set, where the
 *      Claude config dir is) so we can see exactly what auth path is taken.
 *   2. Creates a sandbox folder so the agent can't touch anything else.
 *   3. Calls `query()` with a small prompt that exercises read + write tools.
 *   4. Streams every SDK message to stdout as a one-line summary AND appends
 *      the full event to a JSONL file for later shape analysis.
 *
 * Run directly: `npm run spike`
 * Run as a child process: `npm run spike:child` (see parent.ts)
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const SANDBOX = join(ROOT, "sandbox");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const EVENT_LOG = join(SANDBOX, `events-${RUN_ID}.jsonl`);

function log(line: string): void {
  process.stdout.write(`[spike] ${line}\n`);
}

function recordEvent(event: SDKMessage): void {
  appendFileSync(EVENT_LOG, JSON.stringify(event) + "\n", "utf8");
}

/**
 * One-line human-readable summary of an SDK message — for the live console.
 * The full event still goes to the JSONL log for shape analysis.
 */
function summarize(event: SDKMessage): string {
  const t = event.type;
  switch (t) {
    case "system":
      return `system    subtype=${(event as { subtype?: string }).subtype ?? "?"}`;
    case "assistant": {
      const blocks = (event as { message?: { content?: unknown[] } }).message?.content ?? [];
      const kinds = blocks
        .map((b) => (b as { type?: string }).type ?? "?")
        .join(",");
      return `assistant blocks=[${kinds}]`;
    }
    case "user": {
      const blocks = (event as { message?: { content?: unknown[] } }).message?.content ?? [];
      const kinds = blocks
        .map((b) => (b as { type?: string }).type ?? "?")
        .join(",");
      return `user      blocks=[${kinds}]`;
    }
    case "result": {
      const subtype = (event as { subtype?: string }).subtype ?? "?";
      const turns = (event as { num_turns?: number }).num_turns;
      const cost = (event as { total_cost_usd?: number }).total_cost_usd;
      return `result    subtype=${subtype} turns=${turns ?? "?"} cost_usd=${cost ?? "?"}`;
    }
    case "stream_event":
      return `stream    delta`;
    default:
      return `${t}`;
  }
}

function reportAuthState(): void {
  const envFlags = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "<set>" : "<unset>",
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK ?? "<unset>",
    CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX ?? "<unset>",
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "<unset>",
  };
  log(`auth env: ${JSON.stringify(envFlags)}`);

  const defaultConfigDir = join(homedir(), ".claude");
  log(`default config dir exists: ${existsSync(defaultConfigDir)} (${defaultConfigDir})`);
}

async function main(): Promise<void> {
  log(`run id: ${RUN_ID}`);
  log(`sandbox: ${SANDBOX}`);
  reportAuthState();

  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(EVENT_LOG, "", "utf8");
  log(`event log: ${EVENT_LOG}`);

  const prompt = [
    "You are running inside a small validation harness for a tool called Outset.",
    "Please do exactly two things, in order, and no more:",
    "  1) Create a file called `hello.md` in the current directory with a single",
    "     short paragraph (3 sentences max) introducing yourself and confirming",
    "     you can write files.",
    "  2) Then read the file back to verify it was written correctly, and reply",
    "     with a one-sentence confirmation.",
    "Do not run any shell commands. Do not create any other files.",
  ].join("\n");

  log(`prompt: ${prompt.slice(0, 80).replace(/\n/g, " ")}...`);

  const startedAt = Date.now();
  let messageCount = 0;
  let resultMessage: SDKMessage | undefined;

  try {
    const q = query({
      prompt,
      options: {
        cwd: SANDBOX,
        // Restrict the toolbelt to what the prompt actually needs. This also
        // proves the SDK's tool-restriction surface works.
        tools: ["Read", "Write", "Edit"],
        // For an automated spike we don't want a permission prompt loop.
        // In the real app we'll wire `canUseTool` to a UI dialog instead.
        permissionMode: "bypassPermissions",
        // Bound the run defensively so a misbehaving session can't loop forever.
        // Any well-behaved completion of the prompt above will use far fewer.
        maxTurns: 5,
        // Don't pollute ~/.claude/projects/ with throwaway spike sessions.
        persistSession: false,
        // Identify ourselves in the User-Agent for telemetry hygiene.
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: "outset-spike/0.0.1",
        },
      },
    });

    for await (const event of q) {
      messageCount += 1;
      recordEvent(event);
      log(summarize(event));
      if (event.type === "result") {
        resultMessage = event;
      }
    }
  } catch (err) {
    log(`ERROR: ${(err as Error).message}`);
    log(`stack: ${(err as Error).stack ?? "<none>"}`);
    process.exitCode = 1;
    return;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  log(`done. messages=${messageCount} elapsed=${elapsed}s`);

  // Surface the file the agent should have written so we can eyeball it.
  const helloPath = join(SANDBOX, "hello.md");
  if (existsSync(helloPath)) {
    log(`hello.md exists at ${helloPath}`);
  } else {
    log(`hello.md MISSING — the agent didn't actually write the file`);
    process.exitCode = 1;
  }

  if (!resultMessage) {
    log(`no terminal 'result' message received — something went wrong`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log(`UNCAUGHT: ${(err as Error).message}`);
  process.exitCode = 1;
});
