/**
 * W884 — `load_skill`: the on-demand half of skill progressive disclosure.
 *
 * W882 owns discovery + the frontmatter contract (`packages/core/src/skills.ts`)
 * and `skill-catalog.ts` owns the resident name+description listing. This file is
 * the tool the model calls when it decides a listed skill applies: it returns the
 * SKILL.md BODY ONLY (child resources are never inlined) plus the skill's
 * directory, so the model can read the files the body points at itself.
 *
 * The session workspace is CONSTRUCTOR-INJECTED, exactly like `ask_user_question`
 * gets its question service and `run_shell` gets its sandbox: the host resolves
 * it once from W768's `sessionWorkspaceOf` (the single source of truth) and this
 * tool never reads `process.cwd()` or guesses a path. A generation without a
 * workspace (the detached default that backs `GET /api/tools`) still REGISTERS
 * the tool so every face advertises the same 14 names; a call there fails with a
 * structured `no_workspace` error instead of silently returning nothing.
 *
 * Pure read: two readdir/readFile walks under the host-resolved layer roots. It
 * writes nothing, spawns nothing and reaches no network, so it stays usable under
 * the `read-only` permission baseline (which only denies `write_file`).
 */

import type { Tool, ToolSpec } from "@celestea/core";
import { loadSkillBody, readLayers, SKILL_NAME_PATTERN } from "@celestea/core";

import { stringArg } from "../args.js";
import { descParam } from "../desc.js";
import { contractFailure } from "../errors.js";

/** The model-facing behaviour description (mirrored by contracts/tools.json). */
export const LOAD_SKILL_DESCRIPTION =
  "Load one skill's full instructions (its SKILL.md BODY) into the conversation by name. The per-turn skill catalog lists the available names; call this before doing a task a skill covers. The result carries the skill's `body`, its `dir` (read anything the body references from there with read_file), and the `source` layer it won — a skill's child files (references/, scripts/) are NEVER inlined. An unknown name, a name that is not a lowercase `[a-z0-9-]` slug (path traversal included), or a SKILL.md whose frontmatter is invalid fails with a structured `load_skill: code=... msg=\"...\"` error naming the reason — never a silent empty result.";

/** Stable prefix of every structured `load_skill` error. */
export const LOAD_SKILL_ERROR_PREFIX = "load_skill";

export interface LoadSkillToolOptions {
  /**
   * The composing session's workspace root (W768 `sessionWorkspaceOf`), or null
   * for a generation that has no workspace. Never a process-cwd guess.
   */
  workspace: string | null;
  /** Environment the CELESTEA_HOME global layer resolves under. */
  env?: NodeJS.ProcessEnv;
}

export function loadSkillSpec(): ToolSpec {
  return {
    name: "load_skill",
    description: LOAD_SKILL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name exactly as listed in the skill catalog (lowercase letters, digits, hyphens).",
        },
        desc: descParam(),
      },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

/**
 * The stable error code of one `loadSkillBody` failure. The name shape is
 * re-checked here so `invalid_name` never depends on W882's prose; the two
 * remaining texts are frozen by `packages/core/src/skills.test.ts`.
 */
function failureCode(name: string, error: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) return "invalid_name";
  if (error.startsWith("unknown skill ")) return "unknown_skill";
  return "invalid_skill";
}

function load(name: string, options: LoadSkillToolOptions): unknown {
  if (options.workspace === null) {
    throw contractFailure(
      LOAD_SKILL_ERROR_PREFIX,
      "no_workspace",
      "no session workspace is bound to this generation: the skill source layers cannot be resolved",
    );
  }
  const layers = readLayers(options.workspace, options.env === undefined ? {} : { env: options.env });
  const loaded = loadSkillBody(layers, name);
  if (!loaded.ok) throw contractFailure(LOAD_SKILL_ERROR_PREFIX, failureCode(name, loaded.error), loaded.error);
  return { name: loaded.skill.name, source: loaded.skill.source, dir: loaded.skill.dir, body: loaded.body };
}

export function loadSkillTool(options: LoadSkillToolOptions): Tool {
  const spec = loadSkillSpec();
  return {
    spec: () => spec,
    execute: async (args) => load(stringArg(args, "name"), options),
  };
}
