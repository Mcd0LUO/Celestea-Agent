/**
 * W782 — the deployment facts the system prompt is allowed to state, and the
 * ONE place each of them is written down.
 *
 * Why this module exists. The `environment` prompt section (order 200) used to
 * spell out this checkout's absolute paths BY HAND:
 *
 *   "…the TypeScript service in /src/celestea_studio-ts (Hono, systemd unit
 *    celestea-studio-ts on 127.0.0.1:3777; public site https://studio.celestea.top).
 *    … the frontend is /src/celestea_studio-ts/apps/web …"
 *
 * The same fact therefore existed TWICE and independently: once in the real
 * deployment (the systemd unit, the config, this checkout) and once as prose in
 * a prompt template. Nothing tied them together, so when the repo moved
 * (`celestea_studio` -> `celestea_studio-ts`), when the frontend was merged in
 * (`frontend/` -> `apps/web`) and when the data dir moved out of the tree
 * (W781), the template had to be edited by hand each time — and a forgotten edit
 * makes the agent confidently describe a layout that no longer exists. W768 was
 * exactly that failure (`pwd` was one workspace while the prompt named another).
 *
 * The rule this module enforces: **derive what can be derived, and keep the one
 * irreducible literal in a single named constant.** The template may only
 * reference `{{...}}` variables; `apps/studio/src/store/prompts.test.ts` fails
 * the build if an absolute path literal ever reappears in a template string.
 *
 * Derivation precedence, per fact:
 *   repo root   <- this file's own location, walked up to the workspace marker
 *                  (never the cwd, never an env var, never a literal)
 *   frontend    <- repo root + apps/web
 *   static root <- `config.paths.staticRoot` (already an operator setting)
 *   bind        <- `config.bind` (already an operator setting)
 *   unit name   <- CELESTEA_SERVICE_NAME ?? /proc/self/cgroup ?? [SERVICE_FALLBACK]
 *   public site <- [PUBLIC_SITE] (irreducible: nothing in this process knows
 *                  which DNS name the tunnel/Nginx answers on)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The workspace marker that identifies this repository's root. */
const REPO_MARKER = "pnpm-workspace.yaml";

/** `{{studio_frontend_dir}}` is the repo root plus this, and nothing else. */
const FRONTEND_SUBDIR = ["apps", "web"] as const;

/**
 * Operator override for the systemd unit name stated in the prompt. Set it in
 * the unit (`Environment=CELESTEA_SERVICE_NAME=…`) when the unit is renamed;
 * this beats both the cgroup guess and [SERVICE_FALLBACK].
 */
export const ENV_SERVICE_NAME = "CELESTEA_SERVICE_NAME";

/**
 * The ONLY hand-written copy of this deployment's unit name. Used when neither
 * `CELESTEA_SERVICE_NAME` nor `/proc/self/cgroup` yields one (e.g. a bare
 * `tsx src/main.ts` outside systemd). If you rename the unit, either set the env
 * var or update this line — it must never be repeated anywhere else.
 */
export const SERVICE_FALLBACK = "celestea-studio-ts.service";

/**
 * The public site. Irreducible from inside this process: it is a DNS/tunnel
 * fact, not a fact about this checkout. The ONLY copy; templates reference
 * `{{studio_site}}`.
 */
export const PUBLIC_SITE = "https://studio.celestea.top";

/** Parse a systemd unit out of `/proc/self/cgroup` text (pure, testable). */
export function systemdUnitNameFromCgroup(text: string): string | null {
  // Each line is `hierarchy:controllers:/path`; the unit is the LAST path
  // segment of whichever line names one (`0::/system.slice/foo.service`).
  for (const line of text.split("\n")) {
    const path = line.slice(line.lastIndexOf(":") + 1).trim();
    const segment = path.slice(path.lastIndexOf("/") + 1);
    if (segment.endsWith(".service")) return segment;
  }
  return null;
}

/** `/proc/self/cgroup` of this process, or null when unreadable. */
function cgroupUnitName(): string | null {
  try {
    return systemdUnitNameFromCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

/**
 * The repository root, derived from THIS file's location: `src/deployment.ts`
 * sits directly under `apps/studio`, so walking up until the workspace marker
 * appears is stable under any cwd, any symlinked launcher and any rename of the
 * checkout directory. Falls back to walking up from the cwd, then throws —
 * a wrong prompt is worse than a loud startup failure.
 */
export function studioRepoRoot(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    for (let dir = start; ; ) {
      if (existsSync(join(dir, REPO_MARKER))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`cannot derive the studio repo root: no ${REPO_MARKER} above ${fileURLToPath(import.meta.url)} or ${process.cwd()}`);
}

/** What the prompt may say about this deployment — every field derived. */
export interface DeploymentFacts {
  /** `{{studio_repo}}` — this checkout's root. */
  repo: string;
  /** `{{studio_frontend_dir}}` — where the frontend sources live. */
  frontendDir: string;
  /** `{{studio_static_root}}` — where the built frontend is served from. */
  staticRoot: string;
  /** `{{studio_service}}` — the systemd unit name. */
  service: string;
  /** `{{studio_bind}}` — host:port the backend listens on. */
  bind: string;
  /** `{{studio_site}}` — the public site. */
  publicSite: string;
}

/**
 * The two operator settings this module reads, taken STRUCTURALLY rather than as
 * `StudioConfig`. `config.ts` derives its default static root from
 * `studioRepoRoot()` in this file, so importing `StudioConfig` here would make
 * the two modules depend on each other (`no-circular`). A structural parameter
 * keeps the edge one-way.
 */
export interface DeploymentConfigInput {
  bind: string;
  paths: { staticRoot: string };
}

/**
 * Resolve every fact the `environment` section states. `env` is read for the
 * unit-name override only; `config` supplies the two operator settings.
 */
export function deploymentFacts(config: DeploymentConfigInput, env: NodeJS.ProcessEnv = process.env): DeploymentFacts {
  const repo = studioRepoRoot();
  const override = env[ENV_SERVICE_NAME];
  return {
    repo,
    frontendDir: join(repo, ...FRONTEND_SUBDIR),
    staticRoot: config.paths.staticRoot,
    service: override !== undefined && override !== "" ? override : (cgroupUnitName() ?? SERVICE_FALLBACK),
    bind: config.bind,
    publicSite: PUBLIC_SITE,
  };
}
