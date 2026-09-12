/**
 * Acceptance tests for the three timeout tiers, driven against a local mock
 * HTTP upstream (no network, dummy key). Mirrors the Rust regression suite
 * `crates/llm/tests/timeout_upstream.rs`:
 *   1. an upstream that never answers trips the response-header timeout;
 *   2. an upstream that sends one chunk and then stalls trips the stream idle
 *      timeout (terminal kind "timeout"), after surfacing the partial chunk;
 *   3. a healthy fast stream is never killed by either guard;
 *   4. 0 disables a stage.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  collectStream,
  errorKind,
  isTimeoutError,
  LlmError,
  TIMEOUT_ERROR_PREFIX,
  userMessage,
  OpenAiCompatClient,
  type ModelRequestDraft,
} from "@celestea/llm";
import {
  fastStreamFrames,
  sseFrame,
  startMockUpstream,
  type MockUpstream,
} from "./mock-upstream.test-util.js";

const DUMMY_KEY = "sk-dummy-test-key-never-real";

let upstream: MockUpstream | null = null;

afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

function request(): ModelRequestDraft {
  return { model: "deepseek-v4-flash-0731", messages: [userMessage("ping")], max_tokens: 16 };
}

function client(baseUrl: string, responseMs: number, idleMs: number): OpenAiCompatClient {
  return new OpenAiCompatClient({
    baseUrl,
    apiKey: DUMMY_KEY,
    model: "deepseek-v4-flash-0731",
    connectTimeoutMs: 5_000,
    responseTimeoutMs: responseMs,
    streamIdleTimeoutMs: idleMs,
  });
}

describe("1. response-headers timeout (upstream never answers)", () => {
  it("rejects with the canonical `llm timeout: response headers ...` message", async () => {
    upstream = await startMockUpstream("silent");
    const llm = client(upstream.baseUrl, 300, 5_000);

    const started = Date.now();
    let caught: unknown;
    try {
      await llm.generate(request());
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(LlmError);
    const err = caught as LlmError;
    expect(err.message.startsWith(TIMEOUT_ERROR_PREFIX)).toBe(true);
    expect(err.message).toBe(
      `llm timeout: response headers not received within 300ms (${upstream.baseUrl}/chat/completions)`,
    );
    // Mappable to TurnOutcome::Error { kind: "generate", .. }.
    expect(err.kind).toBe("generate");
    expect(errorKind(err)).toBe("generate");
    expect(isTimeoutError(err)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("2. stream idle timeout (one chunk, then silence)", () => {
  it("surfaces the partial chunk, then fails with kind=timeout (no fake done)", async () => {
    upstream = await startMockUpstream("chunk-then-silent");
    const llm = client(upstream.baseUrl, 5_000, 300);

    const stream = await llm.generate(request());
    const started = Date.now();
    const events = await collectStream(stream);
    const elapsed = Date.now() - started;

    expect(events.some((e) => e.kind === "text" && e.text === "Hel")).toBe(true);
    const terminal = events.at(-1);
    expect(terminal).toEqual({
      kind: "failed",
      kindOf: "timeout",
      message: "stream idle timeout: no data chunk for 300ms",
    });
    expect(events.some((e) => e.kind === "done")).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("2b. usage frames seen before a stall are still surfaced", () => {
  it("yields usage, then the timeout failure, and never a fake done", async () => {
    upstream = await startMockUpstream("frames", {
      frames: [
        sseFrame({ choices: [{ index: 0, delta: { content: "partial" } }] }),
        sseFrame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }),
      ],
      end: false,
    });
    const llm = client(upstream.baseUrl, 5_000, 250);

    const events = await collectStream(await llm.generate(request()));
    expect(events.map((e) => e.kind)).toEqual(["text", "usage", "failed"]);
    const usage = events[1];
    if (usage?.kind === "usage") expect(usage.usage.total_tokens).toBe(9);
    expect(events.at(-1)).toMatchObject({ kind: "failed", kindOf: "timeout" });
  });
});

describe("3. a healthy fast stream is not killed", () => {
  it("streams every delta and finishes with done + usage under tight guards", async () => {
    upstream = await startMockUpstream("frames", {
      frames: fastStreamFrames(["He", "llo", " world"]),
      gapMs: 20,
      end: true,
    });
    // Deliberately tight guards: the upstream answers immediately and streams
    // every 20ms, so nothing here should trip.
    const llm = client(upstream.baseUrl, 2_000, 500);

    const events = await collectStream(await llm.generate(request()));

    expect(events.some((e) => e.kind === "failed")).toBe(false);
    expect(events.filter((e) => e.kind === "text").map((e) => e.text)).toEqual([
      "He",
      "llo",
      " world",
    ]);
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("done");
    if (terminal?.kind === "done") {
      expect(terminal.message.content).toEqual([{ type: "text", content: "Hello world" }]);
      expect(terminal.message.tool_call_id).toBeNull();
    }
  });

  it("keeps the response-header guard off the body (no total-request timeout)", async () => {
    // 30ms of streaming after the headers: with responseMs=20 a total-request
    // timeout would kill it, a headers-only guard must not.
    upstream = await startMockUpstream("frames", {
      frames: fastStreamFrames(["a", "b", "c", "d", "e"]),
      gapMs: 10,
      end: true,
    });
    const llm = client(upstream.baseUrl, 20, 5_000);
    const events = await collectStream(await llm.generate(request()));
    expect(events.at(-1)?.kind).toBe("done");
  });
});

describe("4. 0 disables a stage", () => {
  it("maps 0 to a disabled guard and keeps the rest at their configured values", () => {
    const llm = client("http://127.0.0.1:1", 0, 0);
    expect(llm.timeouts()).toEqual({ connectMs: 5_000, responseMs: null, idleMs: null });
  });
});

describe("5. HTTP error status", () => {
  it("reports the status + body snippet and never the api key", async () => {
    const body = JSON.stringify({ error: { message: "服务繁忙，请稍后再试" } });
    upstream = await startMockUpstream("http-error", { status: 500, body });
    const llm = client(upstream.baseUrl, 2_000, 2_000);

    let caught: unknown;
    try {
      await llm.generate(request());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const err = caught as LlmError;
    expect(err.message).toContain("stream request failed: 500 Internal Server Error:");
    expect(err.message).toContain("服务繁忙");
    expect(err.message).not.toContain(DUMMY_KEY);
    expect(err.kind).toBe("generate");
    expect(isTimeoutError(err)).toBe(false);
  });
});
