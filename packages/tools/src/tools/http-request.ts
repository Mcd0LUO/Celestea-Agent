/**
 * `http_request` — guarded HTTP(S) fetch (`crates/tools/src/http.rs`).
 *
 * Only http/https targets, redirects capped at 5 hops, body truncated at 1 MiB
 * (`truncated: true` beyond), transport failures categorized
 * (`timeout | dns | connect | redirect | invalid_url | invalid_arg |
 * target_forbidden`). HTTP error statuses are NOT tool errors: the caller gets
 * `{status, headers, body, truncated}` and decides.
 *
 * SSRF: when `CELESTEA_HTTP_ALLOW` / `CELESTEA_HTTP_DENY` are set, every
 * resolved target IP — and every redirect hop — must pass the policy; an
 * unparseable policy fails closed.
 */

import type { Tool, ToolSpec } from "@celestea/core";

import { optionalIntArg, optionalRecordArg, optionalStringArg, stringArg } from "../args.js";
import { contractFailure } from "../errors.js";
import { fnTool } from "../fn-tool.js";
import { httpFailure } from "../http/errors.js";
import { validateHeaderPairs } from "../http/headers.js";
import { fetchWithPolicy } from "../http/redirects.js";
import { HttpTargetPolicy } from "../http/ssrf.js";

/** Response body cap (1 MiB); beyond this `truncated: true`. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Maximum per-request timeout (ms). */
export const MAX_TIMEOUT_MS = 60_000;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]);

export interface HttpRequestToolOptions {
  /** Target policy; default: `HttpTargetPolicy.fromEnv(env)`. */
  policy?: HttpTargetPolicy;
  maxBodyBytes?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function httpRequestSpec(): ToolSpec {
  return {
    name: "http_request",
    description:
      "Send an HTTP(S) request and return {status, headers(subset), body, truncated}. Only http/https URLs are allowed (file:// etc. rejected); redirects are followed up to 5 hops; the response body is truncated at 1MB (truncated:true beyond). HTTP error statuses are preserved in `status` — not tool errors; transport failures are categorized as timeout | dns | connect | redirect | invalid_url | invalid_arg | target_forbidden. SSRF policy: when CELESTEA_HTTP_ALLOW / CELESTEA_HTTP_DENY (comma-separated IP/CIDR) are set, every resolved target IP — and every redirect hop — must pass them; default (unset) allows all hosts.",
    parameters: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
          description: "HTTP method (default GET).",
        },
        url: { type: "string", description: "Target URL; only http/https schemes are allowed." },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional request headers as {name: value}.",
        },
        body: { type: "string", description: "Optional request body string." },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout in milliseconds (default 15000, maximum 60000).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

export function httpRequestTool(options: HttpRequestToolOptions = {}): Tool {
  const policy = options.policy ?? HttpTargetPolicy.fromEnv(options.env ?? process.env);
  const limits = {
    maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: options.maxTimeoutMs ?? MAX_TIMEOUT_MS,
  };
  return fnTool(httpRequestSpec(), async (args) => {
    const url = parseUrl(stringArg(args, "url"));
    const result = await fetchWithPolicy(url, {
      method: parseMethod(optionalStringArg(args, "method")),
      headers: validateHeaderPairs(optionalRecordArg(args, "headers")),
      body: optionalStringArg(args, "body") ?? null,
      timeoutMs: parseTimeout(optionalIntArg(args, "timeout_ms"), limits),
      maxBodyBytes: limits.maxBodyBytes,
      policy,
    });
    return {
      ok: true,
      status: result.status,
      headers: result.headers,
      body: result.body,
      truncated: result.truncated,
    };
  });
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw httpFailure("invalid_url", `unparseable url: ${raw}`);
  }
  const scheme = url.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    throw httpFailure("invalid_url", `scheme '${scheme}' not allowed (only http/https)`);
  }
  return url;
}

function parseMethod(raw: string | undefined): string {
  if (raw === undefined) return "GET";
  const method = raw.toUpperCase();
  if (!HTTP_METHODS.has(method)) throw contractFailure("http_request", "invalid_arg", `unsupported method: ${method}`);
  return method;
}

function parseTimeout(raw: number | undefined, limits: { defaultTimeoutMs: number; maxTimeoutMs: number }): number {
  if (raw === undefined) return limits.defaultTimeoutMs;
  if (raw < 1) throw contractFailure("http_request", "invalid_arg", `timeout_ms must be >= 1, got ${raw}`);
  if (raw > limits.maxTimeoutMs) {
    throw contractFailure("http_request", "invalid_arg", `timeout_ms=${raw} exceeds the maximum ${limits.maxTimeoutMs}ms`);
  }
  return raw;
}
