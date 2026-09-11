/**
 * One HTTP(S) hop over `node:http` / `node:https` (`crates/tools/src/http.rs`).
 *
 * Deliberately low-level: no ambient proxy from the environment (`no_proxy`
 * parity), no automatic redirect following (the caller caps hops at 5 and
 * re-checks every hop against the SSRF policy), a total per-call deadline, and
 * a hard cap on the buffered body — bytes past the cap are dropped, the socket
 * is torn down, and `truncated: true` is reported instead of flooding the
 * context.
 *
 * **Address pinning (W738 P1)**: the SSRF verdict is only worth something if the
 * socket connects to the address that was checked. When `pinnedIps` is given,
 * the request carries a custom `lookup` that answers from that list and never
 * touches the resolver, so the connection cannot be re-bound to a different (for
 * example internal) address between check and use. The URL, `Host` header and
 * TLS `servername` stay exactly as before — only the address source changes.
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

import { TransportError } from "./errors.js";
import { headerLookup, pickHeaders, type HeaderPairs } from "./headers.js";

export interface TransportRequest {
  url: URL;
  method: string;
  headers: HeaderPairs;
  body: string | null;
  timeoutMs: number;
  maxBodyBytes: number;
  /**
   * Addresses the SSRF policy approved for THIS hop (W738). When present the
   * connection must use one of them — the transport's own DNS is bypassed — so a
   * second, different resolution can never carry the request to another host.
   */
  pinnedIps?: readonly string[];
}

export interface TransportResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  /** Raw `Location` value; redirect targets are resolved by the caller. */
  location: string | null;
}

type Finish = (value: TransportResult) => void;
type Fail = (error: unknown) => void;

/** Perform exactly one request (no redirect following) and capture the body. */
export async function requestOnce(req: TransportRequest): Promise<TransportResult> {
  const send = req.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<TransportResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error(`request timed out after ${req.timeoutMs}ms`));
    }, req.timeoutMs);
    const finish: Finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail: Fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TransportError(error, timedOut));
    };
    const request = send(req.url, requestOptions(req), (response) =>
      collectBody(response, req.maxBodyBytes, finish, fail),
    );
    request.on("error", fail);
    if (req.body !== null && req.body !== "") request.write(req.body);
    request.end();
  });
}

/** Wire options for one hop; `lookup` is only overridden when addresses are pinned. */
function requestOptions(req: TransportRequest): RequestOptions {
  const options: RequestOptions = { method: req.method, headers: Object.fromEntries(req.headers), timeout: 0 };
  if (req.pinnedIps !== undefined) options.lookup = pinnedLookup(req.pinnedIps);
  return options;
}

/**
 * A `lookup` replacement that answers from an already-authorized address list.
 * It never resolves anything: an empty list (or a family filter that matches
 * none of the pinned addresses) is a hard `ENOTFOUND`, never a fallback to the
 * platform resolver — a silent fallback would re-open the rebinding hole.
 */
export function pinnedLookup(pinned: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = familyOf(options);
    const usable = family === 0 ? [...pinned] : pinned.filter((ip) => isIP(ip) === family);
    if (usable.length === 0) {
      const error: NodeJS.ErrnoException = new Error("no pinned address matches the requested family (ssrf pin)");
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if ((options as { all?: unknown }).all === true) {
      callback(null, usable.map((address) => ({ address, family: isIP(address) })));
      return;
    }
    const [first = ""] = usable;
    callback(null, first, isIP(first));
  };
}

/** `4` / `6` when the caller demanded a family, else `0` (any). */
function familyOf(options: unknown): number {
  const raw = typeof options === "number" ? options : (options as { family?: unknown } | null)?.family;
  if (raw === 4 || raw === "IPv4") return 4;
  if (raw === 6 || raw === "IPv6") return 6;
  return 0;
}

function collectBody(response: IncomingMessage, cap: number, finish: Finish, fail: Fail): void {
  const status = response.statusCode ?? 0;
  const headers = pickHeaders(response.headers);
  const location = headerLookup(response.headers, "location");
  const chunks: Buffer[] = [];
  let size = 0;
  response.on("data", (chunk: Buffer) => {
    const room = cap - size;
    if (chunk.length < room) {
      chunks.push(chunk);
      size += chunk.length;
      return;
    }
    if (room > 0) chunks.push(chunk.subarray(0, room));
    response.destroy();
    finish({ status, headers, body: Buffer.concat(chunks).toString("utf8"), truncated: true, location });
  });
  response.on("end", () => {
    finish({ status, headers, body: Buffer.concat(chunks).toString("utf8"), truncated: false, location });
  });
  response.on("error", fail);
}
