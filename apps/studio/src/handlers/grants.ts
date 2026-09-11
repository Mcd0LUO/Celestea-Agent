/**
 * The four grant endpoints (W516 §6): read the session's grants, grant one, a
 * revoke, and the one-shot confirm token that makes a grant a HUMAN action.
 *
 * Threat model in one line: the session's own tools can read/write its
 * directory and can reach `127.0.0.1`, so a grant may not be a plain POST. A
 * POST needs `X-Celestea-Grant-Confirm`, that token only comes from the
 * same-origin-only token endpoint, and it is bound to `(session, cap,
 * scope_hash)`, lives 60s and burns on first use (§5.5).
 *
 * Every grant / revoke / refusal is audited twice (§4.4): the local
 * append-only `grants-audit.jsonl` is authoritative, the platform channel is
 * best-effort and its failures are recorded locally as `platform_audit_failed`.
 */

import type { Context, Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { effectiveGrantsOf, sessionIdOfDir, unsandboxedAvailable, type EffectiveGrants } from "../runtime/engine-grants.js";
import { MAX_TTL_SEC, emptyGrantsFile, newGrantId, readGrantsFile, writeGrantsFile, type GrantCap, type GrantRecord, type GrantsFile } from "../store/grants.js";
import { CONFIRM_HEADER, SEC_FETCH_MODE, SEC_FETCH_SITE, ORIGIN_HEADER } from "../store/grants-tokens.js";
import { nowSec, type GrantsServices } from "../store/grants-service.js";
import { errText } from "../store/result.js";
import { entryJson, effectiveJson, parseGrantRequest, GRANT_ACTOR, type GrantRequest } from "./grants-shape.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

const NOT_SAME_ORIGIN_TOO = "grant confirmation is not available over this transport";
const CONFIRM_REQUIRED = "grant confirmation required";

/** GET /api/sessions/{id}/grants (§6.1). */
function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_grants");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const seconds = nowSec(deps.grants);
    const read = readGrantsFile(resolved.value.dir, resolved.value.id);
    const effective = effectiveGrantsOf(resolved.value.dir, deps.grants.env, seconds);
    const grants = (read.file?.grants ?? []).map((grant) => entryJson(grant, seconds));
    return c.json({
      ok: true,
      session: resolved.value.id,
      grants,
      effective: effectiveJson(effective.grants),
      max_ttl_sec: MAX_TTL_SEC,
      unsandboxed_available: unsandboxedAvailable(deps.grants.env),
      ...(effective.warnings.length === 0 ? {} : { warnings: effective.warnings }),
    });
  });
  return route.id;
}

/** POST /api/sessions/{id}/grants (§6.2) — replace-by-cap, one cap one set. */
function registerCreate(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_grants");
  app.on(route.method, route.honoPath, async (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const sessionId = resolved.value.id;
    const services = deps.grants;
    const limit = services.limits.allow(sessionId);
    if (!limit.ok) return failJson(c, limit.status, limitMessage(limit), { retry_after: limit.retryAfterSec });
    const read = await readJsonBody(c);
    if (!read.ok) return denied(c, deps, sessionId, read.response);
    const request = parseGrantRequest(c, read.body, services.env);
    if (!request.ok) return denied(c, deps, sessionId, request.response);
    const token = c.req.header(CONFIRM_HEADER) ?? "";
    if (token === "") return denied(c, deps, sessionId, failJson(c, 403, CONFIRM_REQUIRED));
    const verdict = services.tokens.consume(sessionId, request.value.cap, request.value.scopeHash, token);
    if (verdict === "invalid") return denied(c, deps, sessionId, failJson(c, 403, CONFIRM_REQUIRED));
    if (verdict === "used") return denied(c, deps, sessionId, failJson(c, 409, "confirmation token already used"));
    return persistGrant(c, deps, resolved.value.dir, sessionId, request.value);
  });
  return route.id;
}

/** §6.2 `429` / `409` bodies carry the remaining seconds. */
function limitMessage(limit: { status: 429 | 409; retryAfterSec: number }): string {
  if (limit.status === 429) return `too many grant requests; retry in ${limit.retryAfterSec}s`;
  return `a grant request was just denied; retry in ${limit.retryAfterSec}s`;
}

/** Store the grant, bump the session's epoch, audit, answer (§6.2). */
function persistGrant(c: Context, deps: Deps, dir: string, sessionId: string, request: GrantRequest): Response {
  const services = deps.grants;
  const seconds = nowSec(services);
  const existing = readGrantsFile(dir, sessionId);
  if (existing.exists && existing.file === undefined) {
    services.audit.write({ session: sessionId, event: "grants_unreadable", reason: existing.error ?? "unreadable" });
  }
  const base = existing.file ?? emptyGrantsFile(sessionId, seconds);
  const record: GrantRecord = {
    id: newGrantId(),
    cap: request.cap,
    scope: request.scope,
    granted_at: seconds,
    granted_by: GRANT_ACTOR,
    expires_at: request.ttlSec === 0 ? null : seconds + request.ttlSec,
    uses_left: request.usesLeft,
    note: request.note,
  };
  const file: GrantsFile = { version: 1, session: sessionId, updated_at: seconds, grants: upsert(base, record) };
  try {
    writeGrantsFile(dir, file, { env: services.env, now: seconds });
  } catch (e) {
    return failJson(c, 500, `cannot persist grants: ${errText(e)}`);
  }
  deps.runtime.invalidateSession?.(sessionId);
  const effective = effectiveGrantsOf(dir, services.env, seconds);
  services.audit.write({
    session: sessionId,
    event: "grant",
    grant_id: record.id,
    cap: record.cap,
    scope: record.scope,
    actor: GRANT_ACTOR,
    expires_at: record.expires_at,
    uses_left: record.uses_left,
    effective_after: effectiveJson(effective.grants),
  });
  services.limits.recordSuccess(sessionId);
  return c.json({ ok: true, grant: entryJson(record, seconds), effective: effectiveJson(effective.grants) });
}

