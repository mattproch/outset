#!/usr/bin/env node
/**
 * Compile the sidecar to a standalone executable using `bun build --compile`.
 *
 * Output goes to `src-tauri/binaries/outset-sidecar-<rust-target-triple>` so
 * Tauri's `externalBin` mechanism can pick the right one per build target.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs               # uses host's Rust triple
 *   node scripts/build-sidecar.mjs --target=...  # explicit (used by CI)
 *
 * The host-triple branch keeps `yarn tauri dev` working without arguments;
 * the explicit branch is what the GitHub Actions matrix uses (each runner
 * targets only its own architecture, so no cross-compile is needed).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

// Parse --target=...; fall back to the host triple via `rustc -vV`.
const argTarget = process.argv
  .slice(2)
  .find((a) => a.startsWith("--target="))
  ?.slice("--target=".length);
let target = argTarget;
if (!target) {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (out.status !== 0) {
    console.error("Couldn't run `rustc -vV` to detect host target.");
    process.exit(1);
  }
  const m = /^host:\s*(\S+)/m.exec(out.stdout);
  if (!m) {
    console.error("Couldn't parse host target from rustc -vV.");
    process.exit(1);
  }
  target = m[1];
}

// bun's --target values for the Rust triples we care about.
const BUN_TARGET = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
};
const bunTarget = BUN_TARGET[target];
if (!bunTarget) {
  console.error(
    `Unsupported Rust target for sidecar compile: ${target}\n` +
      `Supported: ${Object.keys(BUN_TARGET).join(", ")}`,
  );
  process.exit(1);
}

const entry = join(repoRoot, "sidecar", "src", "index.ts");
const outDir = join(repoRoot, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `outset-sidecar-${target}`);

console.log(`Compiling sidecar → ${outFile}`);
const child = spawn(
  "bun",
  ["build", entry, "--compile", "--target", bunTarget, "--outfile", outFile],
  { stdio: "inherit", cwd: repoRoot },
);
child.on("error", (e) => {
  console.error(
    "Failed to launch `bun`. Install bun (https://bun.sh) and try again.\n" +
      String(e),
  );
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
