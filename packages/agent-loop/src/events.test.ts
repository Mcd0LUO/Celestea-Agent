/**
 * Event-builder and SSE-mapping tests — the TS mirror of
 * `sink_receives_tool_lifecycle_in_order` plus the frozen
 * `contracts/sse-events.json` mapping (`loop_event_to_json`).
 */

import { describe, expect, it } from "vitest";
import { assistantText, type ToolOutput, type TurnOutcome } from "@celestea/core";
import { decisionLabel, doneEvent, toolCallEvent, toolResultEvent, turnEndEvent, type EventSink } from "./events.js";
import { loopEventToSse } from "./sse.js";
import { toolCallMessage } from "./fakes.test-util.js";

const output = (over: Partial<ToolOutput> = {}): ToolOutput => ({
  call_id: "c1",
  value: { ok: true },
  render: "rendered",
  error: null,
  decision: { kind: "allow" },
  ...over,
});

describe("event builders", () => {
  it("flattens a ToolDecision to its label", () => {
    expect(decisionLabel({ kind: "allow" })).toBe("allow");
    expect(decisionLabel({ kind: "deny", reason: "nope" })).toBe("deny");
    expect(decisionLabel({ kind: "ask", reason: "sure?" })).toBe("ask");
    expect(decisionLabel(null)).toBe(null);
  });

  it("carries the full ToolOutput on a tool_result event", () => {
    expect(toolResultEvent(output())).toEqual({
      kind: "tool_result",
      callId: "c1",
      ok: true,
      value: { ok: true },
      render: "rendered",
      error: null,
      decision: "allow",
    });
    expect(toolResultEvent(output({ error: "boom", value: null, decision: null }))).toMatchObject({
      ok: false,
      error: "boom",
      decision: null,
    });
  });

  it("builds tool_call, done and turn_end events", () => {
    expect(toolCallEvent({ id: "c1", name: "read_file", args: { path: "/x" } })).toEqual({
      kind: "tool_call",
      id: "c1",
      name: "read_file",
      args: { path: "/x" },
    });
    expect(doneEvent(toolCallMessage(["c1", "c2"]))).toEqual({
      kind: "done",
      text: "",
      tool_calls: [
        { id: "c1", name: "tool_c1", args: {} },
        { id: "c2", name: "tool_c2", args: {} },
      ],
    });
    expect(doneEvent(assistantText("hello"))).toEqual({ kind: "done", text: "hello", tool_calls: [] });
    expect(turnEndEvent("step_limit")).toEqual({ kind: "turn_end", outcome: "step_limit" });
  });
});

describe("loopEventToSse", () => {
  it("maps every LoopEvent onto its SSE frame", () => {
    expect(loopEventToSse({ kind: "text", delta: "hi" })).toEqual({ event: "text", payload: { delta: "hi" } });
    expect(loopEventToSse({ kind: "thinking", delta: "hmm" })).toEqual({
      event: "thinking",
      payload: { delta: "hmm" },
    });
    expect(loopEventToSse({ kind: "tool_call", id: "c1", name: "t", args: {} })).toEqual({
      event: "tool",
      payload: { id: "c1", name: "t", args: {} },
    });
    expect(loopEventToSse(toolResultEvent(output()))).toEqual({
      event: "tool_result",
      payload: { id: "c1", ok: true, value: { ok: true }, render: "rendered", error: null, decision: "allow" },
    });
    expect(loopEventToSse({ kind: "done", text: "x", tool_calls: [] })).toEqual({
      event: "done",
      payload: { text: "x", tool_calls: [] },
    });
  });

  it("maps the terminal outcome onto phase + error", () => {
    const cases: Array<[TurnOutcome, string, string | null]> = [
      ["completed", "completed", null],
      ["cancelled", "cancelled", null],
      ["step_limit", "step_limit", null],
      ["interrupted", "interrupted", null],
      [{ error: { kind: "stream", message: "torn" } }, "error", "stream: torn"],
    ];
    for (const [outcome, phase, error] of cases) {
      expect(loopEventToSse({ kind: "turn_end", outcome })).toEqual({
        event: "turn_end",
        payload: { outcome: phase, error },
      });
    }
  });

  it("is assignable to the EventSink seam", () => {
    const frames: string[] = [];
    const sink: EventSink = (event) => frames.push(loopEventToSse(event).event);
    sink({ kind: "text", delta: "a" });
    sink(turnEndEvent("completed"));
    expect(frames).toEqual(["text", "turn_end"]);
  });
});
