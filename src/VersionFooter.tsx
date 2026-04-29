import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Displays the running app version. Read at runtime from
 * `tauri.conf.json` via the app plugin so we can't drift from the
 * version baked into the binary itself — bumping `package.json` alone
 * wouldn't reflect here, only `tauri.conf.json` does.
 *
 * Used at the bottom of the dashboard. Renders nothing during the
 * brief moment before the version resolves to keep the footer from
 * flashing.
 */
export function VersionFooter(): ReactElement | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // Plugin error (extremely rare): just don't display anything.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!version) return null;
  return (
    <div className="px-2 py-1 text-center text-[11px] tracking-wide text-zinc-600">
      Outset v{version}
    </div>
  );
}
