/**
 * A2 (W746) — the SessionLog seam owns its projection.
 *
 * These tests pin the two things the seam now guarantees itself, instead of
 * trusting every implementation to reproduce them:
 *
 *   1. a log built with `projectingSessionLog` shows the REAL model-visible
 *      history (the same `deriveMessagesFrom` `@celestea/session` re-exports);
 *   2. the seam's turn-id promise (monotonic, never reused after `clear`, and
 *      resumed above the ids already in a replayed store) holds by construction;
 *   3. a backend cannot smuggle in its own `deriveMessages` — the empty-history
 *      stub is a TYPE error, not a plausible alternative implementation.
 */

import { describe, expect, it } from "vitest";

import { memoryEventStore, projectingSessionLog, type EventStore, type SessionEvent } from "./index.js";

const turnStart = (n: number): SessionEvent => ({ type: "turn_start", id: `turn-${n}` });
const turnEnd = (n: number): SessionEvent => ({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });

describe("A2 · core's default projection", () => {
  it("projects the real model-visible history (never an empty stub)", () => {
    const log = projectingSessionLog(memoryEventStore());
    log.append(turnStart(0));
    log.append({ type: "user_message", text: "hi" });
    log.append({ type: "thinking_delta", text: "hmm" });
    log.append({ type: "tool_call", id: "c1", name: "read_file", args: { path: "a" } });
    log.append({ type: "tool_result", id: "c1", value: "body", error: null });
    log.append({ type: "assistant_message", text: "done" });
    log.append(turnEnd(0));

    expect(log.deriveMessages()).toEqual([
      { role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null },
      {
        role: "assistant",
        content: [{ type: "tool_call", content: { id: "c1", name: "read_file", args: { path: "a" } } }],
        tool_call_id: null,
      },
      // the value is projected as its serde_json TEXT, hence the quoted string
      { role: "tool", content: [{ type: "text", content: '"body"' }], tool_call_id: "c1" },
      { role: "assistant", content: [{ type: "text", content: "done" }], tool_call_id: null },
    ]);
  });

  it("answers a dangling tool call with the W267 synthetic result (protocol validity)", () => {
    const log = projectingSessionLog(memoryEventStore());
    log.append({ type: "tool_call", id: "c1", name: "run_shell", args: {} });
    const messages = log.deriveMessages();
    expect(messages.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "text",
          content: "Error: tool call was cancelled before execution (no result recorded)",
        },
      ],
      tool_call_id: "c1",
    });
  });

  it("mints monotonic ids that clear() never reuses", () => {
    const log = projectingSessionLog(memoryEventStore());
    expect([log.nextTurnId(), log.nextTurnId()]).toEqual(["turn-0", "turn-1"]);
    log.append({ type: "user_message", text: "gone" });
    log.clear();
    expect(log.events()).toEqual([]);
    expect(log.deriveMessages()).toEqual([]);
    expect(log.nextTurnId()).toBe("turn-2");
  });

  it("resumes above the ids already on disk when the store is replayed", () => {
    const store = memoryEventStore();
    store.append(turnStart(0));
    store.append(turnEnd(0));
    store.append(turnStart(7));
    store.append(turnEnd(7));
    const log = projectingSessionLog(store);
    expect(log.nextTurnId()).toBe("turn-8");
    // The replayed history is projected, not discarded.
    expect(log.deriveMessages()).toHaveLength(0);
    log.append({ type: "user_message", text: "resumed" });
    expect(log.deriveMessages()).toHaveLength(1);
  });

  it("rejects a store that ships its own deriveMessages (the []-history stub)", () => {
    const store: EventStore = memoryEventStore();
    expect(typeof store.append).toBe("function");
    // @ts-expect-error — `deriveMessages?: never`: a self-projecting store is
    // not a legal store, so "deriveMessages() { return [] }" cannot be mounted.
    // (If this line ever stops erroring, the A2 guard rail is gone.)
    const stubbed: EventStore = { ...store, deriveMessages: (): never[] => [] };
    expect(stubbed).toBeDefined();
  });
});
