import { describe, expect, it } from "vitest";
import {
  analyzeReplay,
  auditTurnIds,
  deriveMessages,
  deriveSseTranscript,
  maxTurnNumber,
  nextTurnId,
  outcomeError,
  outcomePhase,
  parseSessionJsonl,
  projectMessages,
  serializeSessionEvent,
  serializeSessionJsonl,
  validateSessionEvent,
} from "@celestea/session";
import type { SessionEvent } from "@celestea/core";

const LOG = [
  '{"type":"turn_start","id":"turn-0"}',
  '{"type":"user_message","text":"hi"}',
  '{"type":"thinking_delta","text":"hmm"}',
  '{"type":"tool_call","id":"c1","name":"run_code","args":{"code":"x"}}',
  '{"type":"tool_call","id":"c1:c1","name":"read_file","args":{"path":"/x"},"parent_id":"c1"}',
  '{"type":"tool_result","id":"c1:c1","value":"data","error":null,"parent_id":"c1"}',
  '{"type":"tool_result","id":"c1","value":{"ok":true},"error":null}',
  '{"type":"assistant_message","text":"done"}',
  '{"type":"turn_end","id":"turn-0","outcome":"completed"}',
  '{"type":"turn_start","id":"turn-1"}',
  '{"type":"user_message","text":"again"}',
  '{"type":"turn_end","id":"turn-1"}',
].join("\n") + "\n";

describe("parseSessionJsonl", () => {
  it("parses every contract variant and skips blank lines", () => {
    const r = parseSessionJsonl(LOG.replace('{"type":"thinking_delta"', '\n{"type":"thinking_delta"'));
    expect(r.tornTail).toBeNull();
    expect(r.events).toHaveLength(12);
    expect(r.blankLines).toBe(1);
  });

  it("stops at the first unparsable line (torn tail) and keeps the prefix", () => {
    const torn = LOG + '{"type":"assistant_message","text":"tru';
    const r = parseSessionJsonl(torn);
    expect(r.events).toHaveLength(12);
    expect(r.tornTail?.line).toBe(13);
  });

  it("stops on a schema-invalid line too", () => {
    const r = parseSessionJsonl('{"type":"turn_start","id":"turn-0"}\n{"type":"nope"}\n');
    expect(r.events).toHaveLength(1);
    expect(r.tornTail?.error).toContain("unknown event type");
  });

  it("treats a legacy turn_end without outcome as completed", () => {
    const r = parseSessionJsonl('{"type":"turn_end","id":"turn-0"}\n');
    expect(r.events).toHaveLength(1);
    expect(outcomePhase((r.events[0] as { outcome?: never })["outcome"])).toBe("completed");
  });

  it("validates the TurnOutcome error shape", () => {
    const bad = validateSessionEvent({ type: "turn_end", id: "turn-0", outcome: { error: { kind: "generate" } } });
    expect(bad.ok).toBe(false);
    const good = validateSessionEvent({ type: "turn_end", id: "turn-0", outcome: { error: { kind: "stream", message: "boom" } } });
    expect(good.ok).toBe(true);
  });
});

describe("serializeSessionEvent", () => {
  it("omits parent_id when absent (pre-W255 byte shape)", () => {
    const ev: SessionEvent = { type: "tool_call", id: "rc1", name: "run_code", args: { code: "pass" } };
    expect(serializeSessionEvent(ev)).toBe('{"type":"tool_call","id":"rc1","name":"run_code","args":{"code":"pass"}}');
  });

  it("keeps parent_id when present", () => {
    const ev: SessionEvent = { type: "tool_call", id: "rc1:c1", name: "read_file", args: { path: "/x" }, parent_id: "rc1" };
    expect(serializeSessionEvent(ev)).toBe('{"type":"tool_call","id":"rc1:c1","name":"read_file","args":{"path":"/x"},"parent_id":"rc1"}');
  });

  it("round-trips the whole log", () => {
    const parsed = parseSessionJsonl(LOG);
    const again = parseSessionJsonl(serializeSessionJsonl(parsed.events));
    expect(again.events).toEqual(parsed.events);
  });
});

describe("turn ids", () => {
  const events = parseSessionJsonl(LOG).events;

  it("is monotonic and allocates turn-2 next", () => {
    expect(maxTurnNumber(events)).toBe(1);
    expect(nextTurnId(events)).toBe("turn-2");
    expect(auditTurnIds(events).nonMonotonic).toHaveLength(0);
    expect(auditTurnIds(events).malformed).toHaveLength(0);
  });

  it("detects a non-monotonic id", () => {
    const bad = parseSessionJsonl('{"type":"turn_start","id":"turn-3"}\n{"type":"turn_start","id":"turn-2"}\n').events;
    expect(auditTurnIds(bad).nonMonotonic).toHaveLength(1);
  });
});

describe("projections", () => {
  const events = parseSessionJsonl(LOG).events;

  it("Studio projection keeps thinking and run_code sub-calls", () => {
    const msgs = projectMessages(events);
    expect(msgs).toHaveLength(8);
    expect(msgs[1]).toEqual({ role: "thinking", content: "hmm" });
    const sub = msgs.find((m) => "tool_parent_id" in m && m.tool_parent_id === "c1");
    expect(sub).toBeDefined();
    const call = msgs[2] as unknown as Record<string, unknown>;
    expect(call["content"]).toBeUndefined();
  });

  it("engine projection drops thinking, turn markers and sub-calls", () => {
    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(msgs.some((m) => m.tool_call_id === "c1:c1")).toBe(false);
  });
});

describe("replay analysis", () => {
  it("counts dangling tool calls and sub-calls", () => {
    const parsed = parseSessionJsonl(
      '{"type":"turn_start","id":"turn-0"}\n{"type":"tool_call","id":"a","name":"run_shell","args":{}}\n{"type":"tool_call","id":"a:c1","name":"read_file","args":{},"parent_id":"a"}\n',
    );
    const s = analyzeReplay(parsed);
    expect(s.danglingToolCalls).toEqual([{ id: "a", name: "run_shell" }, { id: "a:c1", name: "read_file" }]);
    expect(s.subCalls).toBe(1);
    expect(s.subCallParents).toEqual(["a"]);
    expect(s.danglingTurns).toBe(1);
  });

  it("maps outcomes to phases and errors", () => {
    expect(outcomePhase("step_limit")).toBe("step_limit");
    expect(outcomePhase({ error: { kind: "stream", message: "x" } })).toBe("error");
    expect(outcomeError({ error: { kind: "stream", message: "x" } })).toBe("stream: x");
    expect(outcomeError("cancelled")).toBeNull();
  });

  it("derives an SSE transcript with the envelope", () => {
    const frames = deriveSseTranscript(parseSessionJsonl(LOG).events);
    expect(frames[0]?.event).toBe("status");
    expect(frames[0]?.data.turn).toBe(1);
    expect(frames.map((f) => f.event)).toContain("thinking");
    expect(frames.map((f) => f.event)).toContain("turn_end");
    expect(frames.map((f) => f.data.seq)).toEqual(frames.map((_f, i) => i));
  });
});
