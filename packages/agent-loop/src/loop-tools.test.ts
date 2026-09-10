/**
 * Tool-dispatch, request-building and usage tests — the TS mirror of the
 * `dispatches_*`, `batches_*`, `loop_trims_*` and `usage_events_*` cases of
 * `crates/agent-loop/src/lib.rs`.
 */

import { describe, expect, it } from "vitest";
import { assistantText, userMessage, type Message, type StreamEvent } from "@celestea/core";
import {
  eventsOfType,
  harness,
  loggedToolResults,
  ScriptedLlm,
  ScriptLlm,
  ThrowingToolRegistry,
  toolCallMessage,
} from "./fakes.test-util.js";
import { createUsageTracker } from "./usage.js";

/** `StreamEvent::Done(message)`. */
function done(message: Message): StreamEvent {
  return { kind: "done", message };
}

/** One tool-call step followed by a plain answer. */
function toolTurn(ids: readonly string[], maxParallel = 4) {
  return harness({
    llm: new ScriptedLlm([[done(toolCallMessage(ids))], [done(assistantText("done"))]]),
    config: { max_parallel_tool_calls: maxParallel },
  });
}

describe("tool dispatch", () => {
  it("dispatches every call of a step in model order and logs results in that order", async () => {
    const h = toolTurn(["c1", "c2", "c3"]);

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(h.registry.order).toEqual(["c1", "c2", "c3"]);
    expect(loggedToolResults(h.session)).toEqual(["c1", "c2", "c3"]);
    const kinds = h.session.events().map((e) => e.type);
    expect(kinds.lastIndexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_result"));
  });

  it("runs a batch concurrently up to the limit, keeping result order deterministic", async () => {
    const h = toolTurn(["c1", "c2", "c3", "c4", "c5"], 2);

    await h.run();

    expect(h.registry.order).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(h.registry.maxActive).toBe(2);
    expect(loggedToolResults(h.session)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("clamps a zero parallelism limit to serial dispatch", async () => {
    const h = toolTurn(["c1", "c2", "c3"], 0);

    await h.run();

    expect(h.registry.order).toEqual(["c1", "c2", "c3"]);
    expect(h.registry.maxActive).toBe(1);
  });

  it("contains a rejected dispatch as a tool_result error instead of losing the turn", async () => {
    const h = harness({
      llm: new ScriptedLlm([[done(toolCallMessage(["c1"]))], [done(assistantText("done"))]]),
      registry: new ThrowingToolRegistry(),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(eventsOfType(h.session, "tool_result")[0]?.error).toBe("registry exploded for c1");
    expect(eventsOfType(h.session, "assistant_message")[0]?.text).toBe("done");
  });

  it("sends the model, the system prompt and the tool schemas in the request", async () => {
    const llm = new ScriptLlm([done(assistantText("ok"))]);
    await harness({ llm, config: { model: "deepseek-chat", system_prompt: "be brief" } }).run("hello");

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toEqual({
      model: "deepseek-chat",
      system: "be brief",
      messages: [],
      tools: [],
      max_tokens: null,
      temperature: null,
    });
  });
});

describe("request history trimming", () => {
  it("trims the derived history to the keep_recent window", async () => {
    const llm = new ScriptLlm([done(assistantText("ok"))]);
    const h = harness({
      llm,
      config: { context_window_tokens: 1000, context_trim_threshold: 0.8, context_keep_recent: 4 },
    });
    const derived: Message[] = [];
    for (let i = 0; i < 30; i++) derived.push(userMessage(`message ${i} `.repeat(20)));
    h.session.setDerived(derived);

    await h.run();

    const sent = llm.requests[0]?.messages ?? [];
    expect(sent).toHaveLength(5);
    expect(sent[0]?.role).toBe("system");
    expect(JSON.stringify(sent[0]?.content[0])).toContain("context-trimmed");
    expect(JSON.stringify(sent[1]?.content[0])).toContain("message 26");
    expect(JSON.stringify(sent[4]?.content[0])).toContain("message 29");
  });

  it("does not trim a small history under the default window", async () => {
    const llm = new ScriptLlm([done(assistantText("ok"))]);
    const h = harness({ llm });
    h.session.setDerived([userMessage("hello"), assistantText("hi")]);

    await h.run();

    const sent = llm.requests[0]?.messages ?? [];
    expect(sent).toHaveLength(2);
    expect(sent.some((m) => m.role === "system")).toBe(false);
  });

  it("leaves the history untouched when trimming is disabled", async () => {
    const llm = new ScriptLlm([done(assistantText("ok"))]);
    const h = harness({ llm, config: { context_window_tokens: 0 } });
    h.session.setDerived([userMessage("x".repeat(4000)), userMessage("y".repeat(4000))]);

    await h.run();

    expect(llm.requests[0]?.messages).toHaveLength(2);
  });
});

describe("usage recording", () => {
  it("accumulates every stream's usage into the bound tracker", async () => {
    const tracker = createUsageTracker();
    const h = harness({
      llm: new ScriptLlm([
        { kind: "text", text: "answer" },
        {
          kind: "usage",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read: 3, reasoning_tokens: 2 },
        },
        done(assistantText("answer")),
      ]),
      bindings: { usage: tracker },
    });

    await h.run();

    expect(tracker.latest().total_tokens).toBe(15);
    expect(tracker.latest().cache_read).toBe(3);
    expect(tracker.latest().reasoning_tokens).toBe(2);
    expect(tracker.total().total_tokens).toBe(15);
    expect(tracker.total().prompt_tokens).toBe(10);
  });

  it("accumulates across steps and exposes the tracker on the loop", async () => {
    const tracker = createUsageTracker();
    const usage = (total: number): StreamEvent => ({
      kind: "usage",
      usage: { prompt_tokens: total, completion_tokens: 0, total_tokens: total, cache_read: 0, reasoning_tokens: 0 },
    });
    const h = harness({
      llm: new ScriptedLlm([
        [usage(7), done(toolCallMessage(["c1"]))],
        [usage(3), done(assistantText("done"))],
      ]),
      bindings: { usage: tracker },
    });

    await h.run();

    expect(tracker.latest().total_tokens).toBe(3);
    expect(tracker.total().total_tokens).toBe(10);
    expect(h.loop.usageTracker).toBe(tracker);
  });

  it("ignores usage events when no tracker is bound", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cache_read: 0, reasoning_tokens: 0 } },
        done(assistantText("done")),
      ]),
    });

    expect(await h.run()).toBe("completed");
  });
});
