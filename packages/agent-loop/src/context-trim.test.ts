/**
 * Context-budget tests — the TS mirror of the `#[cfg(test)] mod tests` of
 * `crates/agent-loop/src/context.rs`, case for case.
 */

import { describe, expect, it } from "vitest";
import { assistantText, systemMessage, userMessage, type Message } from "@celestea/core";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  trimContext,
  trimmedMarkerMessage,
} from "./context-trim.js";

/** `Message::assistant_tool_call` of one read_file call. */
function toolCall(id: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_call", content: { id, name: "read_file", args: { path: "/tmp/x" } } }],
    tool_call_id: null,
  };
}

/** `Message::tool_result` with the id as text. */
function toolResult(id: string, text: string): Message {
  return { role: "tool", content: [{ type: "text", content: text }], tool_call_id: id };
}

const rep = (text: string, times: number): string => text.repeat(times);

describe("estimateTokens", () => {
  it("is UTF-8 bytes over four, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("aaaa")).toBe(1);
    expect(estimateTokens("aaaaa")).toBe(2);
    // a 3-byte CJK char counts ~0.75 tokens (byte/4 rounding up)
    expect(estimateTokens("汉")).toBe(1);
  });

  it("counts structural overhead and tool-call payloads", () => {
    const call = toolCall("c1");
    // 4 (message) + 10 (call) + estimate("read_file") + estimate('{"path":"/tmp/x"}')
    expect(estimateMessageTokens(call)).toBe(4 + 10 + 3 + 5);
    expect(estimateMessageTokens(toolResult("c1", "hello"))).toBe(4 + 2 + 1);
    expect(estimateMessagesTokens([userMessage("hello"), assistantText("hi")])).toBe(6 + 5);
  });
});

describe("trimmedMarkerMessage", () => {
  it("names the count, the tokens and the trim marker", () => {
    const [first] = trimmedMarkerMessage(3, 42).content;
    expect(first).toMatchObject({ type: "text" });
    const body = first?.type === "text" ? first.content : "";
    expect(body).toContain("[context-trimmed]");
    expect(body).toContain("3 message(s)");
    expect(body).toContain("~42 tokens");
  });
});

describe("trimContext", () => {
  it("is disabled when the window is zero", () => {
    const messages = [userMessage("x"), userMessage("y")];
    const result = trimContext(messages, 0, 0, 0.8, 10);
    expect(result.messages).toHaveLength(2);
    expect(result.outcome.trimmed).toBe(false);
  });

  it("is a no-op under budget", () => {
    const messages = [userMessage("hello"), userMessage("hi")];
    const result = trimContext(messages, 10, 65_536, 0.8, 10);
    expect(result.messages).toHaveLength(2);
    expect(result.outcome).toEqual({ removedMessages: 0, removedTokens: 0, trimmed: false });
  });

  it("keeps the recent window and marks the removal with a system message", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) messages.push(userMessage(rep(`message ${i} `, 20)));

    const result = trimContext(messages, 0, 1000, 0.8, 4);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.outcome.removedMessages).toBe(26);
    expect(result.messages).toHaveLength(5);
    const marker = result.messages[0];
    expect(marker?.role).toBe("system");
    expect(marker?.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(marker?.content[0])).toContain("context-trimmed");
    const kept = result.messages.slice(1).map((m) => (m.content[0]?.type === "text" ? m.content[0].content : ""));
    expect(kept).toEqual([26, 27, 28, 29].map((i) => rep(`message ${i} `, 20)));
  });

  it("always keeps system messages, first", () => {
    const messages: Message[] = [systemMessage("persist me")];
    for (let i = 0; i < 20; i++) messages.push(userMessage(rep(`u${i}`, 30)));

    const result = trimContext(messages, 0, 400, 0.8, 5);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "text", content: "persist me" });
  });

  it("never splits a tool-call group: the cut lands on a user boundary", () => {
    const messages: Message[] = [
      userMessage(rep("older question ", 30)),
      toolCall("c1"),
      toolResult("c1", rep("answer here ", 30)),
      toolResult("c2", rep("second result ", 30)),
      userMessage(rep("new question ", 30)),
      assistantText(rep("final answer ", 30)),
    ];

    const result = trimContext(messages, 0, 200, 0.8, 4);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("system");
    expect(JSON.stringify(result.messages[0]?.content[0])).toContain("context-trimmed");
    expect(result.messages[1]?.role).toBe("user");
    expect(JSON.stringify(result.messages[1]?.content[0])).toContain("new question");
    expect(result.messages[2]?.role).toBe("assistant");
  });

  it("trims past keep_recent when the recent window is still over budget", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) messages.push(userMessage(rep(`${i} `, 50)));

    const result = trimContext(messages, 0, 300, 0.8, 10);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.outcome.removedMessages).toBe(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeLessThan(11);
  });

  it("keeps everything when no safe cut boundary exists", () => {
    const messages: Message[] = [assistantText(rep("x", 4000)), toolResult("c1", rep("y", 4000))];
    const result = trimContext(messages, 0, 100, 0.8, 1);
    expect(result.outcome.trimmed).toBe(false);
    expect(result.messages).toHaveLength(2);
  });
});
