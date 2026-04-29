/**
 * Outset — child-process invocation harness
 *
 * Spawns spike.ts the way a Tauri sidecar would: as a Node child process with
 * no controlling TTY, piped stdio, and a clean environment. If streaming still
 * works under these conditions we know the SDK doesn't secretly require a TTY.
 *
 * Run with: `npm run spike:child`
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function log(line: string): void {
  process.stdout.write(`[parent] ${line}\n`);
}

async function main(): Promise<void> {
  log(`spawning spike as child process (no TTY, piped stdio)`);

  const child = spawn(
    process.execPath, // current node binary
    ["--import", "tsx", resolve(ROOT, "src/spike.ts")],
    {
      cwd: ROOT,
      // Inherit env so subscription auth still works, but explicitly drop any
      // ANTHROPIC_API_KEY to force the subscription path.
      env: { ...process.env, ANTHROPIC_API_KEY: undefined as unknown as string },
      // Pipes — no TTY, no terminal. This is what a Tauri sidecar gets.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let firstStdoutAt: number | null = null;
  const startedAt = Date.now();

  child.stdout.on("data", (chunk: Buffer) => {
    if (firstStdoutAt === null) {
      firstStdoutAt = Date.now() - startedAt;
      log(`first stdout chunk after ${firstStdoutAt}ms — streaming works`);
    }
    process.stdout.write(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const exitCode: number = await new Promise((res) => {
    child.on("exit", (code) => res(code ?? 1));
  });

  log(`child exited with code ${exitCode}`);
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  log(`UNCAUGHT: ${(err as Error).message}`);
  process.exitCode = 1;
});
