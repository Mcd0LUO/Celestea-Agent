/**
 * File-level JSONL contract: one SessionEvent per line, blank lines are
 * padding, parsing stops at the first unparsable line (a torn tail is never
 * content), and a re-serialized log round-trips byte for byte.
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { parseSessionJsonl, serializeSessionJsonl, serializeSessionEvent } from "./jsonl.js";

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
    expect(r.parsedLines).toBe(12);
  });

  it("stops at the first unparsable line and keeps the prefix", () => {
    const r = parseSessionJsonl(`${LOG}{"type":"assistant_message","text":"tru`);
    expect(r.events).toHaveLength(12);
    expect(r.tornTail?.line).toBe(13);
    expect(r.tornTail?.raw).toBe('{"type":"assistant_message","text":"tru');
  });

  it("stops on a schema-invalid line too", () => {
    const r = parseSessionJsonl('{"type":"turn_start","id":"turn-0"}\n{"type":"nope"}\n');
    expect(r.events).toHaveLength(1);
    expect(r.tornTail?.error).toContain("unknown event type");
  });

  it("treats a whitespace-only line as unparsable, like Rust replay", () => {
    const r = parseSessionJsonl('{"type":"user_message","text":"a"}\n   \n{"type":"user_message","text":"b"}\n');
    expect(r.events).toHaveLength(1);
    expect(r.tornTail?.line).toBe(2);
  });

  it("accepts CRLF line endings", () => {
    const r = parseSessionJsonl('{"type":"user_message","text":"a"}\r\n{"type":"user_message","text":"b"}\r\n');
    expect(r.tornTail).toBeNull();
    expect(r.events).toHaveLength(2);
  });

  it("fills the legacy turn_end outcome with `completed`", () => {
    const r = parseSessionJsonl('{"type":"turn_end","id":"turn-0"}\n');
    expect(r.events[0]).toEqual({ type: "turn_end", id: "turn-0", outcome: "completed" });
  });
});

describe("serializeSessionJsonl", () => {
  it("round-trips a fully-specified log byte for byte (serde field order)", () => {
    const full = LOG.replace('{"type":"turn_end","id":"turn-1"}', '{"type":"turn_end","id":"turn-1","outcome":"completed"}');
    const parsed = parseSessionJsonl(full);
    expect(serializeSessionJsonl(parsed.events)).toBe(full);
  });

  it("re-writes a legacy row WITH the defaulted outcome, like serde", () => {
    const parsed = parseSessionJsonl(LOG);
    const expected = LOG.replace('{"type":"turn_end","id":"turn-1"}', '{"type":"turn_end","id":"turn-1","outcome":"completed"}');
    expect(serializeSessionJsonl(parsed.events)).toBe(expected);
  });

  it("omits parent_id when absent (pre-W255 byte shape)", () => {
    const ev: SessionEvent = { type: "tool_call", id: "rc1", name: "run_code", args: { code: "pass" } };
    expect(serializeSessionEvent(ev)).toBe('{"type":"tool_call","id":"rc1","name":"run_code","args":{"code":"pass"}}');
  });

  it("keeps parent_id when present", () => {
    const ev: SessionEvent = { type: "tool_call", id: "rc1:c1", name: "read_file", args: { path: "/x" }, parent_id: "rc1" };
    expect(serializeSessionEvent(ev)).toBe(
      '{"type":"tool_call","id":"rc1:c1","name":"read_file","args":{"path":"/x"},"parent_id":"rc1"}',
    );
  });

  it("always writes value/error/outcome, like serde", () => {
    expect(serializeSessionEvent({ type: "tool_result", id: "c1", value: undefined, error: null })).toBe(
      '{"type":"tool_result","id":"c1","value":null,"error":null}',
    );
    expect(serializeSessionEvent({ type: "turn_end", id: "turn-0" })).toBe(
      '{"type":"turn_end","id":"turn-0","outcome":"completed"}',
    );
  });
});
