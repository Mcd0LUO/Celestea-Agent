/**
 * End-to-end SSE decoding against the local mock upstream: reasoning deltas,
 * content deltas, tool-call accumulation, usage frames (including usage-only
 * final frames and all three cache-key shapes), keepalive/noise tolerance,
 * torn streams, multi-byte splits, and verbatim reasoning_effort passthrough.
 */

import { afterEach, describe, expect, it } from "vitest";

import { collectStream, OpenAiCompatClient, userMessage, type ModelRequest } from "@celestea/llm";
import { sseFrame, startMockUpstream, type MockUpstream } from "./mock-upstream.test-util.js";

const DUMMY_KEY = "sk-dummy-test-key-never-real";

let upstream: MockUpstream | null = null;

afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

function request(): ModelRequest {
  return { model: "deepseek-v4-flash-0731", messages: [userMessage("ping")], max_tokens: 16 };
}

function client(baseUrl: string, reasoningEffort?: string | null): OpenAiCompatClient {
  return new OpenAiCompatClient({
    baseUrl,
    apiKey: DUMMY_KEY,
    model: "deepseek-v4-flash-0731",
    reasoningEffort: reasoningEffort ?? null,
    connectTimeoutMs: 5_000,
    responseTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
  });
}

async function runFrames(
  frames: Array<string | Buffer>,
  end = true,
): Promise<Awaited<ReturnType<typeof collectStream>>> {
  upstream = await startMockUpstream("frames", { frames, end });
  const llm = client(upstream.baseUrl);
  return await collectStream(await llm.generate(request()));
}

