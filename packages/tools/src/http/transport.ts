/**
 * One HTTP(S) hop over `node:http` / `node:https` (`crates/tools/src/http.rs`).
 *
 * Deliberately low-level: no ambient proxy from the environment (`no_proxy`
 * parity), no automatic redirect following (the caller caps hops at 5 and
 * re-checks every hop against the SSRF policy), a total per-call deadline, and
 * a hard cap on the buffered body — bytes past the cap are dropped, the socket
 * is torn down, and `truncated: true` is reported instead of flooding the
 * context.
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { TransportError } from "./errors.js";
import { headerLookup, pickHeaders, type HeaderPairs } from "./headers.js";

export interface TransportRequest {
  url: URL;
  method: string;
  headers: HeaderPairs;
  body: string | null;
  timeoutMs: number;
  maxBodyBytes: number;
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
    const request = send(
      req.url,
      { method: req.method, headers: Object.fromEntries(req.headers), timeout: 0 },
      (response) => collectBody(response, req.maxBodyBytes, finish, fail),
    );
    request.on("error", fail);
    if (req.body !== null && req.body !== "") request.write(req.body);
    request.end();
  });
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
