/**
 * DefaultAgentLoop turn/step tests — the TS mirror of the turn-level cases of
 * `crates/agent-loop/src/lib.rs` (stream consumption, thinking aggregation,
 * deferred Done, five real terminal states, unique turn ids).
 */

import { describe, expect, it } from "vitest";
import {
  assistantText,
  AgentError,
  Context,
  type Llm,
  type Message,
  type StreamEvent,
  type TurnOutcome,
} from "@celestea/core";
import {
  eventsOfType,
  FailingLlm,
  FakeSessionLog,
  harness,
  HangingLlm,
  lastOutcome,
  loggedToolCalls,
  persistedKinds,
  makeLoop,
  ScriptedLlm,
  ScriptLlm,
  toolCallMessage,
  type Harness,
} from "./fakes.test-util.js";
import { createUsageTracker } from "./usage.js";

/** `StreamEvent::Done(message)`. */
function done(message: Message): StreamEvent {
  return { kind: "done", message };
}

/** One harness per terminal state, all reaching the same single exit point. */
function terminalScenarios(): Array<{ name: string; outcome: TurnOutcome; make: () => Harness }> {
  const aborted = new AbortController();
  aborted.abort();
  return [
    {
      name: "completed",
      outcome: "completed",
      make: () => harness({ llm: new ScriptLlm([done(assistantText("done"))]) }),
    },
    {
      name: "error",
      outcome: { error: { kind: "generate", message: "provider timeout" } },
      make: () => harness({ llm: new FailingLlm() }),
    },
    {
      name: "step_limit",
      outcome: "step_limit",
      make: () => harness({ llm: new ScriptLlm([done(toolCallMessage(["c1"]))]), config: { max_steps: 1 } }),
    },
    {
      name: "interrupted",
      outcome: "interrupted",
      make: () => harness({ llm: new ScriptLlm([{ kind: "text", text: "trunc" }]) }),
    },
    {
      name: "cancelled",
      outcome: "cancelled",
      make: () => harness({ llm: new HangingLlm(), bindings: { signal: aborted.signal } }),
    },
  ];
}

describe("DefaultAgentLoop — stream consumption", () => {
  it("consumes a thinking stream and persists exactly one assistant message", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "Let me think." },
        { kind: "text", text: " answer" },
        done(assistantText(" answer")),
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(eventsOfType(h.session, "assistant_message").map((e) => e.text)).toEqual([" answer"]);
    expect(persistedKinds(h.session)).toEqual(["thinking:Let me think.", "assistant: answer"]);
  });

  it("logs turn_start/user_message then the reply, and ends with turn_end", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });

    await h.run("hi");

    expect(h.session.events().map((e) => e.type)).toEqual([
      "turn_start",
      "user_message",
      "assistant_message",
      "turn_end",
    ]);
    expect(eventsOfType(h.session, "turn_start")[0]?.id).toBe("turn-0");
    expect(eventsOfType(h.session, "user_message")[0]?.text).toBe("hi");
    expect(lastOutcome(h.session)).toBe("completed");
  });

  it("delivers stream events to the sink in emission order", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "think." },
        { kind: "text", text: " hi" },
        done(assistantText(" hi")),
      ]),
    });

    await h.run();

    expect(h.sink.kinds()).toEqual(["thinking", "text", "done", "turn_end"]);
    const doneEvent = h.sink.events[2];
    expect(doneEvent).toMatchObject({ kind: "done", text: " hi", tool_calls: [] });
  });

});

describe("DefaultAgentLoop — tool steps", () => {
  it("runs a tool-call step and then the final answer", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [{ kind: "text", text: "all done" }, done(assistantText("all done"))],
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(loggedToolCalls(h.session)).toEqual(["c1"]);
    expect(persistedKinds(h.session)).toEqual(["toolcall:c1", "toolresult:c1", "assistant:all done"]);
    expect(h.sink.kinds()).toEqual(["done", "tool_call", "tool_result", "text", "done", "turn_end"]);
  });

});

