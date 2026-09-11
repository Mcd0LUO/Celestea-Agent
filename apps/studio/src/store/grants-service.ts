/**
 * The grants service bundle (W516): everything the endpoints and the runtime
 * need, created once per Studio process and provided through the Context.
 *
 * `now` is a MUTABLE field on purpose: the grant file stores absolute unix
 * seconds and the confirm tokens / rate limits are clock-driven, so tests pin
 * one clock and then advance it (token TTL, cooldown) without touching globals.
 */

import { GrantsAuditWriter } from "./grants-audit.js";
import { GrantRateLimiter, GrantTokenStore } from "./grants-tokens.js";

export interface GrantsServices {
  /** `<data dir>` — the local audit channel lives here. */
  dataDir: string;
  env: NodeJS.ProcessEnv;
  /** Milliseconds since the epoch (advanced by tests). */
  now: () => number;
  audit: GrantsAuditWriter;
  tokens: GrantTokenStore;
  limits: GrantRateLimiter;
}

export interface GrantsServicesInput {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injected platform-audit transport (tests). */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
}

/**
 * The env every grants reader sees. `CELESTEA_WORKSPACES_FILE` is pinned to the
 * file the host ACTUALLY composed, so `effectiveGrantsOf` (which takes only an
 * env, §4.1) resolves the same `<data dir>` the studio is using — not whatever
 * a stale process env happens to say.
 */
export function grantsEnv(env: NodeJS.ProcessEnv, workspacesFile: string): NodeJS.ProcessEnv {
  return { ...env, CELESTEA_WORKSPACES_FILE: workspacesFile };
}

export function createGrantsServices(input: GrantsServicesInput & { workspacesFile?: string }): GrantsServices {
  const env = input.workspacesFile === undefined ? (input.env ?? process.env) : grantsEnv(input.env ?? process.env, input.workspacesFile);
  const services: GrantsServices = {
    dataDir: input.dataDir,
    env,
    now: input.now ?? Date.now,
    audit: new GrantsAuditWriter({
      dataDir: input.dataDir,
      env,
      now: input.now ?? Date.now,
      ...(input.post === undefined ? {} : { post: input.post }),
    }),
    // Both clock-driven helpers read the MUTABLE `now` field, never a snapshot.
    tokens: new GrantTokenStore(() => services.now()),
    limits: new GrantRateLimiter(() => services.now()),
  };
  return services;
}

/** Seconds since the epoch (the grants file's unit). */
export function nowSec(services: { now: () => number }): number {
  return Math.floor(services.now() / 1000);
}
