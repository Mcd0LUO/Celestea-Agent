/**
 * `effectiveGrantsOf` — the ONE reader of a session's grants (W516 §4.1/§4.3).
 *
 * Every rule here is fail-closed and "only widen":
 *   1. file level: missing = no grants; bad JSON / unknown version / a
 *      self-description that does not match the directory / `grants` not an
 *      array = the WHOLE file is void + a warning (never repaired, never
 *      guessed at);
 *   2. entry level: an unknown `cap` or a wrong-typed `scope` drops THAT entry;
 *   3. path scopes must be absolute, `realpath`-able directories, not `/`, not
 *      the data dir, not `$HOME`, and a `write_roots` entry must not overlap a
 *      read root (workspace/env/other grants) — all six must hold or the entry
 *      is ignored;
 *   4. roots are additive: the workspace and the env roots are never removed;
 *   5. `unsandboxed` is only ever *consumed* by the provider policy, which
 *      ignores it while bwrap works (`sandbox/provider.ts`) — this module only
 *      validates it;
 *   6. unparseable `net_hosts` entries are ignored one by one;
 *   7. ignoring a bad entry is deliberate and the OPPOSITE of the env
 *      `CELESTEA_TOOL_ROOTS` fail-closed rule: env is an operator posture where
 *      a typo must be loud, grants are per-session widenings where "ignore" is
 *      the safe side, while a hard failure would only push users toward
 *      `CELESTEA_TOOL_GUARD=0`. Do NOT "unify" the two.
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { httpOptions, isInside, parseIpRange, parseToolRoots } from "@celestea/tools";
/**
 * W747: `sessionIdOfDir` moved to the engine (`@celestea/runtime`, host layer
 * `host/engine-session.ts`) — the `<workspace>/<session>` id space is what that
 * module already owns. Imported + re-exported here so every `./engine-grants.js`
 * import of it keeps working, unchanged.
 */
import { sessionIdOfDir } from "@celestea/runtime";
export { sessionIdOfDir };
import type { GrantsAuditEventName } from "../store/grants-audit.js";
import { loadStudioConfig } from "../config.js";
import {
  ENV_GRANTS_UNSANDBOXED,
  isExpired,
  knownSecretsOf,
  looksLikeCredential,
  readGrantsFile,
  type GrantCap,
  type GrantRecord,
  type GrantsFile,
} from "../store/grants.js";

/** The effective, widen-only grant set of ONE session instance. */
export interface EffectiveGrants {
  network: boolean;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  netHosts: readonly string[];
  toolExtra: readonly string[];
  unsandboxed: boolean;
  /** Provenance for the audit trail / UI (`cap` + grant id + expiry). */
  sources: ReadonlyArray<{ cap: string; grantId: string; expiresAt: number | null }>;
}

export const EMPTY_GRANTS: EffectiveGrants = {
  network: false,
  readRoots: [],
  writeRoots: [],
  netHosts: [],
  toolExtra: [],
  unsandboxed: false,
  sources: [],
};

export interface EffectiveGrantsResult {
  grants: EffectiveGrants;
  warnings: string[];
}

