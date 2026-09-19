/**
 * CLI path/guidance resolution (H) — the cross-platform data root.
 *
 * The CLI never hard-codes `/var/lib` or a checkout path: the data root comes
 * from `celesteaHome()` (W880: `$CELESTEA_HOME` -> XDG -> `~/.celestea` ->
 * `%USERPROFILE%\.celestea`), and every file under it is derived from there.
 */

import { celesteaHome } from "@celestea/core";
import { join } from "node:path";

export interface CliPaths {
  home: string;
  workspacesFile: string;
  providersFile: string;
  promptsFile: string;
}

/** Every path the studio reads, rooted at the cross-platform data home. */
export function cliPaths(env: NodeJS.ProcessEnv = process.env, home: string = celesteaHome({ env })): CliPaths {
  return {
    home,
    workspacesFile: join(home, "workspaces.json"),
    providersFile: join(home, "providers.json"),
    promptsFile: join(home, "prompts.json"),
  };
}

/**
 * The first-run guidance lines. `hasApiKey` is the secret-free fact the engine
 * view already computed; when it is false the operator gets an actionable
 * message instead of a silent failure at the first turn.
 */
export function firstRunGuidance(paths: CliPaths, hasApiKey: boolean): string[] {
  if (hasApiKey) return [];
  return [
    "no model API key is configured — the UI will start, but a turn cannot run yet.",
    `  1. create ${paths.providersFile} (mode 0600) with a provider row, or`,
    "  2. export CELESTEA_API_KEY=<your key> (and optionally CELESTEA_BASE_URL / CELESTEA_MODEL).",
    "  See GET /api/providers for the expected shape; the key is never logged.",
  ];
}