describe("reasoning + content + tool calls + usage", () => {
  it("streams thinking before text and assembles the terminal message", async () => {
    const events = await runFrames([
      sseFrame({ choices: [{ index: 0, delta: { reasoning_content: "Let me" } }] }),
      sseFrame({ choices: [{ index: 0, delta: { reasoning_content: " think" } }] }),
      sseFrame({
        choices: [
          {
            index: 0,
            delta: {
              content: "Hi",
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      sseFrame({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/a"}' } }] } }],
      }),
      sseFrame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
      sseFrame("[DONE]"),
    ]);

    expect(events.map((e) => e.kind)).toEqual([
      "thinking",
      "thinking",
      "text",
      "usage",
      "done",
    ]);
    expect(events[1]).toEqual({ kind: "thinking", text: " think" });
    expect(events[2]).toEqual({ kind: "text", text: "Hi" });
    const terminal = events.at(-1);
    expect(terminal?.kind).toBe("done");
    if (terminal?.kind === "done") {
      expect(terminal.message.content).toEqual([
        { type: "text", content: "Hi" },
        { type: "tool_call", content: { id: "call_1", name: "read_file", args: { path: "/tmp/a" } } },
      ]);
    }
  });

  it("skips keepalive, comment and non-JSON frames silently", async () => {
    const events = await runFrames([
      ": keepalive\n\n",
      "event: keepalive\ndata: {\"choices\":[{\"delta\":{\"content\":\"nope\"}}]}\n\n",
      "data: not-json-at-all\n\n",
      "data: {\"choices\":[]}\n\n",
      sseFrame({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseFrame("[DONE]"),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["text", "done"]);
    expect(events[0]).toEqual({ kind: "text", text: "ok" });
  });

  it("reassembles a UTF-8 character and a frame split across TCP writes", async () => {
    const whole = sseFrame({ choices: [{ index: 0, delta: { content: "中文答案" } }] });
    const bytes = Buffer.from(whole, "utf8");
    const at = bytes.indexOf(Buffer.from("中文答案", "utf8"));
    // Three writes: mid-character, then the rest without the blank line, then
    // the line terminator — every byte still arrives exactly once.
    const events = await runFrames([
      bytes.subarray(0, at + 1),
      bytes.subarray(at + 1, bytes.length - 2),
      bytes.subarray(bytes.length - 2),
      sseFrame("[DONE]"),
    ]);
    expect(events[0]).toEqual({ kind: "text", text: "中文答案" });
    expect(events.at(-1)?.kind).toBe("done");
  });
});

describe("usage frames and the three cache keys", () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["prompt_cache_hit_tokens", { prompt_cache_hit_tokens: 5 }, 5],
    ["cache_read_input_tokens", { cache_read_input_tokens: 6 }, 6],
    ["prompt_tokens_details.cached_tokens", { prompt_tokens_details: { cached_tokens: 7 } }, 7],
  ];

  for (const [label, cacheFields, expected] of cases) {
    it(`parses ${label} from a usage-only final frame`, async () => {
      const events = await runFrames([
        sseFrame({ choices: [{ index: 0, delta: { content: "answer" } }] }),
        sseFrame({
          id: "chunk-final",
          object: "chat.completion.chunk",
          choices: [],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 5,
            total_tokens: 16,
            ...cacheFields,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        sseFrame("[DONE]"),
      ]);
      const usageEvent = events.find((e) => e.kind === "usage");
      expect(usageEvent).toBeDefined();
      if (usageEvent?.kind === "usage") {
        expect(usageEvent.usage.cache_read).toBe(expected);
        expect(usageEvent.usage.total_tokens).toBe(16);
        expect(usageEvent.usage.reasoning_tokens).toBe(3);
      }
      // usage rides just before the terminal event
      expect(events.at(-2)?.kind).toBe("usage");
      expect(events.at(-1)?.kind).toBe("done");
    });
  }

  it("keeps the last usage frame when the provider sends several", async () => {
    const events = await runFrames([
      sseFrame({ choices: [], usage: { prompt_tokens: 1, total_tokens: 1 } }),
      sseFrame({ choices: [], usage: { prompt_tokens: 2, total_tokens: 2 } }),
      sseFrame("[DONE]"),
    ]);
    const usageEvents = events.filter((e) => e.kind === "usage");
    expect(usageEvents).toHaveLength(1);
    if (usageEvents[0]?.kind === "usage") expect(usageEvents[0].usage.total_tokens).toBe(2);
  });
});

describe("terminal states (R1: never a fake done)", () => {
  it("yields interrupted when the stream ends without [DONE]", async () => {
    const events = await runFrames([
      sseFrame({ choices: [{ index: 0, delta: { content: "abc" } }] }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["text", "interrupted"]);
  });

  it("yields interrupted for an empty body", async () => {
    const events = await runFrames([]);
    expect(events).toEqual([{ kind: "interrupted" }]);
  });
});

describe("request body on the wire", () => {
  it("passes reasoning_effort through verbatim (max stays max)", async () => {
    upstream = await startMockUpstream("frames", {
      frames: [sseFrame({ choices: [{ index: 0, delta: { content: "ok" } }] }), sseFrame("[DONE]")],
      end: true,
    });
    const llm = client(upstream.baseUrl, "max");
    const req: ModelRequest = {
      model: "deepseek-v4-flash-0731",
      system: "be brief",
      messages: [userMessage("hi")],
      tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
      max_tokens: 128,
      temperature: 0.5,
    };
    await collectStream(await llm.generate(req));

    const recorded = upstream.requests[0];
    expect(recorded?.url).toBe("/chat/completions");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
    const body = recorded?.json as Record<string, unknown>;
    expect(body["reasoning_effort"]).toBe("max");
    expect(body["stream"]).toBe(true);
    expect(body["max_tokens"]).toBe(128);
    expect(body["temperature"]).toBe(0.5);
    expect((body["messages"] as Array<Record<string, unknown>>)[0]).toEqual({
      role: "system",
      content: "be brief",
    });
    expect((body["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      function: { name: "read_file" },
    });
    // the key never rides in the body
    expect(recorded?.body).not.toContain(DUMMY_KEY);
  });

  it("passes a user-defined tier through unchanged", async () => {
    upstream = await startMockUpstream("frames", {
      frames: [sseFrame("[DONE]")],
      end: true,
    });
    const llm = client(upstream.baseUrl, "xhigh-custom");
    await collectStream(await llm.generate(request()));
    const body = upstream.requests[0]?.json as Record<string, unknown>;
    expect(body["reasoning_effort"]).toBe("xhigh-custom");
  });

  it("omits reasoning_effort entirely when it is not configured", async () => {
    upstream = await startMockUpstream("frames", { frames: [sseFrame("[DONE]")], end: true });
    const llm = client(upstream.baseUrl, null);
    await collectStream(await llm.generate(request()));
    const body = upstream.requests[0]?.json as Record<string, unknown>;
    expect("reasoning_effort" in body).toBe(false);
  });
});
