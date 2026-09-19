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
  withMessageEstimator,
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
    // W813 P2-trimContext: keep_recent is "at most 10" and the whole history is
    // 10 messages, so only the budget decides the cut. The trim marker now counts
    // against that budget, so the most that fits is 6 recent messages — this used
    // to keep 8 and hand back a request ~32 tokens OVER 0.8 * 300.
    expect(result.outcome.removedMessages).toBe(4);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeLessThan(11);
    // The assembled request, marker included, fits the budget.
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(240);
  });

  it("counts always-kept history system messages in the budget (W813 P2)", () => {
    // A history system row is never trimmed and is always prepended, so it is
    // not optional budget. The marker-blind predicate ignored it and could hand
    // back a request over the budget even when a smaller suffix did fit.
    const messages: Message[] = [systemMessage(rep("s", 2000))];
    for (let i = 0; i < 20; i++) messages.push(userMessage(rep("u", 100)));

    const result = trimContext(messages, 0, 1000, 0.8, 10);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.role).toBe("system"); // the trim marker
    // 0.8 * 1000 = 800: fixed system + marker + kept suffix all fit.
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(800);
  });

  it("keeps everything when no safe cut boundary exists", () => {
    const messages: Message[] = [assistantText(rep("x", 4000)), toolResult("c1", rep("y", 4000))];
    const result = trimContext(messages, 0, 100, 0.8, 1);
    expect(result.outcome.trimmed).toBe(false);
    expect(result.messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// W762: the trim pass is O(n) now — these tests pin the SEMANTICS it must keep.
// ---------------------------------------------------------------------------

/** The pre-W762 (quadratic) implementation, kept ONLY as a differential oracle. */
function trimContextReference(
  messages: readonly Message[],
  systemTokens: number,
  contextWindowTokens: number,
  threshold: number,
  keepRecent: number,
): { messages: Message[]; outcome: { removedMessages: number; removedTokens: number; trimmed: boolean } } {
  const none = { removedMessages: 0, removedTokens: 0, trimmed: false };
  if (contextWindowTokens === 0) return { messages: [...messages], outcome: none };
  const budget = Math.max(1, Math.floor(contextWindowTokens * Math.min(Math.max(threshold, 0), 1)));
  if (systemTokens + estimateMessagesTokens(messages) <= budget) return { messages: [...messages], outcome: none };
  const systems: Message[] = [];
  const rest: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "system") systems.push(msg);
    else rest.push(msg);
  }
  if (rest.length === 0) return { messages: [...systems], outcome: none };
  const cuts: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    const role = rest[i]?.role;
    if (role === "system" || role === "user") cuts.push(i);
  }
  if (cuts.length === 0) return { messages: [...systems, ...rest], outcome: none };
  const keep = Math.max(1, keepRecent);
  // W813 P2-trimContext: score the LIST the cut produces, not only its suffix.
  // The history system messages are always kept and prepended, and a marker is
  // always inserted when anything is cut, so the budget check is
  //   fixed(system + history systems) + marker + kept suffix.
  const fixedTokens = systemTokens + estimateMessagesTokens(systems);
  const fits = (candidate: number): boolean => {
    const removedTokens = estimateMessagesTokens(rest.slice(0, candidate));
    const markerTokens = estimateMessageTokens(trimmedMarkerMessage(candidate, removedTokens));
    return fixedTokens + markerTokens + estimateMessagesTokens(rest.slice(candidate)) <= budget;
  };
  const withinKeep = cuts.find((c) => c >= Math.max(0, rest.length - keep));
  const fitsBudget = cuts.find((c) => fits(c));
  let cut: number;
  if (withinKeep !== undefined && fitsBudget !== undefined) cut = withinKeep >= fitsBudget ? withinKeep : fitsBudget;
  else if (withinKeep !== undefined) cut = withinKeep;
  else if (fitsBudget !== undefined) cut = fitsBudget;
  else cut = cuts[cuts.length - 1] ?? 0;
  const removed = rest.slice(0, cut);
  const outcome = { removedMessages: removed.length, removedTokens: estimateMessagesTokens(removed), trimmed: removed.length > 0 };
  if (!outcome.trimmed) return { messages: [...systems, ...rest], outcome: none };
  return { messages: [...systems, trimmedMarkerMessage(outcome.removedMessages, outcome.removedTokens), ...rest.slice(cut)], outcome };
}

