/**
 * Cooperative-cancellation tests — the TS mirror of the `cancelled_*` and
 * W267 `cancel_during_tool_dispatch_synthesizes_cancelled_results` cases of
 * `crates/agent-loop/src/lib.rs`.
 *
 * Cancellation is driven by an AbortSignal at three checkpoints: before the
 * model step, while consuming the stream, and while a tool batch is in flight.
 */

import { describe, expect, it } from "vitest";
import { assistantText, type LlmStream, type StreamEvent } from "@celestea/core";
import { CANCELLED_BEFORE_EXECUTION } from "./cancel.js";
import {
  eventsOfType,
  FakeToolRegistry,
  harness,
  HangingLlm,
  loggedToolCalls,
  loggedToolResultErrors,
  ScriptLlm,
  toolCallMessage,
  yieldTimes,
} from "./fakes.test-util.js";

/** `StreamEvent::Done(message)`. */
function done(message: ReturnType<typeof assistantText>): StreamEvent {
  return { kind: "done", message };
}

describe("cancel before the turn starts", () => {
  it("records turn_start/user_message and ends cancelled without a reply", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({
      llm: new ScriptLlm([done(assistantText("unused"))]),
      bindings: { signal: controller.signal },
    });

    const outcome = await h.run();

    expect(outcome).toBe("cancelled");
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(h.session.events().map((e) => e.type)).toEqual(["turn_start", "user_message", "turn_end"]);
    expect(h.sink.kinds()).toEqual(["turn_end"]);
  });
});

describe("cancel while consuming the stream", () => {
  it("drops the partial turn, keeps the reasoning already streamed, and emits no Done", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: new HangingLlm([{ kind: "thinking", text: "pondering..." }]),
      bindings: { signal: controller.signal },
      // The abort fires once the loop has consumed the first delta.
      onEvent: (event) => {
        if (event.kind === "thinking") controller.abort();
      },
    });

    const outcome = await h.run();

    expect(outcome).toBe("cancelled");
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(eventsOfType(h.session, "thinking_delta").map((e) => e.text)).toEqual(["pondering..."]);
    expect(h.sink.kinds()).toEqual(["thinking", "turn_end"]);
    expect(eventsOfType(h.session, "turn_end")).toHaveLength(1);
  });

  it("closes the abandoned provider stream", async () => {
    const controller = new AbortController();
    let closed = false;
    const stream: LlmStream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<StreamEvent>>(() => undefined),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const h = harness({
      llm: { generate: async () => stream },
      bindings: { signal: controller.signal },
    });

    const turn = h.run();
    await yieldTimes(5);
    controller.abort();
    const outcome = await turn;

    expect(outcome).toBe("cancelled");
    expect(closed).toBe(true);
  });
});

describe("cancel during tool dispatch (W267)", () => {
  it("synthesizes a cancelled ToolResult for every unanswered call", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: new ScriptLlm([done(toolCallMessage(["c1", "c2", "c3"]))]),
      // Serial dispatch: batch1 = [c1] completes for real, batch2 = [c2] parks.
      registry: new FakeToolRegistry(["c2"]),
      config: { max_parallel_tool_calls: 1 },
      bindings: { signal: controller.signal },
    });
    h.registry.blockingStarted.promise.then(() => controller.abort());

    const outcome = await h.run("hi");

    // Dispatch stopped with the cancelled batch: c3 never ran.
    expect(outcome).toBe("cancelled");
    expect(h.registry.order).toEqual(["c1", "c2"]);

    // Every ToolCall of the step has exactly one ToolResult, in call order.
    expect(loggedToolCalls(h.session)).toEqual(["c1", "c2", "c3"]);
    expect(loggedToolResultErrors(h.session)).toEqual([
      ["c1", null],
      ["c2", CANCELLED_BEFORE_EXECUTION],
      ["c3", CANCELLED_BEFORE_EXECUTION],
    ]);
  });

  it("keeps the real result verbatim and the synthetic tail in model order", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: new ScriptLlm([done(toolCallMessage(["c1", "c2", "c3"]))]),
      registry: new FakeToolRegistry(["c2"]),
      config: { max_parallel_tool_calls: 1 },
      bindings: { signal: controller.signal },
    });
    h.registry.blockingStarted.promise.then(() => controller.abort());
    await h.run("hi");

    const rows = eventsOfType(h.session, "tool_result");
    const real = rows.find((row) => row.id === "c1");
    expect(real?.value).toEqual({ ok: true });
    expect(real?.error).toBeNull();
    for (const id of ["c2", "c3"]) {
      const synthetic = rows.find((row) => row.id === id);
      expect(synthetic?.value, `synthetic ${id} carries no value`).toBeNull();
      expect(synthetic?.error, `synthetic ${id} is marked cancelled`).toBe(CANCELLED_BEFORE_EXECUTION);
    }
    // No call id may get two results.
    const claimed = rows.map((row) => row.id);
    expect([...new Set(claimed)]).toHaveLength(claimed.length);

    // Ordering: ToolCalls < real result < synthetic results < TurnEnd.
    const log = h.session.events();
    const isSynthetic = (e: (typeof log)[number]): boolean => e.type === "tool_result" && e.error !== null;
    const lastCall = log.findLastIndex((e) => e.type === "tool_call");
    const firstResult = log.findIndex((e) => e.type === "tool_result");
    const realResult = log.findIndex((e) => e.type === "tool_result" && e.error === null);
    const firstSynthetic = log.findIndex(isSynthetic);
    const lastSynthetic = log.findLastIndex(isSynthetic);
    const turnEnd = log.findIndex((e) => e.type === "turn_end");
    expect(lastCall).toBeLessThan(firstResult);
    expect(realResult).toBeLessThan(firstSynthetic);
    expect(lastSynthetic).toBeLessThan(turnEnd);
    expect(log.filter(isSynthetic).map((e) => (e.type === "tool_result" ? e.id : ""))).toEqual(["c2", "c3"]);
  });

  it("pairs the log with the event stream: 3 calls, 3 results, one cancelled TurnEnd", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: new ScriptLlm([done(toolCallMessage(["c1", "c2", "c3"]))]),
      registry: new FakeToolRegistry(["c2"]),
      config: { max_parallel_tool_calls: 1 },
      bindings: { signal: controller.signal },
    });
    h.registry.blockingStarted.promise.then(() => controller.abort());
    await h.run("hi");

    const callIds = h.sink.events.flatMap((e) => (e.kind === "tool_call" ? [e.id] : []));
    expect(callIds).toEqual(["c1", "c2", "c3"]);
    const results = h.sink.events.flatMap((e) =>
      e.kind === "tool_result" ? [[e.callId, e.error, e.ok]] : [],
    );
    expect(results).toEqual([
      ["c1", null, true],
      ["c2", CANCELLED_BEFORE_EXECUTION, false],
      ["c3", CANCELLED_BEFORE_EXECUTION, false],
    ]);
    // One Done for the tool-call step, no Done for a second step, one TurnEnd.
    expect(h.sink.events.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(h.sink.events.at(-1)).toEqual({ kind: "turn_end", outcome: "cancelled" });
  });
});
