import { describe, expect, it } from "vitest";

import { SseDecoder } from "./sse/frames.js";
import { extractReasoning, parseArguments, parseRawChunk, thinkingEvent } from "./sse/chunks.js";

describe("SseDecoder", () => {
  it("dispatches one frame at a time and joins multi-line data", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(
      'event: text\ndata: {"a":\ndata: 1}\n\n' + 'data: {"b":2}\n\n' + ": keepalive\n\n",
    );
    expect(frames).toEqual([
      { event: "text", data: '{"a":\n1}' },
      { event: "message", data: '{"b":2}' },
    ]);
  });

  it("holds back a frame split across pushes (including between CR and LF)", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"choices":[{')).toEqual([]);
    expect(decoder.push('"delta":{"content":"Hi"}}]}')).toEqual([]);
    expect(decoder.push("\r")).toEqual([]);
    expect(decoder.push("\n\r\n")).toEqual([
      { event: "message", data: '{"choices":[{"delta":{"content":"Hi"}}]}' },
    ]);
  });

  it("ignores comment lines, empty dispatches and unknown fields", () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(": ping\n\nretry: 100\nid: 7\n\n" + "data: x\n\n");
    expect(frames).toEqual([{ event: "message", data: "x" }]);
  });

  it("drops an unterminated trailing frame at EOF (eventsource-stream parity)", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"a":1}')).toEqual([]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("parseRawChunk", () => {
  it("reads reasoning_content, content and tool-call fragments together", () => {
    const chunk = parseRawChunk(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "r1",
              content: "hi",
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } },
              ],
            },
          },
        ],
      }),
    );
    expect(chunk?.reasoning).toBe("r1");
    expect(chunk?.choices).toHaveLength(1);
    expect(chunk?.choices[0]?.text).toBe("hi");
    expect(chunk?.choices[0]?.toolCalls[0]).toEqual({
      index: 0,
      id: "call_1",
      name: "read_file",
      arguments: '{"path"',
    });
  });

  it("returns undefined for non-JSON, [DONE] and delta-less payloads", () => {
    expect(parseRawChunk("not json")).toBeUndefined();
    expect(parseRawChunk("[DONE]")).toBeUndefined();
    expect(parseRawChunk('{"choices":[]}')).toBeUndefined();
    expect(parseRawChunk('{"object":"chat.completion.chunk"}')).toBeUndefined();
    expect(parseRawChunk("null")).toBeUndefined();
  });

  it("keeps a usage-only final frame (no choices at all)", () => {
    const chunk = parseRawChunk(
      '{"id":"x","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}',
    );
    expect(chunk?.choices).toEqual([]);
    expect(chunk?.usage?.total_tokens).toBe(10);
  });

  it("joins multi-choice reasoning in wire order and skips blanks", () => {
    expect(
      extractReasoning({
        choices: [
          { delta: { reasoning_content: "ab" } },
          { delta: { reasoning_content: "" } },
          { delta: { reasoning_content: "cd" } },
        ],
      }),
    ).toBe("abcd");
    expect(extractReasoning({ choices: [{ delta: { content: "x" } }] })).toBeUndefined();
    expect(extractReasoning({})).toBeUndefined();
  });

  it("blank-gates thinking events but keeps the payload untrimmed", () => {
    expect(thinkingEvent("   ")).toBeNull();
    expect(thinkingEvent("")).toBeNull();
    expect(thinkingEvent(" think")).toEqual({ type: "thinking", delta: " think" });
  });

  it("preserves malformed tool-call arguments as a raw string", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("not json")).toBe("not json");
  });
});
