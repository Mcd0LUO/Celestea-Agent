/**
 * Request parsing / response shaping for the grant endpoints (W516 §6).
 *
 * Kept apart from the routes so both stay inside the architecture budget: the
 * error strings here are the FROZEN contract strings of §6.2, and a rejected
 * scope value is never echoed (§5.4 — it may be a credential).
 */

import type { Context } from "hono";
import type { EffectiveGrants } from "../runtime/engine-grants.js";
import { unsandboxedAvailable } from "../runtime/engine-grants.js";
import {
  DEFAULT_TTL_SEC,
  GRANT_CAPS,
  MAX_TTL_SEC,
  canonicalScopeHash,
  knownSecretsOf,
  looksLikeCredential,
  validateScope,
  type GrantCap,
  type GrantRecord,
  type GrantScope,
} from "../store/grants.js";
import { failJson, numField, objectField, strField, type JsonObject } from "./common.js";

/** Who the grant is attributed to. Server-side constant: never model text. */
export const GRANT_ACTOR = "ui:operator";

export interface GrantRequest {
  cap: GrantCap;
  scope: GrantScope;
  ttlSec: number;
  usesLeft: number | null;
  note: string;
  /** Canonical hash of `(cap, scope)` — what the confirm token is bound to. */
  scopeHash: string;
}

/** A refused body: the response to send plus the SANITIZED reason to audit. */
export type GrantRequestBody = { ok: true; value: GrantRequest } | { ok: false; response: Response; reason: string };

/** §6.2 body: `{cap, scope?, ttl_sec?, uses_left?, note?}` + the frozen 400s. */
export function parseGrantRequest(c: Context, body: JsonObject, env: NodeJS.ProcessEnv): GrantRequestBody {
  const known = knownSecretsOf(env);
  const cap = strField(c, body, "cap");
  if (!cap.ok) return { ok: false, response: cap.response, reason: "field 'cap' must be a string" };
  const raw = cap.value ?? "";
  const chosen = offeredCap(raw, env);
  if (chosen === null) {
    const shown = looksLikeCredential(raw, known) ? "<redacted>" : raw;
    return { ok: false, response: failJson(c, 400, `invalid cap '${shown}'`), reason: `invalid cap '${shown}'` };
  }
  const ttl = readTtl(c, body, chosen);
  if (typeof ttl !== "number") return { ok: false, response: ttl, reason: "ttl_sec out of range" };
  const scope = readScope(c, body, chosen, known);
  if (!scope.ok) return { ok: false, response: scope.response, reason: scope.reason };
  const uses = readUses(c, body, chosen);
  if (typeof uses === "string") return { ok: false, response: failJson(c, 400, uses), reason: uses };
  const note = strField(c, body, "note");
  if (!note.ok) return { ok: false, response: note.response, reason: "field 'note' must be a string" };
  // §5.4 + scenario 15: a note is user text, but a credential shape is refused
  // outright (the frozen 400 string) and is never echoed back anywhere.
  if (note.value !== undefined && looksLikeCredential(note.value, known)) {
    return { ok: false, response: failJson(c, 400, "value looks like a credential"), reason: "value looks like a credential" };
  }
  return {
    ok: true,
    value: {
      cap: chosen,
      scope: scope.value,
      ttlSec: ttl,
      usesLeft: uses,
      note: note.value ?? "",
      scopeHash: canonicalScopeHash(chosen, scope.value),
    },
  };
}

/**
 * The cap must be known AND offered here: `unsandboxed` only exists behind
 * `CELESTEA_GRANTS_ALLOW_UNSANDBOXED=1` (§2.2), so without it the cap is simply
 * not valid — the frozen `invalid cap '<x>'` error, never a special case.
 */
export function offeredCap(raw: string, env: NodeJS.ProcessEnv): GrantCap | null {
  const known = (GRANT_CAPS as readonly string[]).includes(raw);
  if (!known) return null;
  if (raw === "unsandboxed" && !unsandboxedAvailable(env)) return null;
  return raw as GrantCap;
}

/** `ttl_sec`: positive integer, 0 = no expiry, capped per cap (§2.3). */
export function readTtl(c: Context, body: JsonObject, cap: GrantCap): number | Response {
  const field = numField(c, body, "ttl_sec");
  if (!field.ok) return field.response;
  const ttl = field.value ?? DEFAULT_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl < 0) return failJson(c, 400, "ttl_sec must be a non-negative integer (0 = no expiry)");
  if (ttl > MAX_TTL_SEC[cap]) return failJson(c, 400, `ttl_sec exceeds the maximum for cap '${cap}' (${MAX_TTL_SEC[cap]})`);
  return ttl;
}

function readScope(
  c: Context,
  body: JsonObject,
  cap: GrantCap,
  known: readonly string[],
): { ok: true; value: GrantScope } | { ok: false; response: Response; reason: string } {
  const field = objectField(c, body, "scope");
  if (!field.ok) return { ok: false, response: field.response, reason: "field 'scope' must be an object" };
  const scope = validateScope(cap, field.value, known);
  if (!scope.ok) {
    const reason = `invalid scope for cap '${cap}': ${scope.error}`;
    return { ok: false, response: failJson(c, 400, reason), reason };
  }
  return { ok: true, value: scope.scope };
}

/** `uses_left`: positive integer or null; `unsandboxed` is forced to 1 (§2.3). */
function readUses(c: Context, body: JsonObject, cap: GrantCap): number | null | string {
  if (cap === "unsandboxed") return 1;
  const field = numField(c, body, "uses_left");
  if (!field.ok) return "uses_left must be a positive integer";
  const value = field.value;
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) return "uses_left must be a positive integer";
  return value;
}

/** One GET entry: the stored record plus the read-time `expired` flag (§6.1). */
export function entryJson(record: GrantRecord, now: number): JsonObject {
  const expired = record.expires_at !== null && now >= record.expires_at;
  return {
    id: record.id,
    cap: record.cap,
    scope: record.scope,
    granted_at: record.granted_at,
    granted_by: record.granted_by,
    expires_at: record.expires_at,
    uses_left: record.uses_left,
    note: record.note,
    expired,
  };
}

/** The `effective` snapshot of §6.1 (snake_case; the UI shows it verbatim). */
export function effectiveJson(grants: EffectiveGrants): JsonObject {
  return {
    network: grants.network,
    read_roots: [...grants.readRoots],
    write_roots: [...grants.writeRoots],
    net_hosts: [...grants.netHosts],
    tool_extra: [...grants.toolExtra],
    unsandboxed: grants.unsandboxed,
  };
}
