import { describe, expect, it } from "vitest";
import { SSE_EVENT_NAMES } from "@celestea/core";
import { LAGGED_HINT, createStudioBus } from "./sse.js";

describe("studio SSE bus", () => {
  it("wraps every frame in the frozen {turn,seq,payload} envelope", () => {
    const bus = createStudioBus();
    const sub = bus.subscribe();
    const frame = bus.emit("text", 7, { delta: "hi" });
    expect(Object.keys(frame.envelope).sort()).toEqual(["payload", "seq", "turn"]);
    expect(frame.event).toBe("text");
    expect(frame.envelope).toEqual({ turn: 7, seq: 0, payload: { delta: "hi" } });
    expect(bus.seq()).toBe(1);
    sub.close();
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

  it("degrades a slow subscriber to ONE lagged status and keeps the stream open", async () => {
    const bus = createStudioBus({ capacity: 2, statusline: () => ({ model: "m" }) });
    const sub = bus.subscribe();
    bus.emit("text", 1, { delta: "a" });
    bus.emit("text", 1, { delta: "b" });
    bus.emit("text", 1, { delta: "c" }); // overflows: backlog dropped
    const lagged = await sub.next();
    expect(lagged?.event).toBe("status");
    expect(lagged?.envelope.payload).toEqual({ phase: "lagged", hint: LAGGED_HINT, statusline: { model: "m" } });
    expect(sub.dropped()).toBe(1);
    bus.emit("done", 1, { text: "x", tool_calls: [] });
    const next = await sub.next();
    expect(next?.event).toBe("done");
    expect(next?.envelope.seq).toBeGreaterThan(lagged?.envelope.seq ?? -1);
    sub.close();
  });

  it("returns null from next() once the subscription is closed", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe();
    sub.close();
    expect(await sub.next()).toBeNull();
  });
});
