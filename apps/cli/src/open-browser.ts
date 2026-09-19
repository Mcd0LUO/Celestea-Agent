/**
 * Open the operator's browser at `url` (H) — the cross-platform seam.
 *
 * Reuses the W885 platform primitives (`isWindows`, `whichInPath`) instead of
 * hard-coding a per-OS branch, and takes `platform` / `env` / `spawn` as
 * arguments so the Windows path is unit-testable on this Linux host (the host
 * is never asked).
 *
 * Command per platform:
 *   win32  -> `cmd /d /s /c start "" <url>`  (start is a cmd builtin; the empty
 *             title argument keeps a quoted URL from being read as a title)
 *   darwin -> `open <url>`
 *   other  -> `xdg-open <url>` (the freedesktop opener; absent on a headless
 *             box, which is reported, never a crash)
 */

import { isWindows, whichInPath } from "@celestea/tools";

export interface OpenBrowserInput {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  /** Injected launcher (tests capture argv; default: `node:child_process`). */
  spawn?: (command: string, args: readonly string[], detached: boolean) => void;
  /** Injected existence check for the opener binary (tests). */
  which?: (bin: string) => string | null;
}

export type OpenBrowserResult =
  | { opened: true; command: string; args: readonly string[] }
  | { opened: false; reason: string };

/** The opener command + argv for `url` on `platform` (pure). */
export function openerFor(url: string, platform: string): { command: string; args: readonly string[] } {
  if (isWindows(platform)) return { command: "cmd", args: ["/d", "/s", "/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Open `url`. Never throws: a missing opener (headless Linux, minimal
 * container) returns `{opened:false}` so the caller can print the URL instead.
 */
export function openBrowser(url: string, input: OpenBrowserInput = {}): OpenBrowserResult {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const { command, args } = openerFor(url, platform);
  const which = input.which ?? ((bin: string) => whichInPath(bin, platform, env));
  if (which(command) === null) return { opened: false, reason: `${command} not found on PATH` };
  const launch =
    input.spawn ??
    ((cmd: string, argv: readonly string[], detached: boolean) => {
      // Lazy import keeps this module pure for the unit tests that inject spawn.
      void import("node:child_process").then(({ spawn }) => {
        const child = spawn(cmd, [...argv], { detached, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      });
    });
  launch(command, args, true);
  return { opened: true, command, args };
}
