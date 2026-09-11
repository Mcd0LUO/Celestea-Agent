/**
 * `<session dir>/grants.json` — the session's grant file (W516 §2.1, §5.4).
 *
 * The file is the ONLY source of a session's widenings and it is deliberately
 * hostile-input-shaped: it lives next to `session.json` inside a workspace, so
 * anything that can write the workspace can write it (including a session's own
 * tools) — therefore every field is whitelisted, every value is validated, and
 * a corrupt file means "no grants at all" rather than "repair it".
 *
 * Durability: `<path>.tmp` → rename (`fs-json.ts`) with mode 0600, like
 * `providers.json`. Redaction: the `note` field is redacted before it is
 * written, and a `roots`/`hosts`/`tools` value that LOOKS like a credential is
 * rejected (400 at the endpoint, dropped entry when hand-edited) — no response,
 * audit line or UI ever echoes such a value back.
 *
 * `grants.json` is NOT a session registry file: it is absent by default (that is
 * the normal, least-privilege state) and it is not part of
 * `contracts/data-files/index.json`.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectKnownSecrets, createRedactor } from "@celestea/core";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";

export const GRANTS_FILE = "grants.json";
/** Env var enabling the `unsandboxed` cap (§2.2: hidden in the UI by default). */
export const ENV_GRANTS_UNSANDBOXED = "CELESTEA_GRANTS_ALLOW_UNSANDBOXED";
/** Default `ttl_sec` the UI pre-fills (§2.3). */
export const DEFAULT_TTL_SEC = 1800;
/** Cap on scope values (`roots`/`hosts`/`tools` entries). */
export const MAX_SCOPE_VALUE_CHARS = 200;
/** Cap on the number of entries per scope list. */
export const MAX_SCOPE_ENTRIES = 32;

export type GrantCap = "network" | "read_roots" | "write_roots" | "net_hosts" | "tool_extra" | "unsandboxed";

export const GRANT_CAPS: readonly GrantCap[] = ["network", "read_roots", "write_roots", "net_hosts", "tool_extra", "unsandboxed"];

/** Per-cap TTL ceiling, enforced by the SERVER (§2.3). */
export const MAX_TTL_SEC: Readonly<Record<GrantCap, number>> = {
  network: 3600,
  read_roots: 86400,
  write_roots: 86400,
  net_hosts: 86400,
  tool_extra: 86400,
  unsandboxed: 900,
};

/** Scope of one grant entry: at most one of these lists is meaningful per cap. */
export interface GrantScope {
  roots?: string[];
  hosts?: string[];
  tools?: string[];
}

export interface GrantRecord {
  id: string;
  cap: GrantCap;
  scope: GrantScope;
  granted_at: number;
  granted_by: string;
  /** Absolute unix seconds; null = no expiry. */
  expires_at: number | null;
  /** null = unlimited; 1 = single use (forced for `unsandboxed`). */
  uses_left: number | null;
  note: string;
}

export interface GrantsFile {
  version: number;
  /** Self-description `<workspace>/<session>`; a mismatch voids the whole file. */
  session: string;
  updated_at: number;
  grants: GrantRecord[];
}

export type GrantsRead = { exists: boolean; file?: GrantsFile; error?: string };

/** The env-side secret set (`collectKnownSecrets`) used by [looksLikeCredential]. */
export function knownSecretsOf(env: NodeJS.ProcessEnv = process.env): string[] {
  return collectKnownSecrets({ env });
}

/** Shape-only credential screen (W516 §5.4) — never echoes the value. */
export function looksLikeCredential(value: string, known: readonly string[]): boolean {
  if (value.trim() !== value || /[\r\n]/.test(value)) return true;
  if (createRedactor(known).redact(value) !== value) return true;
  return false;
}

export function isGrantCap(value: unknown): value is GrantCap {
  return typeof value === "string" && (GRANT_CAPS as readonly string[]).includes(value);
}

export function maxTtlOf(cap: GrantCap): number {
  return MAX_TTL_SEC[cap];
}

/** Random, revocable-audit-stable id (`g-` + 8 hex, §2.1). */
export function newGrantId(): string {
  const hex = Math.floor(Math.random() * 0xffff_ffff)
    .toString(16)
    .padStart(8, "0");
  return `g-${hex}`;
}

export function emptyGrantsFile(session: string, now: number): GrantsFile {
  return { version: 1, session, updated_at: now, grants: [] };
}

/** Canonical scope JSON — the `scope_hash` input shared with the UI (§6.4). */
export function canonicalScopeJson(cap: string, scope: GrantScope): string {
  const keys = Object.keys(scope).sort();
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const value = scope[key as keyof GrantScope];
    if (value === undefined) continue;
    out[key] = [...value].sort();
  }
  return JSON.stringify({ cap, scope: out });
}

/** sha256 hex of [canonicalScopeJson] — the `scope_hash` of §6.4. */
export function canonicalScopeHash(cap: string, scope: GrantScope): string {
  return createHash("sha256").update(canonicalScopeJson(cap, scope)).digest("hex");
}

/**
 * Validate + normalize one scope. Unknown keys are dropped (whitelist), values
 * are credential-screened, and a wrong type is a 400-shaped error string.
 */
