/**
 * `StoreResult` — how every data-store operation reports failure.
 *
 * The HTTP layer must reproduce the Rust error strings verbatim together with
 * their status code, so a store never throws for an expected failure: it
 * returns `{ok:false, status, error}` and the handler turns that into
 * `{ok:false, error}` with the status. Store *bugs* still throw.
 */

export interface StoreFailure {
  ok: false;
  /** HTTP status the contract assigns to this failure. */
  status: number;
  /** Verbatim contract text (Rust `format!` template filled in). */
  error: string;
  /** Extra fields folded into the response body (fs/browse uses `path`). */
  extra?: Record<string, unknown>;
}

export type StoreResult<T> = { ok: true; value: T } | StoreFailure;

export function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

export function fail<T>(status: number, error: string, extra?: Record<string, unknown>): StoreResult<T> {
  return extra === undefined ? { ok: false, status, error } : { ok: false, status, error, extra };
}

export function badRequest<T>(error: string): StoreResult<T> {
  return fail<T>(400, error);
}

export function notFound<T>(error: string): StoreResult<T> {
  return fail<T>(404, error);
}

export function conflict<T>(error: string): StoreResult<T> {
  return fail<T>(409, error);
}

export function serverError<T>(message: string): StoreResult<T> {
  return fail<T>(500, message);
}

/** `Error` -> message, for the `{e}` placeholders in contract error strings. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