/** `unsandboxed` is only offered when the operator opts in (§2.2). */
export function unsandboxedAvailable(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[ENV_GRANTS_UNSANDBOXED] ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

/**
 * W757: whether this session's `net_hosts` entries take effect AT ALL in this
 * deployment.
 *
 * ONE definition, and deliberately the SAME construction path the engine mounts
 * its tools with (`engineTools` → `httpOptions` → `HttpTargetPolicy.fromEnv`):
 * `net_hosts` is merged into the allow side only, so an inactive env policy
 * (neither `CELESTEA_HTTP_ALLOW` nor `CELESTEA_HTTP_DENY` set) drops the whole
 * list — `netHostsIneffective` is exactly that verdict and this module never
 * re-derives it (a second implementation would silently drift from the mount).
 *
 * `false` ⇒ the session holds `net_hosts` entries the deployment ignores
 * entirely. Empty `net_hosts` ⇒ `true`: there is nothing to be dropped.
 *
 * Reporting only: the policy object is built and discarded, so no authorization
 * decision here changes, and the union / deny-wins / fail-closed semantics of
 * `ssrf.ts` stay exactly as they are.
 */
export function netHostsEffective(env: NodeJS.ProcessEnv, grants: EffectiveGrants): boolean {
  return httpOptions(env, { netHosts: grants.netHosts }).policy?.netHostsIneffective !== true;
}

/** Read + validate; NEVER throws, only degrades with warnings (§4.1). */
export function effectiveGrantsOf(sessionDir: string | null, env: NodeJS.ProcessEnv, now: number): EffectiveGrantsResult {
  if (sessionDir === null) return { grants: EMPTY_GRANTS, warnings: [] };
  const read = readGrantsFile(sessionDir, sessionIdOfDir(sessionDir));
  if (!read.exists) return { grants: EMPTY_GRANTS, warnings: [] };
  if (read.file === undefined) {
    const reason = read.error ?? "unreadable";
    return { grants: EMPTY_GRANTS, warnings: [`grants_unreadable: ${reason} — the session runs with no grants`] };
  }
  return collect(read.file, env, now);
}

/** Fold the (already shape-checked) entries into the effective set. */
function collect(file: GrantsFile, env: NodeJS.ProcessEnv, now: number): { grants: EffectiveGrants; warnings: string[] } {
  const warnings: string[] = [];
  const acc: Mutable = { readRoots: [], writeRoots: [], netHosts: [], toolExtra: [], sources: [] };
  const ctx: Ctx = { env, known: knownSecretsOf(env), readRoots: envReadRoots(env) };
  for (const grant of file.grants) {
    if (isExpired(grant, now)) {
      warnings.push(`grant ${grant.id} (${grant.cap}) has expired — ignored`);
      continue;
    }
    applyGrant(acc, grant, ctx, warnings);
  }
  return { grants: { ...acc, network: acc.network === true, unsandboxed: acc.unsandboxed === true }, warnings };
}

/**
 * Warning context. `known` keeps a credential-shaped scope value out of the
 * warning text itself: a warning ends up in the audit log and in the UI, and
 * §5.4 forbids echoing such a value anywhere.
 */
interface Ctx {
  env: NodeJS.ProcessEnv;
  known: readonly string[];
  readRoots: string[];
}

/** `entry`, or a placeholder when the value must not be echoed (§5.4). */
function show(entry: string, ctx: Ctx): string {
  return looksLikeCredential(entry, ctx.known) ? "<value looks like a credential>" : entry;
}

interface Mutable {
  network?: boolean;
  unsandboxed?: boolean;
  readRoots: string[];
  writeRoots: string[];
  netHosts: string[];
  toolExtra: string[];
  sources: Array<{ cap: string; grantId: string; expiresAt: number | null }>;
}

function applyGrant(acc: Mutable, grant: GrantRecord, ctx: Ctx, warnings: string[]): void {
  const keep = (): void => {
    acc.sources.push({ cap: grant.cap, grantId: grant.id, expiresAt: grant.expires_at });
  };
  if (grant.cap === "network") {
    acc.network = true;
    keep();
    return;
  }
  if (grant.cap === "unsandboxed") {
    acc.unsandboxed = true;
    keep();
    return;
  }
  if (grant.cap === "read_roots" || grant.cap === "write_roots") {
    const roots = rootsOf(grant, { ...ctx, readRoots: [...ctx.readRoots, ...acc.readRoots] }, warnings);
    if (roots.length === 0) return;
    if (grant.cap === "read_roots") acc.readRoots.push(...roots);
    else acc.writeRoots.push(...roots);
    keep();
    return;
  }
  if (grant.cap === "net_hosts") {
    const hosts = (grant.scope.hosts ?? []).filter((h) => isHostEntry(h) || isIpEntry(h));
    if (hosts.length === 0) {
      warnings.push(
        `grant ${grant.id} (net_hosts): no usable host (dropped: ${(grant.scope.hosts ?? []).map((h) => show(h, ctx)).join(", ")}) — ignored`,
      );
      return;
    }
    acc.netHosts.push(...hosts);
    keep();
    return;
  }
  const tools = (grant.scope.tools ?? []).filter((t) => /^[a-z][a-z0-9_]{0,63}$/.test(t));
  if (tools.length === 0) {
    warnings.push(`grant ${grant.id} (tool_extra) holds no usable tool name — ignored`);
    return;
  }
  acc.toolExtra.push(...tools);
  keep();
}

/** The six path rules of §4.3.3 — ALL must hold, else the whole entry is dropped. */
function rootsOf(grant: GrantRecord, ctx: Ctx, warnings: string[]): string[] {
  const raw = grant.scope.roots ?? [];
  const canonical: string[] = [];
  for (const entry of raw) {
    const rejected = rejectRoot(entry, { ...ctx, readRoots: [...ctx.readRoots, ...canonical] }, grant);
    if (rejected !== null) {
      warnings.push(`grant ${grant.id} (${grant.cap}): ${rejected} — the entry is ignored`);
      return [];
    }
    const resolved = canonicalPath(entry);
    if (resolved !== null) canonical.push(resolved);
  }
  return canonical.length === 0 ? [] : [...new Set(canonical)];
}

/** `null` = usable; otherwise the reason (never echoing a credential value). */
function rejectRoot(entry: string, ctx: Ctx, grant: GrantRecord): string | null {
  if (looksLikeCredential(entry, ctx.known)) return "the value looks like a credential";
  if (!isAbsolute(entry)) return `root '${show(entry, ctx)}' is not absolute`;
  const resolved = canonicalPath(entry);
  if (resolved === null) return `root '${show(entry, ctx)}' does not exist`;
  if (!isDirectory(resolved)) return `root '${show(entry, ctx)}' is not a directory`;
  if (resolved === "/") return "root '/' is the filesystem root";
  const dataDir = canonicalPath(dirname(loadStudioConfig({ env: ctx.env }).paths.workspacesFile));
  if (dataDir !== null && (isInside(dataDir, resolved) || dataDir === resolved)) return "root covers the studio data directory";
  const home = canonicalPath(ctx.env["HOME"] ?? homedir());
  if (home !== null && resolved === home) return "root is $HOME";
  if (grant.cap === "write_roots") {
    const clash = ctx.readRoots.find((root) => isInside(resolved, root) || isInside(root, resolved));
    if (clash !== undefined) return `write root overlaps the read root '${clash}'`;
  }
  return null;
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Env-declared read roots, canonicalized best-effort (grant overlap check). */
export function envReadRoots(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const entry of parseToolRoots(env["CELESTEA_TOOL_ROOTS"])) {
    const resolved = canonicalPath(entry);
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

function isIpEntry(entry: string): boolean {
  try {
    parseIpRange(entry);
    return true;
  } catch {
    return false;
  }
}

function isHostEntry(entry: string): boolean {
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(entry);
}

/**
 * What the assembly layers may report back (W516 §4.4). Deliberately tiny and
 * credential-free: no command text ever travels through here.
 */
export interface EngineGrantEvent {
  event: GrantsAuditEventName;
  cap?: string;
  grant_id?: string;
  provider?: string;
  reason?: string;
  detail?: string;
}

/** Sink bound to one session (see `session-grants.ts`). */
export type EngineGrantAudit = (event: EngineGrantEvent) => void;

/** Cap names currently in force (never paths) — `GET /api/status` (§5.7). */
export function grantsActiveCaps(grants: EffectiveGrants): string[] {
  const caps: GrantCap[] = [];
  if (grants.network) caps.push("network");
  if (grants.readRoots.length > 0) caps.push("read_roots");
  if (grants.writeRoots.length > 0) caps.push("write_roots");
  if (grants.netHosts.length > 0) caps.push("net_hosts");
  if (grants.toolExtra.length > 0) caps.push("tool_extra");
  if (grants.unsandboxed) caps.push("unsandboxed");
  return caps;
}

/** Grant ids that are past their `expires_at` (the `expire` audit event). */
export function expiredGrants(file: GrantsFile, now: number): GrantRecord[] {
  return file.grants.filter((grant) => isExpired(grant, now));
}
