/**
 * derive_messages parity suite — every case is a port of a Rust unit test in
 * `crates/session/src/log.rs` (test names kept recognisable), plus two cases
 * verified against the real engine through the read-only parity probe:
 *   - the W267 synthetic-result text;
 *   - the `balance_tool_calls` cursor quirk (`i = j + inserted + 1`).
 */

import { describe, expect, it } from "vitest";
import { messageText, messageToolCalls, toolCallIds, type SessionEvent, type TurnOutcome } from "@celestea/core";
import { CANCELLED_TOOL_CALL_TEXT, balanceToolCalls, deriveMessagesFrom, projectEvent, toolResultText } from "./derive.js";

const user = (text: string): SessionEvent => ({ type: "user_message", text });
const assistant = (text: string): SessionEvent => ({ type: "assistant_message", text });
const thinking = (text: string): SessionEvent => ({ type: "thinking_delta", text });
const turnStart = (id: string): SessionEvent => ({ type: "turn_start", id });
const turnEnd = (id: string, outcome: TurnOutcome = "completed"): SessionEvent => ({ type: "turn_end", id, outcome });
const call = (id: string, name = "run_shell", args: unknown = { command: "echo hi" }, parent_id?: string): SessionEvent => {
  const ev: SessionEvent = { type: "tool_call", id, name, args };
  if (parent_id !== undefined) ev.parent_id = parent_id;
  return ev;
};
const result = (id: string, value: unknown, error: string | null = null, parent_id?: string): SessionEvent => {
  const ev: SessionEvent = { type: "tool_result", id, value, error };
  if (parent_id !== undefined) ev.parent_id = parent_id;
  return ev;
};

