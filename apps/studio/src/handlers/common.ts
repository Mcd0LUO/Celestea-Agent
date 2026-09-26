/**
 * Shared HTTP helpers for the Studio handlers.
 *
 * Error bodies follow the frozen convention: `{"ok":false,"error":"<verbatim
 * source string>"}` (`contracts/endpoints.json` §conventions). Two handlers in
 * the retired backend return only `{"error":…}` (POST /api/turn's empty-input case
 * and the static/API 404); those keep their special shape and say so locally.
 */

import type { Context } from "hono";
import { CapacityError } from "../runtime-adapter.js";
import { effectiveMode } from "../store/mode.js";
import { readSessionMeta } from "../store/session-meta.js";
import type { StudioServices } from "../plugins.js";
import type { StoreResult } from "../store/result.js";

/** Handler dependencies: the composed studio services. */
export type Deps = StudioServices;

export type JsonObject = Record<string, unknown>;

/** `{ok:false,error}` with the contract status (plus optional extra fields). */
export function failJson(c: Context, status: number, error: string, extra?: JsonObject): Response {
  return c.json(extra === undefined ? { ok: false, error } : { ok: false, error, ...extra }, status as never);
}

/**
 * W513 capacity response: 503 + `Retry-After` (the engine refused to create
 * another live session or another concurrent turn, and waiting helps).
 */
export function capacityJson(c: Context, error: CapacityError): Response {
  const response = failJson(c, 503, error.message);
  response.headers.set("retry-after", String(error.retryAfterSeconds));
  return response;
}

/** Turn a store failure straight into its contract response. */
export function storeFail(c: Context, failure: Extract<StoreResult<never>, { ok: false }>): Response {
  return failJson(c, failure.status, failure.error, failure.extra);
}

/** `{error}`-only body (POST /api/turn empty input, static/API 404). */
export function errorOnly(c: Context, status: number, error: string): Response {
  return c.json({ error }, status as never);
}

export type BodyRead = { ok: true; body: JsonObject } | { ok: false; response: Response };

/**
 * W9206-36: the refusal of a cross-site write.
 *
 * Why this exists at all. Every `/api/*` write is reachable from a browser on
 * the SAME MACHINE (the default bind is loopback, and no token is configured by
 * default). A cross-origin `fetch` with `Content-Type: text/plain` is a CORS
 * **simple** request, so the browser sends it with NO preflight and the handler
 * used to run it: any page the operator visited could POST `/api/exec` and run
 * shell commands. The gate below is the server half of the fix (the other half
 * is the Content-Type check in `readJsonBody`).
 *
 * The evidence is the browser's own Fetch Metadata, which a page CANNOT
 * suppress: a cross-origin write always carries `Sec-Fetch-Site: cross-site`
 * (or `same-site`) and an `Origin` that does not match `Host`. A request that
 * carries NEITHER header is not a browser at all (curl, the CLI, the tests), and
 * absence is not forgeable from a page — so it is allowed through, which keeps
 * every non-browser client working unchanged.
 */
export const CROSS_SITE_ERROR = "cross-site request refused";

/** Methods with no side effect: a cross-site GET is not a write here. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `null` = the request may proceed; otherwise the refusal to return.
 *
 * Mounted for every `/api/*` request (see `app.ts`), so a new write endpoint
 * cannot be added without the gate.
 */
export function crossSiteRefusal(c: Context): Response | null {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return null;
  const site = (c.req.header("sec-fetch-site") ?? "").trim().toLowerCase();
  if (site !== "") {
    // The browser told us where the request came from. `none` = the user typed
    // the URL / used a bookmark (not scriptable cross-origin); `same-origin` =
    // our own page. Everything else — `cross-site`, `same-site` — is refused.
    return site === "same-origin" || site === "none" ? null : failJson(c, 403, CROSS_SITE_ERROR);
  }
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== "") {
    return originHostMatches(origin, c.req.header("host") ?? "") ? null : failJson(c, 403, CROSS_SITE_ERROR);
  }
  // No Fetch Metadata and no Origin: a non-browser client. A page cannot remove
  // either header, so this branch is unreachable from an attacking origin.
  return null;
}

