/**
 * HTTP transport for the streaming request (P2a).
 *
 * Owns the two pre-stream guards of the three-tier timeout contract:
 *   * connect timeout      — the TCP/TLS handshake must complete in time;
 *   * response-header time — send() -> response headers must arrive in time.
 * Beyond the headers the body is guarded per chunk by the stream idle timeout
 * (see stream.ts). There is deliberately NO total-request timeout, so a long
 * generation is never killed by a pre-stream guard.
 *
 * The API key rides only in the request's Authorization header; error messages
 * carry the HTTP status plus a body snippet, never a credential.
 */

import http from "node:http";
import https from "node:https";

import { connectTimeoutError, LlmError, responseHeaderTimeoutError } from "./errors.js";

/** Max bytes of a non-2xx body echoed in the error message. */
export const ERROR_BODY_SNIPPET_BYTES = 2048;

export interface SendOptions {
  url: string;
  apiKey: string;
  body: string;
  /** null = connect guard disabled. */
  connectMs: number | null;
  /** null = response-header guard disabled. */
  responseMs: number | null;
}

/** Settle-once state machine owning the pending timers and the request. */
class StageGuard {
  #settled = false;
  #timers: NodeJS.Timeout[] = [];
  #request: http.ClientRequest | null = null;
  readonly #reject: (err: Error) => void;

  constructor(reject: (err: Error) => void) {
    this.#reject = reject;
  }

  attach(request: http.ClientRequest): void {
    this.#request = request;
  }

  settle(fn: () => void): void {
    if (this.#settled) return;
    this.#settled = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.length = 0;
    fn();
  }

  /** Reject with a timeout/transport error and tear the request down. */
  abort(err: Error): void {
    if (this.#settled) return;
    const request = this.#request;
    this.settle(() => this.#reject(err));
    request?.destroy();
  }

  /** Abort when the TCP/TLS handshake has not completed within `ms`. */
  armConnect(ms: number | null, url: string): void {
    if (ms === null) return;
    let connected = false;
    this.#request?.on("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => (connected = true));
      else connected = true;
    });
    this.#timers.push(
      setTimeout(() => {
        if (!connected) this.abort(connectTimeoutError(ms, url));
      }, ms),
    );
  }

  /** Abort when the response headers have not arrived within `ms`. */
  armResponse(ms: number | null, url: string): void {
    if (ms === null) return;
    this.#timers.push(
      setTimeout(() => {
        this.abort(responseHeaderTimeoutError(ms, url));
      }, ms),
    );
  }
}

function requestHeaders(options: SendOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "content-length": String(Buffer.byteLength(options.body)),
    authorization: `Bearer ${options.apiKey}`,
  };
}

/** POST the request; resolve once the response HEADERS are in. */
export async function sendChatRequest(options: SendOptions): Promise<http.IncomingMessage> {
  const parsed = new URL(options.url);
  const transport = parsed.protocol === "https:" ? https : http;

  return await new Promise<http.IncomingMessage>((resolve, reject) => {
    const guard = new StageGuard(reject);
    const request = transport.request(
      parsed,
      { method: "POST", headers: requestHeaders(options), agent: false },
      (response) => guard.settle(() => resolve(response)),
    );
    guard.attach(request);
    request.on("error", (err: Error) => {
      guard.settle(() => reject(new LlmError(`failed to start stream: ${err.message}`, "generate")));
    });
    guard.armConnect(options.connectMs, options.url);
    guard.armResponse(options.responseMs, options.url);
    request.end(options.body);
  });
}

/** Read at most `limit` bytes of a body for error reporting. */
export async function readBodySnippet(
  response: http.IncomingMessage,
  limit: number = ERROR_BODY_SNIPPET_BYTES,
): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      parts.push(buf);
      size += buf.byteLength;
      if (size >= limit) break;
    }
  } catch {
    // Best effort: an unreadable body still yields a status-bearing error.
  }
  return Buffer.concat(parts).subarray(0, limit).toString("utf8");
}

/** "500 Internal Server Error" style label for an error message. */
export function httpStatusLabel(status: number, statusText: string | undefined): string {
  return statusText === undefined || statusText === "" ? String(status) : `${status} ${statusText}`;
}

/** Belt-and-braces: never let a credential-shaped token ride out in an error. */
export function redact(text: string): string {
  return text.replace(/\b(sk|Bearer)[-_A-Za-z0-9]{8,}/g, "<redacted>");
}