describe("DefaultAgentLoop — terminal states", () => {
  it("marks a generation failure as error{generate} with a TurnEnd and no reply", async () => {
    const h = harness({ llm: new FailingLlm() });

    const outcome = await h.run();

    // The terminal state rides the log, the promise still resolves (P0-A).
    expect(outcome).toEqual({ error: { kind: "generate", message: "provider timeout" } });
    expect(lastOutcome(h.session)).toEqual({ error: { kind: "generate", message: "provider timeout" } });
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(h.sink.kinds()).toEqual(["turn_end"]);
  });

  it("marks a stream failure as error{stream} and never flushes a partial reply", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "text", text: "partial" },
        { kind: "failed", kindOf: "stream", message: "sse decode error: torn" },
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ error: { kind: "stream", message: "sse decode error: torn" } });
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
  });

  it("marks a torn stream (no terminal frame) as interrupted", async () => {
    const h = harness({ llm: new ScriptLlm([{ kind: "text", text: "trunc" }]) });

    const outcome = await h.run();

    expect(outcome).toBe("interrupted");
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
  });

  it("marks an exhausted step budget as step_limit, never completed", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [done(toolCallMessage(["c2"]))],
        [done(assistantText("never reached"))],
      ]),
      config: { max_steps: 2 },
    });

    const outcome = await h.run();

    expect(outcome).toBe("step_limit");
    expect(h.registry.order).toEqual(["c1", "c2"]);
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(persistedKinds(h.session)).toEqual(["toolcall:c1", "toolresult:c1", "toolcall:c2", "toolresult:c2"]);
  });

});

describe("DefaultAgentLoop — bookkeeping", () => {
  it("treats max_steps = 0 as unlimited", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [done(toolCallMessage(["c2"]))],
        [done(toolCallMessage(["c3"]))],
        [done(assistantText("done"))],
      ]),
      config: { max_steps: 0 },
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(h.registry.order).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps turn ids unique across loop instances (the log owns the counter)", async () => {
    const session = new FakeSessionLog();
    const llm = new ScriptLlm([done(assistantText("a"))]);
    await harness({ llm, session }).run();
    await harness({ llm, session }).run();

    expect(eventsOfType(session, "turn_start").map((e) => e.id)).toEqual(["turn-0", "turn-1"]);
    expect(eventsOfType(session, "turn_end").map((e) => e.id)).toEqual(["turn-0", "turn-1"]);
  });

  it("aggregates one contiguous thinking burst into one persisted row", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "part one." },
        { kind: "thinking", text: " part two." },
        { kind: "text", text: " hi" },
        { kind: "thinking", text: "recheck." },
        done(assistantText(" hi")),
      ]),
    });

    await h.run();

    expect(persistedKinds(h.session)).toEqual(["thinking:part one. part two.", "thinking:recheck.", "assistant: hi"]);
    expect(eventsOfType(h.session, "thinking_delta")).toHaveLength(2);
    // live deltas are still emitted one by one
    expect(h.sink.kinds().filter((k) => k === "thinking")).toHaveLength(3);
  });

  it("persists aggregated thinking before the tool calls of the same step", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [{ kind: "thinking", text: "plan tool use." }, done(toolCallMessage(["c1"]))],
        [done(assistantText("done"))],
      ]),
    });

    await h.run();

    expect(persistedKinds(h.session)).toEqual(["thinking:plan tool use.", "toolcall:c1", "toolresult:c1", "assistant:done"]);
  });

  it("emits trailing reasoning before the deferred Done", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "early." },
        { kind: "text", text: " hi" },
        done(assistantText(" hi")),
        { kind: "thinking", text: "late." },
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(h.sink.kinds()).toEqual(["thinking", "text", "thinking", "done", "turn_end"]);
    // the late burst still lands before the reply it belongs to
    expect(persistedKinds(h.session)).toEqual(["thinking:early.", "thinking:late.", "assistant: hi"]);
  });

  it("writes exactly one TurnEnd on every terminal path", async () => {
    for (const scenario of terminalScenarios()) {
      const h = scenario.make();
      const outcome = await h.run();
      expect(outcome, scenario.name).toEqual(scenario.outcome);
      expect(eventsOfType(h.session, "turn_end"), scenario.name).toHaveLength(1);
      expect(h.sink.events.filter((e) => e.kind === "turn_end"), scenario.name).toHaveLength(1);
      expect(h.sink.events.at(-1)?.kind, scenario.name).toBe("turn_end");
    }
  });

  it("rejects with AgentError when the Context is missing a driver seam", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });
    const bare = Context.root();
    bare.provide("celestea.core.Llm", h.ctx.get("celestea.core.Llm") as Llm);

    await expect(h.loop.runTurn(bare, "hi")).rejects.toThrow(AgentError);
    await expect(h.loop.runTurn(bare, "hi")).rejects.toThrow(/missing SessionLog service/);
  });

  it("exposes its config and the bound usage tracker", () => {
    const tracker = createUsageTracker();
    expect(makeLoop({ max_steps: 3 }, { usage: tracker }).agentConfig.max_steps).toBe(3);
    expect(makeLoop({}, { usage: tracker }).usageTracker).toBe(tracker);
    expect(makeLoop({}).usageTracker).toBeUndefined();
  });
});