/** Deterministic PRNG (mulberry32) so a failing differential case is replayable. */
function rngFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function randomHistory(rng: () => number, target: number): Message[] {
  const out: Message[] = [];
  let openTool = 0;
  while (out.length < target) {
    const roll = rng();
    const text = rep("x", 8 + Math.floor(rng() * 400));
    if (roll < 0.12) out.push(systemMessage(text));
    else if (roll < 0.5) out.push(userMessage(text));
    else if (roll < 0.7) out.push(assistantText(text));
    else if (roll < 0.85) {
      openTool += 1;
      out.push(toolCall(`c${openTool}`));
    } else if (openTool > 0) out.push(toolResult(`c${openTool}`, text));
    else out.push(assistantText(text));
  }
  return out;
}

describe("trimContext (W762 O(n))", () => {
  it("is byte-identical to the quadratic reference over random histories", () => {
    const rng = rngFrom(0x5eed);
    let trimmedRounds = 0;
    for (let round = 0; round < 300; round += 1) {
      const history = randomHistory(rng, Math.floor(rng() * 40));
      const systemTokens = Math.floor(rng() * 200);
      const window = Math.floor(rng() * 4_000);
      const threshold = rng();
      const keepRecent = Math.floor(rng() * 12);
      const actual = trimContext(history, systemTokens, window, threshold, keepRecent);
      const expected = trimContextReference(history, systemTokens, window, threshold, keepRecent);
      expect({ messages: actual.messages, outcome: actual.outcome }).toEqual(expected);
      if (actual.outcome.trimmed) trimmedRounds += 1;
    }
    // The comparison is only worth anything if it actually trimmed: a vacuous
    // all-no-op run would pass even if the cut logic were wrong.
    expect(trimmedRounds).toBeGreaterThan(50);
  });

  it("trims a 20k-message history on a safe boundary and keeps the recent window", () => {
    const messages: Message[] = [systemMessage("persist me")];
    for (let i = 0; i < 20_000; i += 1) messages.push(userMessage(`msg ${i} ${rep("y", 60)}`));

    const result = trimContext(messages, 40, 4_000, 0.8, 10);

    expect(result.outcome.trimmed).toBe(true);
    expect(result.messages[0]?.content[0]).toMatchObject({ type: "text", content: "persist me" });
    expect(JSON.stringify(result.messages[1]?.content[0])).toContain("context-trimmed");
    expect(result.messages[2]?.role).toBe("user");
    // keep_recent honoured: the 10 newest user messages survive, in order.
    const kept = result.messages.slice(2).map((m) => (m.content[0]?.type === "text" ? m.content[0].content : ""));
    expect(kept).toEqual(Array.from({ length: 10 }, (_, i) => `msg ${19_990 + i} ${rep("y", 60)}`));
    // removedTokens is the exact suffix difference, not an approximation.
    expect(result.outcome.removedTokens).toBe(estimateMessagesTokens(messages.slice(1, 1 + result.outcome.removedMessages)));
  });

  it("does O(n) estimator work: doubling the history must not quadruple the estimate count", () => {
    // W889: the old guard timed the pass on the wall clock and was load-flaky
    // (a loaded CI box made a 3ms pass 5x). The estimator is now INJECTABLE, so
    // this counts the O(n) unit directly — fully deterministic, no clock.
    const build = (size: number): Message[] => {
      const out: Message[] = [];
      for (let i = 0; i < size; i += 1) out.push(userMessage(`m${i} ${rep("z", 50)}`));
      return out;
    };
    const calls = (size: number): number => {
      let count = 0;
      withMessageEstimator(
        (msg) => {
          count += 1;
          return estimateMessageTokens(msg);
        },
        () => {
          trimContext(build(size), 0, 2_000, 0.8, 10);
        },
      );
      return count;
    };
    const small = calls(5_000);
    const large = calls(10_000);
    // O(n): ~3 estimates per message (fast-path scan + split + one marker per
    // candidate), so doubling n roughly doubles the count. O(n^2) re-estimates
    // the whole suffix per candidate and scores ~4x here.
    expect(large / small).toBeLessThan(3);
    // Absolute ceiling: linear with a small constant, far below the n^2 regime.
    expect(large).toBeLessThan(4 * 10_000);
    expect(small).toBeGreaterThan(0);
  });
});