export function validateScope(
  cap: GrantCap,
  raw: unknown,
  known: readonly string[],
): { ok: true; scope: GrantScope } | { ok: false; error: string } {
  const source = raw === undefined || raw === null ? {} : raw;
  if (typeof source !== "object" || Array.isArray(source)) return { ok: false, error: "scope must be an object" };
  const rec = source as Record<string, unknown>;
  const key = SCOPE_KEY[cap];
  if (key === null) return { ok: true, scope: {} };
  const values = rec[key];
  if (values === undefined || values === null) return { ok: false, error: `scope.${key} is required` };
  if (!Array.isArray(values)) return { ok: false, error: `scope.${key} must be an array of strings` };
  if (values.length === 0) return { ok: false, error: `scope.${key} must not be empty` };
  if (values.length > MAX_SCOPE_ENTRIES) return { ok: false, error: `scope.${key} holds more than ${MAX_SCOPE_ENTRIES} entries` };
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") return { ok: false, error: `scope.${key} entries must be non-empty strings` };
    if (value.length > MAX_SCOPE_VALUE_CHARS) return { ok: false, error: `scope.${key} entry is longer than ${MAX_SCOPE_VALUE_CHARS} chars` };
    if (looksLikeCredential(value, known)) return { ok: false, error: "value looks like a credential" };
    out.push(value.trim());
  }
  return { ok: true, scope: { [key]: [...new Set(out)] } as GrantScope };
}

const SCOPE_KEY: Readonly<Record<GrantCap, "roots" | "hosts" | "tools" | null>> = {
  network: null,
  unsandboxed: null,
  read_roots: "roots",
  write_roots: "roots",
  net_hosts: "hosts",
  tool_extra: "tools",
};

/**
 * Read + validate the file. `exists:false` = the normal least-privilege state.
 * Any structural problem (bad JSON, unknown version, self-description mismatch,
 * `grants` not an array) returns `{exists:true, error}` and NO file: the caller
 * turns that into an empty grant set plus a `grants_unreadable` audit line.
 */
export function readGrantsFile(dir: string, expectedSession: string): GrantsRead {
  const out = readJsonIfExists(join(dir, GRANTS_FILE));
  if (!out.exists) return { exists: false };
  if (out.error !== undefined) return { exists: true, error: `unparsable grants.json: ${out.error}` };
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { exists: true, error: "grants.json is not an object" };
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return { exists: true, error: `unknown grants.json version '${String(rec["version"])}'` };
  if (rec["session"] !== expectedSession) return { exists: true, error: `grants.json belongs to '${String(rec["session"])}'` };
  if (!Array.isArray(rec["grants"])) return { exists: true, error: "grants.json has no grants array" };
  const grants: GrantRecord[] = [];
  rec["grants"].forEach((entry, index) => {
    const parsed = parseGrantEntry(entry, index);
    if (parsed !== null) grants.push(parsed);
  });
  const updated = typeof rec["updated_at"] === "number" ? rec["updated_at"] : 0;
  return { exists: true, file: { version: 1, session: expectedSession, updated_at: updated, grants } };
}

/** Whitelist one entry; `null` = unusable row (dropped, never guessed at). */
function parseGrantEntry(raw: unknown, index: number): GrantRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!isGrantCap(rec["cap"])) return null;
  const id = typeof rec["id"] === "string" && rec["id"] !== "" ? rec["id"] : `g-invalid-${index}`;
  const scope = isGrantCap(rec["cap"]) ? normalizeStoredScope(rec["cap"], rec["scope"]) : {};
  return {
    id,
    cap: rec["cap"],
    scope,
    granted_at: numberOr(rec["granted_at"], 0),
    granted_by: typeof rec["granted_by"] === "string" ? rec["granted_by"] : "",
    expires_at: numberOrNull(rec["expires_at"]),
    uses_left: numberOrNull(rec["uses_left"]),
    note: typeof rec["note"] === "string" ? rec["note"] : "",
  };
}

function normalizeStoredScope(cap: GrantCap, raw: unknown): GrantScope {
  const key = SCOPE_KEY[cap];
  if (key === null) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const values = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(values)) return {};
  return { [key]: values.filter((v): v is string => typeof v === "string") } as GrantScope;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Atomic 0600 write of the whitelisted, redacted file. `now` drives the lazy
 * GC: expired entries are dropped here, on the next write (§2.3 — no timers).
 */
export function writeGrantsFile(dir: string, file: GrantsFile, opts: { env?: NodeJS.ProcessEnv; now: number }): void {
  const redactor = createRedactor(knownSecretsOf(opts.env ?? process.env));
  const body: GrantsFile = {
    version: 1,
    session: file.session,
    updated_at: opts.now,
    grants: file.grants.filter((g) => !isExpired(g, opts.now)).map((g) => sanitizeGrant(g, redactor.redact(g.note))),
  };
  writeJsonAtomic(join(dir, GRANTS_FILE), body, { mode: 0o600 });
}

/** Field whitelist: unknown fields are DROPPED, never passed through (§5.4). */
function sanitizeGrant(grant: GrantRecord, note: string): GrantRecord {
  return {
    id: grant.id,
    cap: grant.cap,
    scope: normalizeStoredScope(grant.cap, grant.scope),
    granted_at: grant.granted_at,
    granted_by: grant.granted_by,
    expires_at: grant.expires_at,
    uses_left: grant.uses_left,
    note,
  };
}

/** Expiry is evaluated at READ time (`now >= expires_at`, §2.3). */
export function isExpired(grant: Pick<GrantRecord, "expires_at">, now: number): boolean {
  return grant.expires_at !== null && now >= grant.expires_at;
}
