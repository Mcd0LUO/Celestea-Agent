/**
 * SessionEvent codec — the serde contract of `crates/core/src/session_log.rs`.
 * Every case below mirrors a Rust serde test (legacy rows, parent_id omission,
 * ThinkingDelta round-trip) plus the Option-field rules read off the derive.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_OUTCOME,
  effectiveOutcome,
  isTurnOutcome,
  outcomeError,
  outcomePhase,
  parseSessionEvent,
  serializeSessionEvent,
  validateSessionEvent,
} from "./session-event.js";
import type { SessionEvent } from "./types.js";

const LEGACY_ROWS = [
  '{"type":"turn_start","id":"turn-0"}',
  '{"type":"user_message","text":"hi"}',
  '{"type":"assistant_message","text":"hello"}',
  '{"type":"tool_call","id":"c1","name":"f","args":{}}',
  '{"type":"tool_result","id":"c1","value":true,"error":null}',
  '{"type":"turn_end","id":"turn-0"}',
];

describe("serde-exact round-trip", () => {
  const cases: SessionEvent[] = [
    { type: "turn_start", id: "turn-0" },
    { type: "turn_start", id: "turn-0", },
    { type: "user_message", text: "hi" },
    { type: "assistant_message", text: "hello" },
    { type: "thinking_delta", text: "let me think…" },
    { type: "tool_call", id: "c1", name: "f", args: { b: 1, a: [1, 2] } },
    { type: "tool_call", id: "rc1:c1", name: "read_file", args: { path: "/x" }, parent_id: "rc1" },
    { type: "tool_result", id: "c1", value: { ok: true }, error: null },
    { type: "tool_result", id: "c1", value: null, error: "boom" },
    { type: "tool_result", id: "rc1:c1", value: "x", error: null, parent_id: "rc1" },
    { type: "turn_end", id: "turn-0", outcome: "cancelled" },
    { type: "turn_end", id: "turn-0", outcome: "step_limit" },
    { type: "turn_end", id: "turn-0", outcome: "interrupted" },
    { type: "turn_end", id: "turn-0", outcome: { error: { kind: "stream", message: "boom" } } },
  ];

  for (const ev of cases) {
    it(`round-trips ${ev.type}${ev.type === "turn_end" ? ` (${typeof ev.outcome === "string" ? ev.outcome : "error"})` : ""}`, () => {
      const line = serializeSessionEvent(ev);
      const back = parseSessionEvent(line);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.event).toEqual(ev);
    });
  }

  it("writes the tag first and the fields in declaration order", () => {
    expect(serializeSessionEvent({ type: "tool_call", id: "c1", name: "f", args: {}, parent_id: "p" })).toBe(
      '{"type":"tool_call","id":"c1","name":"f","args":{},"parent_id":"p"}',
    );
    expect(serializeSessionEvent({ type: "turn_end", id: "t" })).toBe('{"type":"turn_end","id":"t","outcome":"completed"}');
  });

  it("sorts nested Value keys and nulls absent Options (serde_json BTreeMap)", () => {
    expect(serializeSessionEvent({ type: "tool_result", id: "c1", value: { b: 2, a: 1 }, error: null })).toBe(
      '{"type":"tool_result","id":"c1","value":{"a":1,"b":2},"error":null}',
    );
    // A legacy in-memory row may still carry `value: undefined` (serde's None).
    expect(serializeSessionEvent({ type: "tool_result", id: "c1", value: undefined, error: null })).toBe(
      '{"type":"tool_result","id":"c1","value":null,"error":null}',
    );
  });

  it("omits parent_id when absent (W255 byte shape)", () => {
    expect(serializeSessionEvent({ type: "tool_call", id: "rc1", name: "run_code", args: { code: "pass" } })).toBe(
      '{"type":"tool_call","id":"rc1","name":"run_code","args":{"code":"pass"}}',
    );
  });
});

describe("legacy rows (purely additive fields)", () => {
  it("parses every pre-W252/W255 row unchanged", () => {
    for (const line of LEGACY_ROWS) {
      const r = parseSessionEvent(line);
      expect(r.ok, line).toBe(true);
      if (r.ok) expect(r.event.type).not.toBe("thinking_delta");
    }
  });

  it("reads a legacy turn_end as completed and re-writes the outcome", () => {
    const r = parseSessionEvent('{"type":"turn_end","id":"turn-0"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toEqual({ type: "turn_end", id: "turn-0", outcome: "completed" });
    expect(serializeSessionEvent({ type: "turn_end", id: "turn-0" })).toContain('"outcome":"completed"');
  });

  it("treats missing value/error as None (serde Option fields)", () => {
    const r = parseSessionEvent('{"type":"tool_result","id":"c1"}');
    expect(r.ok).toBe(true);
    if (r.ok && r.event.type === "tool_result") {
      expect(r.event.value).toBeUndefined();
      expect(r.event.error).toBeNull();
    }
  });

  it("treats a JSON null parent_id as absent", () => {
    const r = parseSessionEvent('{"type":"tool_call","id":"c1","name":"f","args":{},"parent_id":null}');
    expect(r.ok).toBe(true);
    if (r.ok && r.event.type === "tool_call") expect(r.event.parent_id).toBeUndefined();
  });

  it("ignores unknown fields (serde default tolerance)", () => {
    const r = parseSessionEvent('{"type":"user_message","text":"hi","future_field":1}');
    expect(r.ok).toBe(true);
  });
});

describe("rejections (the caller treats them as a torn tail)", () => {
  const bad = [
    '{"type":"nope"}',
    '{"type":"user_message"}',
    '{"type":"tool_call","id":"c1","name":"f"}',
    '{"type":"turn_end","id":"t","outcome":{"error":{"kind":"generate"}}}',
    '{"type":"tool_result","id":"c1","error":5}',
    '{"type":"user_message","text":5}',
    'not json',
    '[1,2]',
  ];
  for (const line of bad) {
    it(`rejects ${line.slice(0, 44)}`, () => {
      expect(parseSessionEvent(line).ok).toBe(false);
    });
  }

  it("accepts only the five TurnOutcome states", () => {
    expect(isTurnOutcome("completed")).toBe(true);
    expect(isTurnOutcome("interrupted")).toBe(true);
    expect(isTurnOutcome({ error: { kind: "stream", message: "x" } })).toBe(true);
    expect(isTurnOutcome("done")).toBe(false);
    expect(isTurnOutcome({ error: { kind: "generate" } })).toBe(false);
  });
});

describe("outcome helpers", () => {
  it("maps the five states to phases and errors", () => {
    expect(DEFAULT_TURN_OUTCOME).toBe("completed");
    expect(effectiveOutcome(undefined)).toBe("completed");
    expect(outcomePhase(undefined)).toBe("completed");
    expect(outcomePhase("step_limit")).toBe("step_limit");
    expect(outcomePhase({ error: { kind: "generate", message: "x" } })).toBe("error");
    expect(outcomeError(undefined)).toBeNull();
    expect(outcomeError({ error: { kind: "stream", message: "x" } })).toBe("stream: x");
  });

  it("reports a decoded object instead of a malformed string", () => {
    expect(validateSessionEvent({ type: "turn_start", id: 5 }).ok).toBe(false);
  });
});
