/**
 * Header handling for `http_request`: a validated request-header set and the
 * response-header subset echoed back to the caller (Rust `HEADER_SUBSET`).
 *
 * Request headers are validated once and re-applied on every redirect hop;
 * response headers are filtered to the subset that actually carries protocol
 * information (blindly echoing `set-cookie` or auth headers would leak
 * credentials into the transcript).
 */

import type { IncomingHttpHeaders } from "node:http";

import { isPlainObject } from "../schema.js";
import { httpFailure } from "./errors.js";

/** Response headers echoed back to the caller (values joined with ", "). */
export const HEADER_SUBSET: readonly string[] = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "server",
  "www-authenticate",
  "retry-after",
  "date",
];

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type HeaderPairs = ReadonlyArray<readonly [string, string]>;

/** Validate `{name: value}` request headers (throws `invalid_arg`). */
export function validateHeaderPairs(value: unknown): HeaderPairs {
  if (value === undefined) return [];
  if (!isPlainObject(value)) throw httpFailure("invalid_arg", "'headers' must be an object of strings");
  const pairs: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "string") throw httpFailure("invalid_arg", `header '${name}' value must be a string`);
    if (!HEADER_NAME.test(name)) throw httpFailure("invalid_arg", `bad header name '${name}'`);
    if (/[\r\n]/.test(raw)) throw httpFailure("invalid_arg", `header '${name}' value must not contain CR/LF`);
    pairs.push([name, raw]);
  }
  return pairs;
}

/** The subset of response headers the tool reports, in contract order. */
export function pickHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_SUBSET) {
    const value = raw[name];
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** `Content-Length`, when the server sent a usable one. */
export function headerLookup(raw: IncomingHttpHeaders, name: string): string | null {
  const value = raw[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
