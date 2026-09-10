/**
 * Studio host configuration (paths + frozen constants).
 *
 * Everything here is a *host* decision: where the data files live, which
 * directory the frontend build is served from, and the compile-time constants
 * the Rust reference hardcodes (`DEFAULT_BIND`, `STATIC_ROOT`, `FS_ROOTS`).
 * No engine semantics live here — those belong to the injected RuntimeAdapter.
 */

import { resolve } from "node:path";

/** `src/main.rs:867` — CONSTANT: it does not follow STUDIO_BIND. */
export const DEFAULT_BIND = "127.0.0.1:3777";
/** `src/main.rs` STATIC_ROOT: the Vite build, served read-only. */
export const DEFAULT_STATIC_ROOT = "/src/celestea_studio/frontend/dist";
/** `src/main.rs:1311` broadcast capacity; slow clients degrade to `lagged`. */
export const BUS_CAPACITY = 512;
/** `src/workspaces.rs:113` informational roots shown by GET /api/fs/browse. */
export const FS_ROOTS: readonly string[] = ["/src", "/tmp", "/srv", "/home"];
/** `src/workspaces.rs:115` fs browse entry cap. */
export const MAX_DIR_ENTRIES = 200;
/** `src/api.rs` MIN_STEPS: POST /api/config can only raise max_steps. */
export const MIN_STEPS = 4096;
/** Contract default context window (statusline fallback). */
export const CONTEXT_WINDOW = 1_000_000;

export interface StudioPaths {
  /** CELESTEA_WORKSPACES_FILE ?? <cwd>/workspaces.json (mode 0644). */
  workspacesFile: string;
  /** CELESTEA_PROVIDERS_FILE ?? <cwd>/providers.json (mode 0600, secret). */
  providersFile: string;
  /** CELESTEA_PROMPTS_FILE ?? <cwd>/prompts.json (mode 0644). */
  promptsFile: string;
  /** STUDIO_STATIC_ROOT ?? the Vite build directory. */
  staticRoot: string;
}

export interface StudioConfig {
  /** Constant "celestea-studio" in /api/health. */
  name: string;
  bind: string;
  apiKeyEnv: string;
  paths: StudioPaths;
}

export interface StudioConfigInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  paths?: Partial<StudioPaths>;
}

/** Build the host config from the environment; every value is overridable. */
export function loadStudioConfig(input: StudioConfigInput = {}): StudioConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const paths: StudioPaths = {
    workspacesFile: env["CELESTEA_WORKSPACES_FILE"] ?? resolve(cwd, "workspaces.json"),
    providersFile: env["CELESTEA_PROVIDERS_FILE"] ?? resolve(cwd, "providers.json"),
    promptsFile: env["CELESTEA_PROMPTS_FILE"] ?? resolve(cwd, "prompts.json"),
    staticRoot: env["STUDIO_STATIC_ROOT"] ?? DEFAULT_STATIC_ROOT,
    ...input.paths,
  };
  return {
    name: "celestea-studio",
    bind: DEFAULT_BIND,
    apiKeyEnv: env["CELESTEA_API_KEY_ENV"] ?? "CELESTEA_API_KEY",
    paths,
  };
}