/** §6.2: one cap holds exactly one live entry — replace, never stack. */
function upsert(file: GrantsFile, record: GrantRecord): GrantRecord[] {
  return [...file.grants.filter((grant) => grant.cap !== record.cap), record];
}

/** DELETE /api/sessions/{id}/grants (§6.3) — no token: revoking is safe. */
function registerRevoke(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("delete_session_grants");
  app.on(route.method, route.honoPath, async (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const read = await readJsonBody(c, false);
    if (!read.ok) return read.response;
    const cap = strField(c, read.body, "cap");
    if (!cap.ok) return cap.response;
    const grantId = strField(c, read.body, "grant_id");
    if (!grantId.ok) return grantId.response;
    return revoke(c, deps, { dir: resolved.value.dir, sessionId: resolved.value.id, cap: cap.value, grantId: grantId.value });
  });
  return route.id;
}

interface RevokeTarget {
  dir: string;
  sessionId: string;
  cap: string | undefined;
  grantId: string | undefined;
}

/** Remove the matching entries (all of them when nothing is named). */
function revoke(c: Context, deps: Deps, target: RevokeTarget): Response {
  const { dir, sessionId, cap, grantId } = target;
  const services = deps.grants;
  const seconds = nowSec(services);
  const read = readGrantsFile(dir, sessionId);
  if (read.exists && read.file === undefined) {
    services.audit.write({ session: sessionId, event: "grants_unreadable", reason: read.error ?? "unreadable" });
  }
  const entries = read.file?.grants ?? [];
  const matches = (grant: GrantRecord): boolean =>
    (cap === undefined || grant.cap === cap) && (grantId === undefined || grant.id === grantId);
  const revoked = entries.filter(matches);
  const file: GrantsFile = { version: 1, session: sessionId, updated_at: seconds, grants: entries.filter((g) => !matches(g)) };
  if (revoked.length > 0) {
    try {
      writeGrantsFile(dir, file, { env: services.env, now: seconds });
    } catch (e) {
      return failJson(c, 500, `cannot persist grants: ${errText(e)}`);
    }
    deps.runtime.invalidateSession?.(sessionId);
  }
  const effective = effectiveGrantsOf(dir, services.env, seconds);
  for (const grant of revoked) {
    services.audit.write({ session: sessionId, event: "revoke", grant_id: grant.id, cap: grant.cap, actor: GRANT_ACTOR, effective_after: effectiveJson(effective.grants) });
  }
  return c.json({ ok: true, revoked: revoked.map((grant) => grant.id), effective: effectiveJson(effective.grants) });
}

/** GET /api/sessions/{id}/grants/confirm-token (§6.4) — same-origin only. */
function registerConfirmToken(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_grants_confirm_token");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    if (!hasSameOriginEvidence(c)) return failJson(c, 403, NOT_SAME_ORIGIN_TOO);
    const cap = c.req.query("cap") ?? "";
    const allowed = (["network", "read_roots", "write_roots", "net_hosts", "tool_extra", "unsandboxed"] as const).includes(cap as never);
    if (!allowed || (cap === "unsandboxed" && !unsandboxedAvailable(deps.grants.env))) return failJson(c, 400, `invalid cap '${cap}'`);
    const hash = c.req.query("scope_hash") ?? "";
    if (!/^[0-9a-f]{64}$/.test(hash)) return failJson(c, 400, "scope_hash must be a 64-char sha256 hex string");
    const issued = deps.grants.tokens.issue(resolved.value.id, cap, hash);
    return c.json({ ok: true, token: issued.token, expires_at: issued.expiresAt });
  });
  return route.id;
}

/**
 * §5.5.2: a browser navigation/XHR from our own origin, and nothing a session
 * tool can forge. `Sec-Fetch-Site: same-origin` is the strong evidence; the
 * CORS fallback additionally requires an Origin that matches Host.
 */
function hasSameOriginEvidence(c: Context): boolean {
  if ((c.req.header(SEC_FETCH_SITE) ?? "").toLowerCase() === "same-origin") return true;
  if ((c.req.header(SEC_FETCH_MODE) ?? "").toLowerCase() !== "cors") return false;
  const origin = c.req.header(ORIGIN_HEADER) ?? "";
  const host = c.req.header("host") ?? "";
  if (origin === "") return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** A refused grant counts toward the 3-strikes cooldown (§5.5.5). */
function denied(c: Context, deps: Deps, sessionId: string, response: Response): Response {
  deps.grants.limits.recordDenial(sessionId);
  return response;
}

export function registerGrants(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [
    registerList(app, deps, table),
    registerCreate(app, deps, table),
    registerRevoke(app, deps, table),
    registerConfirmToken(app, deps, table),
  ];
}

export type { EffectiveGrants, GrantsServices };
