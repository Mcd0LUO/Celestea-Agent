/**
 * Shared HTTP helpers for the Studio handlers.
 *
 * Error bodies follow the frozen convention: `{"ok":false,"error":"<verbatim
 * source string>"}` (`contracts/endpoints.json` §conventions). Two handlers in
 * the Rust source return only `{"error":…}` (POST /api/turn's empty-input case
 * and the static/API 404); those keep their special shape and say so locally.
 */

import type { Context } from "hono";
import type { StudioServices } from "../plugins.js";
import type { StoreResult } from "../store/result.js";

/** Handler dependencies: the composed studio services. */
export type Deps = StudioServices;

export type JsonObject = Record<string, unknown>;

/** `{ok:false,error}` with the contract status (plus optional extra fields). */
export function failJson(c: Context, status: number, error: string, extra?: JsonObject): Response {
  return c.json(extra === undefined ? { ok: false, error } : { ok: false, error, ...extra }, status as never);
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
 * Read a JSON object body. Axum's rejections are mirrored:
 * missing body -> 415, unparsable -> 400, non-object -> 422.
 */
export async function readJsonBody(c: Context, required = true): Promise<BodyRead> {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    if (required) return { ok: false, response: failJson(c, 415, "request body required") };
    return { ok: true, body: {} };
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
