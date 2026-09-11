/**
 * Iteration E §4 P0 acceptance tests (D1 of `docs/iteration-e-capabilities.md`
 * §4.4): the *cause* of an `LlmError` is machine-readable in addition to its
 * message text — `httpStatus` (`null` when no response arrived) and `retryable`
 * (whether another attempt or another target could plausibly help).
 *
 * Scope discipline: P0 is observability only. No retry, no fallback, no new
 * event name, no new endpoint — these tests additionally pin the *unchanged*
 * parts (message text, `kind`, `isTimeout`, terminal stream event) so the
 * "zero behaviour change" claim is mechanically checked rather than asserted.
 *
 * Everything runs against the local mock upstream on 127.0.0.1 with a dummy
 * key: no network access, no secrets.
 */

import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelledError,
  collectStream,
  connectTimeoutError,
  errorKind,
  isRetryableStatus,
  isTimeoutError,
  LlmError,
  networkError,
  OpenAiCompatClient,
  responseHeaderTimeoutError,
  statusError,
  streamIdleTimeoutMessage,
  timeoutError,
  userMessage,
  validateModel,
  type ModelRequest,
} from "@celestea/llm";
import { startMockUpstream, type MockUpstream } from "./mock-upstream.test-util.js";

const DUMMY_KEY = "sk-dummy-test-key-never-real";
const MODEL = "deepseek-v4-flash-0731";

let upstream: MockUpstream | null = null;

afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

function request(): ModelRequest {
  return { model: MODEL, messages: [userMessage("ping")], max_tokens: 16 };
}

function client(baseUrl: string, responseMs: number, idleMs: number): OpenAiCompatClient {
  return new OpenAiCompatClient({
    baseUrl,
    apiKey: DUMMY_KEY,
    model: MODEL,
    connectTimeoutMs: 5_000,
    responseTimeoutMs: responseMs,
    streamIdleTimeoutMs: idleMs,
  });
}

/** Await a rejected generate() and hand back the error for assertions. */
async function failure(llm: OpenAiCompatClient): Promise<LlmError> {
  try {
    await llm.generate(request());
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error("expected generate() to reject");
}

describe("D1 · a status error carries the status and its retryability", () => {
  it("429 (rate limited) is retryable and keeps the W511 message format", () => {
    const err = statusError(429, "429 Too Many Requests", '{"error":"slow down"}');
    expect(err.message).toBe('stream request failed: 429 Too Many Requests: {"error":"slow down"}');
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    // Unchanged legacy semantics: status errors are the "generate" arm.
    expect(err.kind).toBe("generate");
    expect(errorKind(err)).toBe("generate");
    expect(err.isTimeout).toBe(false);
    expect(err.timeoutStage).toBeNull();
  });

  it("401/403/400/404/422 (config, credential, request) are not retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = statusError(status, `${status} X`, "body");
      expect(err.httpStatus).toBe(status);
      expect(err.retryable).toBe(false);
    }
  });

  it("500/502/503/504 and 408/425 (transient upstream) are retryable", () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      const err = statusError(status, `${status} X`, "body");
      expect(err.httpStatus).toBe(status);
      expect(err.retryable).toBe(true);
    }
  });

  it("isRetryableStatus covers the boundaries and the no-status case", () => {
    expect(isRetryableStatus(null)).toBe(false);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(425)).toBe(true);
    expect(isRetryableStatus(428)).toBe(false);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(499)).toBe(false);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    // 3xx / informational / the "no status line" zero are not status-classified.
    expect(isRetryableStatus(302)).toBe(false);
    expect(isRetryableStatus(0)).toBe(false);
  });
});

describe("timeouts · no HTTP status, always worth another attempt", () => {
  it("connect / response / idle timeouts report the stage, null status, retryable", () => {
    const cases = [
      { err: connectTimeoutError(15_000, "http://127.0.0.1:1/chat/completions"), stage: "connect" },
      { err: responseHeaderTimeoutError(60_000, "http://127.0.0.1:1/chat/completions"), stage: "response" },
      { err: timeoutError(streamIdleTimeoutMessage(90_000), "idle"), stage: "idle" },
    ];
    for (const { err, stage } of cases) {
      expect(err.timeoutStage).toBe(stage);
      expect(err.isTimeout).toBe(true);
      expect(isTimeoutError(err)).toBe(true);
      expect(err.httpStatus).toBeNull();
      expect(err.retryable).toBe(true);
      expect(err.message.startsWith("llm timeout")).toBe(true);
    }
  });

  it("a real response-header timeout fills both fields (message unchanged)", async () => {
    upstream = await startMockUpstream("silent");
    const err = await failure(client(upstream.baseUrl, 300, 5_000));
    expect(err.message).toBe(
      `llm timeout: response headers not received within 300ms (${upstream.baseUrl}/chat/completions)`,
    );
    expect(err.timeoutStage).toBe("response");
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
  });

  it("a real idle stall stays a stream event; its idle vocabulary is retryable", async () => {
    upstream = await startMockUpstream("chunk-then-silent");
    const events = await collectStream(await client(upstream.baseUrl, 5_000, 250).generate(request()));
    // Unchanged: an idle stall is a terminal stream event, never an LlmError.
    expect(events.at(-1)).toEqual({
      kind: "failed",
      kindOf: "timeout",
      message: "stream idle timeout: no data chunk for 250ms",
    });
    const idle = timeoutError(streamIdleTimeoutMessage(250), "idle");
    expect(idle.httpStatus).toBeNull();
    expect(idle.retryable).toBe(true);
  });
});

describe("transport / cancellation / configuration", () => {
  it("a transport failure before any response is retryable and status-free", async () => {
    upstream = await startMockUpstream("silent");
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    const err = await failure(client(baseUrl, 2_000, 2_000));
    expect(err.message.startsWith("failed to start stream:")).toBe(true);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.isTimeout).toBe(false);
    expect(err.kind).toBe("generate");
  });

  it("a transport error built by hand behaves the same", () => {
    const err = networkError("failed to start stream: connect ECONNREFUSED 127.0.0.1:1");
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
  });

  it("a caller abort is never retryable", () => {
    const err = cancelledError();
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBeNull();
    expect(err.isTimeout).toBe(false);
  });

  it("a configuration error is not retryable (another target cannot fix it)", () => {
    let caught: unknown;
    try {
      validateModel("   ");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const err = caught as LlmError;
    expect(err.message).toBe("model must not be empty");
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(false);
  });

  it("the field defaults are the conservative (null, false) pair", () => {
    const err = new LlmError("anything", "stream");
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(false);
    expect(err.kind).toBe("stream");
  });
});

describe("real non-2xx responses (no behaviour change beyond the new fields)", () => {
  it("400 / 404 / 429 / 500 fill httpStatus + retryable and keep the message verbatim", async () => {
    const matrix: Array<{ status: number; retryable: boolean }> = [
      { status: 400, retryable: false },
      { status: 404, retryable: false },
      { status: 429, retryable: true },
      { status: 500, retryable: true },
    ];
    for (const { status, retryable } of matrix) {
      const body = JSON.stringify({ error: { message: `boom ${status}` } });
      upstream = await startMockUpstream("http-error", { status, body });
      const err = await failure(client(upstream.baseUrl, 2_000, 2_000));

      expect(err.message).toBe(`stream request failed: ${status} ${http.STATUS_CODES[status]}: ${body}`);
      expect(err.message).not.toContain(DUMMY_KEY);
      expect(err.httpStatus).toBe(status);
      expect(err.retryable).toBe(retryable);

      await upstream.close();
      upstream = null;
    }
  });
});
