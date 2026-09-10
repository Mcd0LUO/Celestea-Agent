/** Message / Role / Content / ToolCall / Usage — port of the Rust message.rs tests. */

import { describe, expect, it } from "vitest";
import {
  assistantText,
  assistantToolCall,
  cacheHitRatio,
  hasToolCalls,
  isTextContent,
  isToolCallContent,
  Message,
  messageText,
  messageTexts,
  messageToolCalls,
  systemMessage,
  toolCallIds,
  toolResultMessage,
  usageAdd,
  usageIsEmpty,
  usageSum,
  userMessage,
  zeroUsage,
} from "./message.js";

describe("Message constructors", () => {
  it("shapes content exactly like Rust (message_constructors_shape_content)", () => {
    const m = userMessage("hi");
    expect(m.role).toBe("user");
    expect(m.content).toEqual([{ type: "text", content: "hi" }]);
    expect(m.tool_call_id).toBeNull();

    const sys = systemMessage("be terse");
    expect(sys.role).toBe("system");
    expect(messageText(sys)).toBe("be terse");

    const tc = assistantToolCall({ id: "c1", name: "read_file", args: { path: "a" } });
    expect(tc.role).toBe("assistant");
    expect(tc.content).toEqual([{ type: "tool_call", content: { id: "c1", name: "read_file", args: { path: "a" } } }]);
    expect(tc.tool_call_id).toBeNull();

    const tr = toolResultMessage("c1", "ok");
    expect(tr.role).toBe("tool");
    expect(tr.tool_call_id).toBe("c1");
    expect(tr.content).toEqual([{ type: "text", content: "ok" }]);
  });

  it("exposes the Rust-style namespace", () => {
    expect(Message.user("x")).toEqual(userMessage("x"));
    expect(Message.assistantText("x")).toEqual(assistantText("x"));
    expect(Message.toolResult("c1", "x")).toEqual(toolResultMessage("c1", "x"));
  });

  it("serializes to the Rust serde tagged shape", () => {
    expect(JSON.stringify(assistantText("hi"))).toBe('{"role":"assistant","content":[{"type":"text","content":"hi"}],"tool_call_id":null}');
    expect(JSON.stringify(assistantToolCall({ id: "c1", name: "f", args: {} }))).toBe(
      '{"role":"assistant","content":[{"type":"tool_call","content":{"id":"c1","name":"f","args":{}}}],"tool_call_id":null}',
    );
  });
});

describe("content helpers", () => {
  const merged = {
    role: "assistant" as const,
    content: [
      { type: "tool_call" as const, content: { id: "c1", name: "a", args: {} } },
      { type: "tool_call" as const, content: { id: "c2", name: "b", args: {} } },
    ],
    tool_call_id: null,
  };

  it("narrows content variants", () => {
    expect(isToolCallContent(merged.content[0]!)).toBe(true);
    expect(isTextContent(merged.content[0]!)).toBe(false);
    expect(hasToolCalls(merged)).toBe(true);
  });

  it("extracts ids / calls / texts", () => {
    expect(toolCallIds(merged)).toEqual(["c1", "c2"]);
    expect(messageToolCalls(merged).map((c) => c.name)).toEqual(["a", "b"]);
    expect(messageTexts(merged)).toEqual([]);
    expect(messageText(merged)).toBeNull();
  });
});

describe("Usage", () => {
  it("accumulates and reports empty (usage_accumulates_and_reports_empty)", () => {
    const a = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cache_read: 4, reasoning_tokens: 3 };
    const b = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cache_read: 1, reasoning_tokens: 1 };
    expect(usageAdd(a, b)).toEqual({ prompt_tokens: 11, completion_tokens: 22, total_tokens: 33, cache_read: 5, reasoning_tokens: 4 });
    expect(usageIsEmpty(zeroUsage())).toBe(true);
    expect(usageIsEmpty(a)).toBe(false);
    expect(usageSum([a, b, zeroUsage()])).toEqual(usageAdd(a, b));
    expect(cacheHitRatio(a)).toBe(0.4);
    expect(cacheHitRatio(zeroUsage())).toBe(0);
  });

  it("keeps the flat serde shape (usage_serde_roundtrip)", () => {
    const u = { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, cache_read: 50, reasoning_tokens: 40 };
    expect(JSON.parse(JSON.stringify(u))).toEqual(u);
  });
});
