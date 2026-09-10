/**
 * `http_request` error contract (`crates/tools/src/http.rs`).
 *
 * Transport failures are *categorized*, never prose-only:
 * `timeout | dns | connect | redirect | invalid_url | invalid_arg |
 * target_forbidden` — so callers and agents branch on the code. An HTTP error
 * status is NOT a failure: it comes back in `status` for the caller to judge.
 */

import { lookup } from "node:dns/promises";

import { ToolFailure } from "../tool-failure.js";

export const HTTP_ERROR_PREFIX = "http_request";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA"]);
const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"]);

/** `http_request: code=<code> msg=<message>` (Rust `contract_err` shape). */
export function httpFailure(code: string, message: string): ToolFailure {
  return new ToolFailure(code, `${HTTP_ERROR_PREFIX}: code=${code} msg=${message}`);
}

/** Marker thrown by the transport so classification can see *why* it failed. */
export class TransportError extends Error {
  readonly timedOut: boolean;
  override readonly cause: unknown;

  constructor(cause: unknown, timedOut: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransportError";
    this.cause = cause;
    this.timedOut = timedOut;
  }
}

function errnoOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Categorize a transport failure. DNS vs connect refusal is separated with a
 * best-effort lookup: a name that cannot resolve at all is `dns`, otherwise the
 * connection itself failed (`connect`).
 */
export async function classifyTransportError(e: unknown, host: string): Promise<ToolFailure> {
  const timedOut = e instanceof TransportError && e.timedOut;
  const cause = e instanceof TransportError ? e.cause : e;
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (timedOut) return httpFailure("timeout", detail);
  const errno = errnoOf(cause);
  if (errno !== null && DNS_CODES.has(errno)) return httpFailure("dns", detail);
  if (errno !== null && CONNECT_CODES.has(errno)) return httpFailure("connect", detail);
  const resolved = await resolves(host);
  return httpFailure(resolved ? "connect" : "dns", detail);
}

async function resolves(host: string): Promise<boolean> {
  if (host === "") return false;
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0;
  } catch {
    return false;
  }
}