/** `Origin` matches the request's own `Host` (scheme-insensitive, port-sensitive). */
function originHostMatches(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The media type of the request body, lower-cased and parameter-free. */
function mediaTypeOf(c: Context): string {
  return (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Read a JSON object body. The retired backend's rejections are mirrored:
 * missing body -> 415, unparsable -> 400, non-object -> 422.
 *
 * W9206-36: a NON-EMPTY body must declare `application/json`. Accepting any
 * Content-Type is what made the cross-site `text/plain` write a CORS simple
 * request; requiring JSON forces a preflight, which the browser then fails
 * because no CORS headers are served. The terminal's raw-text input route
 * deliberately does NOT come through here (it has its own reader).
 */
export async function readJsonBody(c: Context, required = true): Promise<BodyRead> {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    if (required) return { ok: false, response: failJson(c, 415, "request body required") };
    return { ok: true, body: {} };
  }
  if (mediaTypeOf(c) !== "application/json") {
    return { ok: false, response: failJson(c, 415, "content-type must be application/json") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, response: failJson(c, 400, "invalid JSON body") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: failJson(c, 422, "expected a JSON object body") };
  }
  return { ok: true, body: parsed as JsonObject };
}

export type FieldRead<T> = { ok: true; value: T | undefined } | { ok: false; response: Response };

/** Optional string field: absent/null -> undefined, wrong type -> 422. */
export function strField(c: Context, body: JsonObject, name: string): FieldRead<string> {
  const v = body[name];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "string") return { ok: false, response: failJson(c, 422, `field '${name}' must be a string`) };
  return { ok: true, value: v };
}

/** Optional number field (JSON numbers only; no numeric strings). */
export function numField(c: Context, body: JsonObject, name: string): FieldRead<number> {
  const v = body[name];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, response: failJson(c, 422, `field '${name}' must be a number`) };
  return { ok: true, value: v };
}

/** Optional string[] field. */
export function strArrayField(c: Context, body: JsonObject, name: string): FieldRead<string[]> {
  const v = body[name];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    return { ok: false, response: failJson(c, 422, `field '${name}' must be an array of strings`) };
  }
  return { ok: true, value: v as string[] };
}

/** Optional free-form JSON object field. */
export function objectField(c: Context, body: JsonObject, name: string): FieldRead<JsonObject> {
  const v = body[name];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, response: failJson(c, 422, `field '${name}' must be an object`) };
  return { ok: true, value: v as JsonObject };
}

/** The active session id, or null (used by /api/status, /api/clear, prompts). */
export function activeSession(deps: Deps): string | null {
  return deps.workspaces.activeSession();
}

/**
 * W729: the mode of one session (`session.json.mode`; absent/unknown = the
 * default `standard`, so a session created before this feature reads exactly as
 * it always behaved). An unresolvable id also reads as the default — the
 * endpoint that asked owns the 404.
 */
export function modeOfSession(deps: Deps, session: string | null): string {
  if (session === null || session === "") return effectiveMode(null);
  const resolved = deps.sessions.resolve(session);
  return effectiveMode(resolved.ok ? readSessionMeta(resolved.value.dir)?.mode : null);
}

/**
 * W870: does ONE session carry its OWN `session.json.model` override?
 *
 * `/api/status.model` is the session instance's profile model (global base +
 * this override, see `runtime/session-compose.ts` `profileFor`), so a client
 * cannot tell "the global default happens to equal this session's model" from
 * "this session is pinned" by looking at `model` alone. The statusline's model
 * picker needs exactly that distinction to say 「本会话已固定模型」 instead of
 * silently switching something the user cannot see. An unresolvable id (and the
 * detached/absent session) answers false — the endpoint that asked owns the 404.
 */
export function sessionModelCovered(deps: Deps, session: string | null): boolean {
  if (session === null || session === "") return false;
  const resolved = deps.sessions.resolve(session);
  if (!resolved.ok) return false;
  return (readSessionMeta(resolved.value.dir)?.model ?? "") !== "";
}