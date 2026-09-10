/**
 * SSE bus tests — the W513 per-session envelope and back-pressure rules.
 *
 * The envelope is `{v:2, session, turn, seq, payload}`; `seq` stays a
 * process-global monotonic counter, `turn` is the session-local turn number.
 * Back-pressure is bucketed PER SESSION, so one session's flood can never evict
 * another session's frames.
 */

import { describe, expect, it } from "vitest";
import { SSE_EVENT_NAMES } from "@celestea/core";
import { LAGGED_HINT, SSE_ENVELOPE_VERSION, createStudioBus } from "./sse.js";

describe("studio SSE bus", () => {
  it("wraps every frame in the W513 {v,session,turn,seq,payload} envelope", () => {
    const bus = createStudioBus();
    const sub = bus.subscribe();
    const frame = bus.emit("text", 7, { delta: "hi" }, "sample-ws/s1");
    expect(Object.keys(frame.envelope).sort()).toEqual(["payload", "seq", "session", "turn", "v"]);
    expect(frame.event).toBe("text");
    expect(frame.envelope).toEqual({ v: SSE_ENVELOPE_VERSION, session: "sample-ws/s1", turn: 7, seq: 0, payload: { delta: "hi" } });
    expect(SSE_ENVELOPE_VERSION).toBe(2);
    expect(bus.seq()).toBe(1);
    sub.close();
  });

  it("defaults the session to null for process-level frames", () => {
    const bus = createStudioBus();
    const frame = bus.emit("compact", 0, { session: "sample-ws/s1" });
    expect(frame.envelope.session).toBeNull();
  });

  it("carries all 8 contract event names and rejects anything else", () => {
    const bus = createStudioBus();
    for (const name of SSE_EVENT_NAMES) expect(() => bus.emit(name, 0, {})).not.toThrow();
    expect(SSE_EVENT_NAMES).toHaveLength(8);
    expect(() => bus.emit("context" as never, 0, {})).toThrow(/unknown SSE event/);
  });

  it("hands every subscriber the same sequential frames", async () => {
    const bus = createStudioBus();
    const a = bus.subscribe();
    const b = bus.subscribe();
    bus.emit("tool", 1, { id: "c1", name: "read_file", args: {} });
    bus.emit("tool_result", 1, { id: "c1", ok: true });
    expect((await a.next())?.envelope.seq).toBe(0);
    expect((await a.next())?.envelope.seq).toBe(1);
    expect((await b.next())?.envelope.seq).toBe(0);
    expect(bus.subscriberCount()).toBe(2);
    a.close();
    b.close();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("routes frames to the requested session server-side (?session=)", async () => {
    const bus = createStudioBus();
    const all = bus.subscribe();
    const onlyB = bus.subscribe({ sessions: ["ws/b"] });
    bus.emit("text", 1, { delta: "a" }, "ws/a");
    bus.emit("text", 1, { delta: "b" }, "ws/b");
    bus.emit("compact", 0, { session: "ws/a" });
    expect((await all.next())?.envelope.payload).toEqual({ delta: "a" });
    expect((await all.next())?.envelope.payload).toEqual({ delta: "b" });
    expect((await all.next())?.envelope.payload).toEqual({ session: "ws/a" });
    expect((await onlyB.next())?.envelope.payload).toEqual({ delta: "b" });
    // process-level frames (session: null) reach a filtered subscriber too.
    expect((await onlyB.next())?.envelope.payload).toEqual({ session: "ws/a" });
    all.close();
    onlyB.close();
  });

  it("degrades a slow subscriber to ONE lagged status and keeps the stream open", async () => {
    const bus = createStudioBus({ capacity: 2 });
    const sub = bus.subscribe();
    bus.emit("text", 1, { delta: "a" }, "ws/a");
    bus.emit("text", 1, { delta: "b" }, "ws/a");
    bus.emit("text", 1, { delta: "c" }, "ws/a"); // overflows THAT session's bucket
    const lagged = await sub.next();
    expect(lagged?.event).toBe("status");
    expect(lagged?.envelope.session).toBe("ws/a");
    expect(lagged?.envelope.payload).toEqual({ phase: "lagged", hint: LAGGED_HINT, session: "ws/a", dropped: 3, statusline: {} });
    expect(sub.dropped()).toBe(1);
    bus.emit("done", 1, { text: "x", tool_calls: [] }, "ws/a");
    const next = await sub.next();
    expect(next?.event).toBe("done");
    expect(next?.envelope.seq).toBeGreaterThan(lagged?.envelope.seq ?? -1);
    sub.close();
  });

  it("never lets one session's flood evict another session's frames", async () => {
    const bus = createStudioBus({ capacity: 2 });
    const sub = bus.subscribe();
    for (let i = 0; i < 50; i++) bus.emit("text", 1, { delta: `flood ${i}` }, "ws/noisy");
    bus.emit("status", 3, { phase: "start" }, "ws/focus");
    bus.emit("text", 3, { delta: "focused" }, "ws/focus");
    const focused: unknown[] = [];
    const sessions: string[] = [];
    for (let i = 0; i < 6 && focused.length < 2; i++) {
      const frame = await sub.next();
      if (frame === null) break;
      sessions.push(String(frame.envelope.session));
      if (frame.envelope.session === "ws/focus") focused.push(frame.envelope.payload);
    }
    // Both focused-session frames survive the flood, in order and unmodified.
    expect(focused).toEqual([{ phase: "start" }, { delta: "focused" }]);
    expect(sessions.slice(-2)).toEqual(["ws/focus", "ws/focus"]);
    expect(sub.dropped()).toBeGreaterThan(0);
    sub.close();
  });

  it("returns null from next() once the subscription is closed", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe();
    sub.close();
    expect(await sub.next()).toBeNull();
  });
});
