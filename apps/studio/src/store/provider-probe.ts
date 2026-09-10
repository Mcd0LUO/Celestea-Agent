/**
 * Provider model probe — `/api/providers/test` and
 * `/api/providers/{id}/models/fetch` (`src/providers.rs:523-553,725-776`).
 *
 * Two rules carry the security weight:
 *   1. **keyless same-origin borrow** — a provider with NO key whose
 *      normalized `base_url` equals the CURRENT generation's `base_url` may
 *      borrow the engine's own key for that one request. The borrowed key is
 *      never persisted, never echoed and never logged;
 *   2. a keyless NON-same-origin provider reports `该提供商未配置 api_key`
 *      WITHOUT issuing a request at all (no key ever leaves the process for a
 *      provider that never had one).
 *
 * The HTTP client is injected so the contract is testable without network.
 */

import { normalizeBaseUrl } from "./providers.js";
import { errText } from "./result.js";
import type { RequestFormat } from "./providers.js";

export const UNSUPPORTED_FORMAT = "该请求格式暂不支持自动测试";
export const NO_API_KEY = "该提供商未配置 api_key";

export interface ProbeResponse {
  status: number;
  text(): Promise<string>;
}

export interface ProbeInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type ProbeFetch = (url: string, init: ProbeInit) => Promise<ProbeResponse>;

export interface ProbeCandidate {
  id: string;
  base_url: string;
  request_format: RequestFormat;
  api_key: string | null;
}

export interface ProbeOptions {
  /** Defaults to the global fetch; tests inject a recorder. */
  fetch?: ProbeFetch;
  /** The CURRENT generation's base_url + key (borrow source). */
  engineBaseUrl: string;
  engineKey: string | null;
  timeoutMs?: number;
}

export interface ProbeOutcome {
  ok: boolean;
  models?: Array<{ id: string }>;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function head(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n);
}

/** Which key a probe would use, and whether it was borrowed. NEVER logged. */
export function resolveProbeKey(candidate: ProbeCandidate, opts: ProbeOptions): { key: string | null; borrowed: boolean } {
  const own = candidate.api_key;
  if (typeof own === "string" && own !== "") return { key: own, borrowed: false };
  const sameOrigin = normalizeBaseUrl(candidate.base_url) === normalizeBaseUrl(opts.engineBaseUrl);
  if (sameOrigin && opts.engineKey !== null && opts.engineKey !== "") return { key: opts.engineKey, borrowed: true };
  return { key: null, borrowed: false };
}

function parseModels(text: string): Array<{ id: string }> | null {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const rows = Array.isArray(body) ? body : (body as { data?: unknown }).data;
  if (!Array.isArray(rows)) return null;
  const out: Array<{ id: string }> = [];
  for (const row of rows) {
    const id = typeof row === "object" && row !== null ? (row as Record<string, unknown>)["id"] : undefined;
    if (typeof id === "string" && id !== "") out.push({ id });
  }
  return out;
}

/** GET `<base_url>/models`; every failure is a 200 body with `ok:false`. */
export async function probeModels(candidate: ProbeCandidate, opts: ProbeOptions): Promise<ProbeOutcome> {
  if (candidate.request_format !== "chat_completions") return { ok: false, error: UNSUPPORTED_FORMAT };
  if ((candidate.base_url ?? "").trim() === "") return { ok: false, error: "base_url is required" };
  const { key } = resolveProbeKey(candidate, opts);
  if (key === null) return { ok: false, error: NO_API_KEY };
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as ProbeFetch);
  const url = `${candidate.base_url.replace(/\/+$/, "")}/models`;
  let res: ProbeResponse;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `summary response read failed: ${errText(e)}` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `HTTP ${res.status}: ${head(text, 300)}` };
  }
  const models = parseModels(text);
  if (models === null) {
    return { ok: false, error: `response is not JSON (invalid body); body head: ${head(text, 200)}` };
  }
  return { ok: true, models };
}

export interface TestOutcome {
  ok: boolean;
  latency_ms?: number;
  model_count?: number;
  error?: string;
}

/** POST /api/providers/test — same probe, plus latency and model count. */
export async function testProvider(candidate: ProbeCandidate, opts: ProbeOptions, now: () => number = Date.now): Promise<TestOutcome> {
  const start = now();
  const outcome = await probeModels(candidate, opts);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const latency_ms = Math.max(0, Math.round(now() - start));
  return { ok: true, latency_ms, model_count: outcome.models?.length ?? 0 };
}
