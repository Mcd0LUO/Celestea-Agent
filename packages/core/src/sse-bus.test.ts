/**
 * W834 F02 (R3 batch A): `subscribe(handler)` was a silent no-op — `emit` only
 * pushed into the internal buffer and no path ever drained it, so the handler
 * never saw a frame. The probe walks the PUBLIC barrel (`@celestea/core`
 * `createSseBus`) and pins both halves of the contract:
 *   1. a subscribed handler receives the emitted `BusEvent` and the queue is
 *      empty afterwards;
 *   2. a subscriber that falls more than `capacity` frames behind degrades to
 *      exactly ONE `status/lagged` marker — skipped events are never replayed —
 *      and the stream stays open.
 */

import { describe, expect, it } from "vitest";
import { createSseBus, LAGGED_HINT, type BusEvent, type Subscriber } from "@celestea/core";

/** Let the bus's queue drain (delivery happens on a microtask). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The internal queue, reachable only for the delivered/drained assertion. */
function buffered(sub: Subscriber): BusEvent[] {
  return (sub as unknown as { buffer: BusEvent[] }).buffer;
}

/** The envelope payload (its static type is `unknown`). */
function payloadOf(ev: BusEvent | undefined): Record<string, unknown> {
  const payload = ev?.data.payload;
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

describe("W834 F02 · createSseBus delivers to subscribed handlers", () => {
  it("hands the handler the emitted BusEvent and leaves its buffer empty", async () => {
    const bus = createSseBus();
    const seen: BusEvent[] = [];
    const sub = bus.subscribe((ev) => seen.push(ev));
    const emitted = bus.emit("status", 0, { phase: "start" });
    await flush();
    expect(seen).toEqual([emitted]);
    expect(seen[0]?.kind).toBe("status");
    expect(seen[0]?.data.payload).toEqual({ phase: "start" });
    expect(buffered(sub)).toEqual([]);
    expect(bus.subscriberCount()).toBe(1);
    sub.close();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("degrades a slow subscriber to exactly ONE lagged status and keeps the stream open", async () => {
    const bus = createSseBus({ capacity: 2 });
    const seen: BusEvent[] = [];
    const sub = bus.subscribe((ev) => seen.push(ev));
    bus.emit("text", 1, { delta: "a" });
    bus.emit("text", 1, { delta: "b" });
    bus.emit("text", 1, { delta: "c" }); // the queue is full: clear it + one marker
    bus.emit("text", 1, { delta: "d" }); // the stream continues after the marker
    await flush();
    const lagged = seen.filter((ev) => ev.kind === "status" && payloadOf(ev)["phase"] === "lagged");
    expect(lagged).toHaveLength(1);
    expect(payloadOf(lagged[0])["hint"]).toBe(LAGGED_HINT);
    // Skipped events are NOT replayed...
    const deltas = seen.map((ev) => payloadOf(ev)["delta"]);
    expect(deltas).not.toContain("a");
    expect(deltas).not.toContain("b");
    // ...and the marker did not close the stream.
    expect(deltas).toContain("d");
    expect(seen.at(-1)?.data.seq).toBeGreaterThan(lagged[0]?.data.seq ?? -1);
    sub.close();
  });

  it("does not deliver to a closed subscriber", async () => {
    const bus = createSseBus();
    const seen: BusEvent[] = [];
    const sub = bus.subscribe((ev) => seen.push(ev));
    sub.close();
    bus.emit("text", 1, { delta: "after-close" });
    await flush();
    expect(seen).toEqual([]);
  });
});
