import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Auto-update affordance. On mount we ask the updater plugin whether a
 * newer version is available at the configured endpoint
 * (plugins.updater.endpoints in tauri.conf.json) and surface it as a
 * non-blocking banner in the bottom-right corner. The user clicks
 * "Install" to download + apply, then the app relaunches.
 *
 * In dev (`yarn tauri dev`) the updater is usually a no-op because the
 * dev binary version matches the manifest's published version — the
 * banner just won't show.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "installed" }
  | { kind: "error"; message: string };

export function UpdateBanner(): ReactElement | null {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (!cancelled && update) {
          setPhase({ kind: "available", update });
        }
      } catch (e) {
        // Silent fail: a missing endpoint or signature mismatch
        // shouldn't block the app. Surface as console for diagnosis.
        // eslint-disable-next-line no-console
        console.warn("update check failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function install(update: Update): Promise<void> {
    setPhase({ kind: "downloading", downloaded: 0, total: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setPhase({ kind: "downloading", downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setPhase({ kind: "downloading", downloaded, total });
        } else if (event.event === "Finished") {
          setPhase({ kind: "installed" });
        }
      });
      // Give the user a beat to see "Installed", then relaunch.
      setTimeout(() => {
        void relaunch();
      }, 500);
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  if (phase.kind === "idle" || dismissed) return null;

  const baseCls =
    "fixed bottom-4 right-4 z-50 w-[300px] rounded-lg bg-[rgb(42_42_46)] px-4 py-3 text-[13px] text-zinc-100 shadow-xl ring-1 ring-zinc-700/60";

  if (phase.kind === "available") {
    const update = phase.update;
    return (
      <div className={baseCls}>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-semibold">Update available</span>
          <button
            onClick={() => setDismissed(true)}
            className="text-zinc-500 hover:text-zinc-200"
            title="Dismiss"
          >
            ×
          </button>
        </div>
        <div className="mb-3 text-[12px] text-zinc-400">
          Outset {update.version} is ready to install.
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setDismissed(true)}
            className="rounded-md px-2.5 py-1 text-[12px] text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            Later
          </button>
          <button
            onClick={() => void install(update)}
            className="rounded-md bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-900 hover:bg-white"
          >
            Install
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "downloading") {
    const pct = phase.total
      ? Math.min(100, Math.round((phase.downloaded / phase.total) * 100))
      : null;
    return (
      <div className={baseCls}>
        <div className="mb-1 font-semibold">Downloading update…</div>
        <div className="mb-2 text-[12px] text-zinc-400">
          {pct != null ? `${pct}%` : `${(phase.downloaded / 1024 / 1024).toFixed(1)} MB`}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full bg-emerald-500 transition-[width] duration-150"
            style={{ width: pct != null ? `${pct}%` : "30%" }}
          />
        </div>
      </div>
    );
  }

  if (phase.kind === "installed") {
    return (
      <div className={baseCls}>
        <div className="font-semibold text-emerald-300">Update installed</div>
        <div className="text-[12px] text-zinc-400">Relaunching…</div>
      </div>
    );
  }

  // error
  return (
    <div className={baseCls}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-semibold text-red-300">Update failed</span>
        <button
          onClick={() => setDismissed(true)}
          className="text-zinc-500 hover:text-zinc-200"
          title="Dismiss"
        >
          ×
        </button>
      </div>
      <div className="text-[12px] text-zinc-400">{phase.message}</div>
    </div>
  );
}
