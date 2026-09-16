/**
 * W835 (R3 batch E) — illegal-input hardening (P2-4 / P2-3 / P2-5).
 *
 * Source: W826-R3修复计划 §批次 E. P2-4 runs the real profile -> client ->
 * generate path; P2-3 exercises the real requestBody entry; P2-5 runs both the
 * decoder unit and the real mock-upstream stream path.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  collectStream,
  createFallbackLlm,
  LlmError,
  OpenAiCompatClient,
  userMessage,
  type FallbackAttemptInfo,
  type Message,
} from "@celestea/llm";
import { MAX_SSE_BUFFER_BYTES, SseBufferOverflowError, SseDecoder } from "./sse/frames.js";
import { fastStreamFrames, startMockUpstream, type MockUpstream } from "./mock-upstream.test-util.js";

let upstream: MockUpstream | null = null;
afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

function developerMessage(): Message {
  return { role: "developer", content: [{ type: "text", content: "hi" }], tool_call_id: null } as unknown as Message;
}

describe("W835 P2-3 — an unknown message role is a structured LlmError", () => {
  it("rejects role 'developer' at the real requestBody entry, not a TypeError", () => {
    const client = new OpenAiCompatClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
    let caught: unknown;
    try {
      client.requestBody({ messages: [developerMessage()] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect(caught).not.toBeInstanceOf(TypeError);
    const err = caught as LlmError;
    expect(err.kind).toBe("generate");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("developer");
  });

  it("rejects generate() with the same LlmError before any network I/O", async () => {
    const client = new OpenAiCompatClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
    await expect(client.generate({ messages: [developerMessage()] })).rejects.toBeInstanceOf(LlmError);
  });
});

describe("W835 P2-4 — an invalid base_url is a structured LlmError", () => {
  it("rejects generate() with an LlmError and echoes neither url nor key", async () => {
    const secret = "sk-abcdefghijklmnop";
    const raw = "not a url " + secret;
    const client = OpenAiCompatClient.fromProfile({ base_url: raw, model: "m" }, {});
    let caught: unknown;
    try {
      await client.generate({ messages: [userMessage("hi")] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmError);
    expect(caught).not.toBeInstanceOf(TypeError);
    const err = caught as LlmError;
    // A misconfigured primary must stay retryable so a healthy fallback runs.
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain(raw);
  });

  it("lets the fallback chain switch to a healthy target after the bad primary", async () => {
    upstream = await startMockUpstream("frames", { frames: fastStreamFrames(["ok"]), end: true });
    const attempts: FallbackAttemptInfo[] = [];
    const llm = createFallbackLlm({
      targets: [
        { name: "bad", provider: "p", model: "m-bad", baseUrl: "not a url" },
        { name: "good", provider: "p", model: "m-good", baseUrl: upstream.baseUrl },
      ],
      clientFor: (t) =>
        new OpenAiCompatClient({
          baseUrl: t.baseUrl ?? "",
          apiKey: "k",
          model: t.model,
          connectTimeoutMs: 1000,
          responseTimeoutMs: 1000,
        }),
      onAttempt: (info) => attempts.push(info),
    });
    const events = await collectStream(await llm.generate({ messages: [userMessage("hi")] }));
    expect(events.at(-1)?.kind).toBe("done");
    expect(attempts.map((a) => [a.from, a.target, a.reason])).toEqual([["bad", "good", "network"]]);
  });
});

describe("W835 P2-5 — the SSE decoder buffer is bounded", () => {
  it("decodes a normal long frame below the cap but throws past it", () => {
    const normal = new SseDecoder();
    const big = "x".repeat(MAX_SSE_BUFFER_BYTES - 1024);
    const frames = normal.push("data: " + big + "\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.length).toBe(big.length);

    const flood = new SseDecoder();
    expect(() => flood.push("y".repeat(MAX_SSE_BUFFER_BYTES + 1))).toThrow(SseBufferOverflowError);
  });

  it("terminates a newline-less flood as failed{kindOf:'stream'} on the real stream path", async () => {
    upstream = await startMockUpstream("frames", {
      frames: ["z".repeat(MAX_SSE_BUFFER_BYTES + 4096)],
      end: true,
    });
    const client = new OpenAiCompatClient({
      baseUrl: upstream.baseUrl,
      apiKey: "k",
      model: "m",
      connectTimeoutMs: 5000,
      responseTimeoutMs: 5000,
      streamIdleTimeoutMs: 5000,
    });
    const events = await collectStream(await client.generate({ messages: [userMessage("hi")] }));
    expect(events.some((e) => e.kind === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "failed", kindOf: "stream" });
  });
});
