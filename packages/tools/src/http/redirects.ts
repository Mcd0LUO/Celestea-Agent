/**
 * Bounded, policy-checked redirect following (`crates/tools/src/http.rs`).
 *
 * The tool always follows redirects itself instead of letting the transport do
 * it, for one security reason: every hop is re-authorized against the SSRF
 * policy, so a permitted host cannot bounce the request into a denied network.
 * 301/302/303 degrade to `GET` without a body (Rust parity); the chain is
 * capped at [MAX_REDIRECT_HOPS], and a non-http(s) hop target is rejected.
 *
 * **Authorize then PIN (W738 P1)**: the check and the connect are one step. The
 * policy call returns the addresses it approved ([HttpTargetPolicy.resolveChecked])
 * and those exact addresses are handed to the transport, which connects to them
 * without resolving again — and it is repeated for EVERY hop. A host name whose
 * DNS answer changes between the check and the connect (rebinding) therefore
 * cannot be used to reach an address the policy refused.
 */

import { classifyTransportError, httpFailure } from "./errors.js";
import type { HeaderPairs } from "./headers.js";
import type { HttpTargetPolicy } from "./ssrf.js";
import { requestOnce, type TransportResult } from "./transport.js";

/** Redirect hops the tool follows before failing with `code=redirect`. */
export const MAX_REDIRECT_HOPS = 5;

export interface FetchOptions {
  method: string;
  headers: HeaderPairs;
  body: string | null;
  timeoutMs: number;
  maxBodyBytes: number;
  policy: HttpTargetPolicy;
}

/** Follow up to [MAX_REDIRECT_HOPS] redirects; returns the final response. */
export async function fetchWithPolicy(url: URL, options: FetchOptions): Promise<TransportResult> {
  let current = url;
  let method = options.method;
  let body = options.body;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const checked = await options.policy.resolveChecked(current.toString());
    if (checked.reason !== null) throw httpFailure("target_forbidden", checked.reason);
    const result = await sendOnce(current, method, body, options, checked.ips);
    if (!isRedirect(result.status) || result.location === null) return result;
    if (hop === MAX_REDIRECT_HOPS) {
      throw httpFailure("redirect", `redirect chain longer than ${MAX_REDIRECT_HOPS} hops`);
    }
    const next = nextHop(current, result.location);
    if (result.status === 301 || result.status === 302 || result.status === 303) {
      method = "GET";
      body = null;
    }
    current = next;
  }
  throw httpFailure("redirect", `redirect chain longer than ${MAX_REDIRECT_HOPS} hops`);
}

async function sendOnce(
  url: URL,
  method: string,
  body: string | null,
  options: FetchOptions,
  pinnedIps: readonly string[],
): Promise<TransportResult> {
  try {
    return await requestOnce({
      url,
      method,
      headers: options.headers,
      body,
      timeoutMs: options.timeoutMs,
      maxBodyBytes: options.maxBodyBytes,
      pinnedIps,
    });
  } catch (e) {
    throw await classifyTransportError(e, url.hostname);
  }
}

function nextHop(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw httpFailure("redirect", `unparseable redirect location '${location}'`);
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw httpFailure("invalid_url", `redirect to scheme '${next.protocol.replace(":", "")}' not allowed`);
  }
  return next;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
