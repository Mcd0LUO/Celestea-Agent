/**
 * Studio host configuration (paths + frozen constants).
 *
 * Everything here is a *host* decision: where the data files live, which
 * directory the frontend build is served from, and the compile-time constants
 * the legacy backend hardcoded (`DEFAULT_BIND`, `STATIC_ROOT`, `FS_ROOTS`).
 * No engine semantics live here — those belong to the injected RuntimeAdapter.
 */

import { dirname, join, resolve } from "node:path";
import { AUTH_SECRET_FILE } from "./auth/token.js";
import { readAuthToken } from "./auth/api-token.js";
import { packagedWebDist, studioRepoRoot } from "./deployment.js";

/** `src/main.rs:867` — the DEFAULT bind; the live one is written back at listen time. */
export const DEFAULT_BIND = "127.0.0.1:3777";
/**
 * `src/main.rs` STATIC_ROOT: the Vite build, served read-only.
 *
 * W782: DERIVED, never written down. `apps/web/dist` lives inside this very
 * checkout, so the repo root comes from `studioRepoRoot()` (this file's own
 * location) — the previous literal broke silently every time the checkout moved
 * or the frontend was relocated (it was `celestea_studio/frontend/dist` before
 * W781). `STUDIO_STATIC_ROOT` still overrides it for an operator.
 *
 * H: an INSTALLED `@celestea/studio` has no checkout, so the frontend build is
 * staged at `<package>/webdist` by `scripts/build-webdist.mjs` and preferred
 * when present. A source checkout keeps `apps/web/dist` exactly as before.
 */
export function defaultStaticRoot(): string {
  return packagedWebDist() ?? join(studioRepoRoot(), "apps", "web", "dist");
}
/** `src/main.rs:1311` broadcast capacity; slow clients degrade to `lagged`. */
export const BUS_CAPACITY = 512;
/**
 * `src/workspaces.rs:113` informational roots shown by GET /api/fs/browse as
 * one-click shortcuts (listing is NOT restricted to them; the endpoints have no
 * auth, which is why the default bind is loopback).
 *
 * W885 follow-up: the roots are a PLATFORM question. `/src /tmp /srv /home` are
 * meaningless on Windows, where the useful shortcuts are the system drive and the
 * user profile — and the same list supplies the default path when a client sends
 * none. `platform`/`env` are injectable so the win32 answer is unit-tested on
 * Linux (the W885 seam). POSIX output is byte-identical to the old constant.
 */
export function fsRoots(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== "win32") return ["/src", "/tmp", "/srv", "/home"];
  const drive = (env["SystemDrive"] ?? "C:").replace(/[\\/]+$/, "");
  const out = [drive + "\\"];
  const profile = (env["USERPROFILE"] ?? "").trim();
  if (profile !== "") out.push(profile.replace(/[\\/]+$/, ""));
  return out;
}
/** `src/workspaces.rs:115` fs browse entry cap. */
export const MAX_DIR_ENTRIES = 200;
/** `src/api.rs` MIN_STEPS: POST /api/config can only raise max_steps. */
export const MIN_STEPS = 4096;
/** Contract default context window (statusline fallback). */
export const CONTEXT_WINDOW = 1_000_000;
/**
 * W767: Studio's OWN password file (read-only input to `htpasswd -vbi`). This
 * is the file this project owns; no other service's credential store is ever
 * consulted.
 */
export const DEFAULT_AUTH_HTPASSWD_FILE = "/etc/nginx/.htpasswd-studio";

export interface StudioPaths {
  /** CELESTEA_WORKSPACES_FILE ?? <cwd>/workspaces.json (mode 0644). */
  workspacesFile: string;
  /** CELESTEA_PROVIDERS_FILE ?? <cwd>/providers.json (mode 0600, secret). */
  providersFile: string;
  /** CELESTEA_PROMPTS_FILE ?? <cwd>/prompts.json (mode 0644). */
  promptsFile: string;
  /** STUDIO_STATIC_ROOT ?? the Vite build directory. */
  staticRoot: string;
  /**
   * W767: `<data dir>/studio-auth.secret` (0600, created on first use) — the
   * HMAC key of Studio's own login cookie. `CELESTEA_AUTH_SECRET_FILE` overrides.
   */
  authSecretFile: string;
  /** W767: the read-only password file `CELESTEA_AUTH_HTPASSWD_FILE` overrides. */
  authHtpasswdFile: string;
}

export interface StudioConfig {
  /** Constant "celestea-studio" in /api/health. */
  name: string;
  bind: string;
  apiKeyEnv: string;
  /**
   * H-security: the self-cert bearer token required on every `/api/*` request
   * except `/api/health`. `null` = no token (loopback / nginx-delegated).
   */
  authToken: string | null;
  paths: StudioPaths;
}

export interface StudioConfigInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  paths?: Partial<StudioPaths>;
  /** H-security: explicit token (the `--token` flag); else `CELESTEA_AUTH_TOKEN`. */
  authToken?: string | null;
}

/** Build the host config from the environment; every value is overridable. */
export function loadStudioConfig(input: StudioConfigInput = {}): StudioConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const explicit = input.paths ?? {};
  const workspacesFile = explicit.workspacesFile ?? env["CELESTEA_WORKSPACES_FILE"] ?? resolve(cwd, "workspaces.json");
  const paths: StudioPaths = {
    workspacesFile,
    providersFile: explicit.providersFile ?? env["CELESTEA_PROVIDERS_FILE"] ?? resolve(cwd, "providers.json"),
    promptsFile: explicit.promptsFile ?? env["CELESTEA_PROMPTS_FILE"] ?? resolve(cwd, "prompts.json"),
    staticRoot: explicit.staticRoot ?? env["STUDIO_STATIC_ROOT"] ?? defaultStaticRoot(),
    // W767: the login secret lives in the SAME data dir as workspaces.json —
    // `createStudioEngine` derives `<data dir>` the same way, so there is one
    // notion of "Studio's data directory", not two.
    authSecretFile:
      explicit.authSecretFile ?? env["CELESTEA_AUTH_SECRET_FILE"] ?? join(dirname(workspacesFile), AUTH_SECRET_FILE),
    authHtpasswdFile: explicit.authHtpasswdFile ?? env["CELESTEA_AUTH_HTPASSWD_FILE"] ?? DEFAULT_AUTH_HTPASSWD_FILE,
  };
  const token = input.authToken ?? readAuthToken(env);
  return {
    name: "celestea-studio",
    bind: DEFAULT_BIND,
    apiKeyEnv: env["CELESTEA_API_KEY_ENV"] ?? "CELESTEA_API_KEY",
    authToken: token === null || token.trim() === "" ? null : token.trim(),
    paths,
  };
}
