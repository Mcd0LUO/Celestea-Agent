/**
 * CELESTEA_HOME — the cross-platform data root (W880).
 *
 * Every celestea artifact used to live inside the workspace: session dirs, the
 * archive / trash siblings, the workspace prompt registry and run_code's
 * transient programs. That pollutes the user's repository (a `git add -A` could
 * commit private conversations) and ignores the OS conventions. W880 moves ALL of
 * it into one data root, resolved with the order the established agent CLIs use
 * (Claude Code `~/.claude`, Codex `~/.codex`, Gemini CLI `~/.gemini`):
 *
 *   1. `$CELESTEA_HOME`                    — explicit override; production systemd
 *                                            pins `/var/lib/celestea-agent` (the FHS
 *                                            `/var/lib/<service>` location);
 *   2. `$XDG_DATA_HOME/celestea` (Linux)   — XDG Base Directory, the ask behind
 *                                            anthropics/claude-code#1455;
 *   3. `~/.celestea`                       — Linux/macOS default, the de-facto
 *                                            standard of the agent CLIs;
 *   4. `%USERPROFILE%\.celestea` (Windows) — Windows default.
 *
 * This module is PURE: it reads the injected `env` / `platform` / `homedir`
 * (defaulting to the process), never the filesystem, so the whole order is a
 * unit-testable function. The layout under the root is
 *
 *   <home>/workspaces/<workspace-folder>/{sessions,archive,trash,run-code}/
 *   <home>/workspaces/<workspace-folder>/prompts.json
 *
 * `<workspace-folder>` is the same key `workspaces.json` uses (the registered
 * path's basename; see `apps/studio/src/store/workspaces.ts`).
 */

import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

/** Env var: explicit data-root override (highest priority). */
export const CELESTEA_HOME_ENV = "CELESTEA_HOME";
/** Folder under `$XDG_DATA_HOME` on Linux. */
export const CELESTEA_DATA_DIR = "celestea";
/** Folder under the data root that holds every workspace's container. */
export const CELESTEA_WORKSPACES_DIR = "workspaces";
/** Live-session sub-container. */
export const CELESTEA_SESSIONS_DIR = "sessions";
/** Archived-session sub-container. */
export const CELESTEA_ARCHIVE_DIR = "archive";
/** Trashed-session sub-container. */
export const CELESTEA_TRASH_DIR = "trash";
/** run_code's transient program sub-container. */
export const CELESTEA_RUN_CODE_DIR = "run-code";
/** Workspace-scoped prompt registry file name. */
export const CELESTEA_PROMPTS_FILE = "prompts.json";

/** Everything `celesteaHome` may depend on, injectable for tests. */
export interface CelesteaHomeInput {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform | string;
  homedir?: string;
}

/** The path implementation of a platform (deterministic across hosts in tests). */
function pathApi(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** A non-blank, trimmed env value; `undefined` when unset or blank. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The folder name that keys a workspace (same rule as `workspaces.json`). */
export function workspaceFolderName(wsPath: string, platform: string = process.platform): string {
  const base = pathApi(platform).basename(wsPath);
  return base === "" || base === "/" ? wsPath : base;
}

/**
 * Resolve the celestea data root. First hit wins:
 * `$CELESTEA_HOME` -> `$XDG_DATA_HOME/celestea` (Linux) -> `~/.celestea`
 * (Linux/macOS) -> `%USERPROFILE%\.celestea` (Windows).
 */
export function celesteaHome(input: CelesteaHomeInput = {}): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const override = envValue(env, CELESTEA_HOME_ENV);
  if (override !== undefined) return override;
  if (platform === "win32") {
    const profile = envValue(env, "USERPROFILE");
    return win32.join(profile ?? input.homedir ?? osHomedir(), ".celestea");
  }
  if (platform === "linux") {
    const xdg = envValue(env, "XDG_DATA_HOME");
    if (xdg !== undefined) return posix.join(xdg, CELESTEA_DATA_DIR);
  }
  return posix.join(input.homedir ?? osHomedir(), ".celestea");
}

/** `<home>/workspaces/<workspace-folder>` — this workspace's container. */
export function workspaceHome(wsPath: string, input: CelesteaHomeInput = {}): string {
  const platform = input.platform ?? process.platform;
  return pathApi(platform).join(celesteaHome(input), CELESTEA_WORKSPACES_DIR, workspaceFolderName(wsPath, platform));
}

/** `<workspaceHome>/<sub>` — one of the fixed sub-containers. */
export function workspaceSubdir(wsPath: string, sub: string, input: CelesteaHomeInput = {}): string {
  const platform = input.platform ?? process.platform;
  return pathApi(platform).join(workspaceHome(wsPath, input), sub);
}