describe("deriveMessagesFrom", () => {
  it("derives nothing from an empty log", () => {
    expect(deriveMessagesFrom([])).toEqual([]);
  });

  it("skips turn markers and thinking deltas (W252)", () => {
    const msgs = deriveMessagesFrom([turnStart("turn-0"), user("hi"), thinking("private reasoning"), assistant("answer"), turnEnd("turn-0")]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messageText(msgs[1]!)).toBe("answer");
  });

  it("merges consecutive tool calls into ONE assistant message", () => {
    const msgs = deriveMessagesFrom([call("c1"), call("c2"), call("c3")]);
    // W267: the three dangling calls each get a synthetic cancelled result.
    expect(msgs).toHaveLength(4);
    expect(toolCallIds(msgs[0]!)).toEqual(["c1", "c2", "c3"]);
    for (const [i, id] of ["c1", "c2", "c3"].entries()) {
      expect(msgs[i + 1]!.role).toBe("tool");
      expect(msgs[i + 1]!.tool_call_id).toBe(id);
      expect(messageText(msgs[i + 1]!)).toBe(CANCELLED_TOOL_CALL_TEXT);
    }
  });

  it("flushes pending calls before a following non-tool event", () => {
    const msgs = deriveMessagesFrom([call("c9", "list_dir", { path: "/tmp" }), user("after")]);
    expect(msgs).toHaveLength(3);
    expect(toolCallIds(msgs[0]!)).toEqual(["c9"]);
    expect(msgs[1]!.role).toBe("tool");
    expect(msgs[1]!.tool_call_id).toBe("c9");
    expect(messageText(msgs[2]!)).toBe("after");
  });

  it("projects a full turn exactly like the Rust roundtrip test", () => {
    const msgs = deriveMessagesFrom([
      turnStart("t1"),
      user("hello"),
      assistant("hi there"),
      call("c1", "read_file", { path: "/tmp/x" }),
      call("c2", "write_file", { path: "/tmp/y", content: "z" }),
      result("c1", { ok: true }),
      result("c2", null, "boom"),
      turnEnd("t1"),
    ]);
    expect(msgs).toHaveLength(5);
    expect(msgs[0]!.role).toBe("user");
    expect(messageText(msgs[0]!)).toBe("hello");
    expect(messageText(msgs[1]!)).toBe("hi there");
    const calls = messageToolCalls(msgs[2]!);
    expect(calls.map((c) => [c.id, c.name])).toEqual([
      ["c1", "read_file"],
      ["c2", "write_file"],
    ]);
    expect(msgs[3]!.tool_call_id).toBe("c1");
    expect(messageText(msgs[3]!)).toBe('{"ok":true}');
    expect(msgs[4]!.tool_call_id).toBe("c2");
    expect(messageText(msgs[4]!)).toBe("Error: boom");
  });

  it("keeps run_code sub-call rows out of the model history (W255)", () => {
    const msgs = deriveMessagesFrom([
      user("fold this"),
      call("rc1", "run_code", { code: "pass" }),
      call("rc1:c1", "read_file", { path: "/tmp/x" }, "rc1"),
      result("rc1:c1", "first line", null, "rc1"),
      result("rc1", "first line"),
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("user");
    expect(toolCallIds(msgs[1]!)).toEqual(["rc1"]);
    expect(msgs[2]!.tool_call_id).toBe("rc1");
    expect(messageText(msgs[2]!)).toBe('"first line"');
  });

  it("balances a dangling call even when the log ends mid-turn", () => {
    const msgs = deriveMessagesFrom([user("go"), call("c1"), turnEnd("turn-0", "cancelled"), turnStart("turn-1"), user("again")]);
    const callIndex = msgs.findIndex((m) => toolCallIds(m).includes("c1"));
    expect(msgs[callIndex + 1]!.role).toBe("tool");
    expect(msgs[callIndex + 1]!.tool_call_id).toBe("c1");
    expect(msgs.slice(callIndex + 2).some((m) => m.role === "user")).toBe(true);
  });

  it("does not duplicate the result of an answered call", () => {
    const msgs = deriveMessagesFrom([user("go"), call("c9"), result("c9", { stdout: "hi" })]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool_call_id).toBe("c9");
  });

  /**
   * Rust-verified quirk (probe output, /tmp/quirk.jsonl): when a call message is
   * fully answered, the cursor jumps to `j + inserted + 1`, so the message right
   * after the results is never balance-checked. A trailing unbalanced call in
   * exactly that position stays unbalanced — ported unchanged for parity.
   */
  it("mirrors the upstream cursor quirk (unbalanced trailing call is skipped)", () => {
    const msgs = deriveMessagesFrom([user("go"), call("c1", "run_shell", { command: "echo hi" }), result("c1", { stdout: "hi" }), call("c2", "run_shell", { command: "sleep 1" })]);
    expect(msgs).toHaveLength(4);
    expect(msgs[3]!.role).toBe("assistant");
    expect(toolCallIds(msgs[3]!)).toEqual(["c2"]);
    expect(msgs.some((m) => m.role === "tool" && m.tool_call_id === "c2")).toBe(false);
  });

  it("balances the same trailing call once a marker separates it", () => {
    // Same log, but a turn boundary sits between the answered call and the
    // dangling one: the cursor no longer skips it (Rust probe /tmp/nonquirk.jsonl).
    const msgs = deriveMessagesFrom([
      user("go"),
      call("c1", "run_shell", { command: "echo hi" }),
      result("c1", { stdout: "hi" }),
      turnEnd("turn-0", "cancelled"),
      turnStart("turn-1"),
      user("again"),
      call("c2", "run_shell", { command: "sleep 1" }),
    ]);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("c2");
    expect(messageText(last)).toBe(CANCELLED_TOOL_CALL_TEXT);
  });
});

describe("projectEvent / toolResultText", () => {
  it("renders a non-empty error as `Error: {err}`", () => {
    expect(toolResultText("boom", { ignored: true })).toBe("Error: boom");
  });

  it("falls back to the JSON value when the error is empty or absent (Rust test)", () => {
    expect(toolResultText("", "fallback")).toBe('"fallback"');
    expect(toolResultText(null, { a: 1 })).toBe('{"a":1}');
    expect(toolResultText(null, null)).toBe("null");
    expect(toolResultText(undefined, undefined)).toBe("null");
  });

  it("returns null for the events the model never sees", () => {
    expect(projectEvent(turnStart("turn-0"))).toBeNull();
    expect(projectEvent(turnEnd("turn-0"))).toBeNull();
    expect(projectEvent(thinking("hmm"))).toBeNull();
    expect(projectEvent(result("rc1:c1", "x", null, "rc1"))).toBeNull();
  });

  it("throws when a ToolCall reaches the projector (Rust: unreachable!)", () => {
    expect(() => projectEvent(call("c1"))).toThrow(/must be accumulated/);
  });
});

describe("balanceToolCalls", () => {
  it("inserts one synthetic result per unanswered call id", () => {
    const msgs = deriveMessagesFrom([call("a"), call("b")]);
    balanceToolCalls(msgs);
    expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  it("uses the exact W267 text (engine commit b046564)", () => {
    expect(CANCELLED_TOOL_CALL_TEXT).toBe("Error: tool call was cancelled before execution (no result recorded)");
  });
});
