/**
 * W882 — the two-layer source model for Celestea artifacts.
 *
 * The user decision (W882, after the W879 industry survey) is B: ONE writable
 * global container plus an OPTIONAL, hand-maintained, READ-ONLY project source.
 * Claude Code ships the same two layers (project `.claude/` + user `~/.claude/`),
 * Cursor does it with `.cursor/skills/` + `~/.cursor/skills/`. The rules are:
 *
 *   1. PROJECT layer  = `<ws>/.celestea`         — committed with the repo, shared
 *      by the team, maintained BY HAND. Celestea NEVER writes here.
 *   2. GLOBAL layer   = `<home>/workspaces/<ws>` — the ONE place Celestea writes
 *      (sessions / archive / trash / prompts / run-code, see `celestea-home.ts`).
 *   3. `readLayers()` returns `[project, global]`: the array order IS the priority
 *      order, so the project layer WINS on a name collision.
 *
 * `<ws>/.celestea/sessions/` is the W877 transitional session layout. It stays
 * readable (see `session-id.ts` / `sessions.ts`), but the write side is the
 * global container only. These functions are PURE: they never touch the disk, so
 * the whole layering is unit-testable without a filesystem.
 */

import { posix, win32 } from "node:path";

import { workspaceHome, type CelesteaHomeInput } from "./celestea-home.js";

/** Folder that marks the project-level source root: `<ws>/.celestea` (read-only). */
export const PROJECT_SOURCE_DIR = ".celestea";
/** Sub-folder holding one directory per skill (both layers use the same shape). */
export const SKILLS_SUBDIR = "skills";
/** The single entry file of a skill directory. */
export const SKILL_FILE_NAME = "SKILL.md";

/** Which layer a source belongs to. `project` beats `global`. */
export type SourceName = "project" | "global";

/** One read layer: a priority-tagged root. */
export interface SourceLayer {
  readonly source: SourceName;
  readonly root: string;
}

/** The path implementation of a platform (deterministic across hosts in tests). */
function pathApi(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * `<ws>/.celestea` — the project-level source root.
 *
 * READ-ONLY by contract: no Celestea code path may create or write under it. The
 * user maintains it by hand and commits it with the repository.
 */
export function projectSourceRoot(wsPath: string, platform: string = process.platform): string {
  return pathApi(platform).join(wsPath, PROJECT_SOURCE_DIR);
}

/**
 * `<home>/workspaces/<workspace-folder>` — the global source root. This is the
 * SAME container `workspaceHome()` resolves; the alias exists so callers talk
 * about "layers" without depending on the `CELESTEA_HOME` layout details.
 */
export function globalSourceRoot(wsPath: string, input: CelesteaHomeInput = {}): string {
  return workspaceHome(wsPath, input);
}

/**
 * The read layers of a workspace, HIGHEST PRIORITY FIRST: `[project, global]`.
 * A consumer that walks the array and keeps the first hit therefore lets the
 * project layer override the global one — reversing the array is a bug.
 */
export function readLayers(wsPath: string, input: CelesteaHomeInput = {}): SourceLayer[] {
  const platform = input.platform ?? process.platform;
  return [
    { source: "project", root: projectSourceRoot(wsPath, platform) },
    { source: "global", root: globalSourceRoot(wsPath, input) },
  ];
}
