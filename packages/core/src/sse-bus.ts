/**
 * In-process SSE bus (P0 skeleton; SDK-side, not an engine seam).
 *
 * Mirrors src/main.rs:640-659 (envelope) and 871-896 (512-capacity broadcast
 * with slow-client degradation). The `lagged` semantics are contract:
 * a slow subscriber receives ONE status/lagged event and the stream continues;
 * skipped events are NOT replayed.
 *
 * `subscribe(handler)` is PUSH delivery: each queued frame is handed to the
 * handler on a microtask (W834 F02), so a caller that never awaits still has
 * a bounded, non-reentrant queue behind it.
 *
 * Named SseBus (not EventBus): `EventBus` is the engine's typed plugin seam
 * (see ./event-bus.ts, mirroring crates/core/src/event_bus.rs).
 */

import type { SseEnvelope, SseEventName, Statusline } from "./types.js";

export interface BusEvent {
  kind: SseEventName;
  data: SseEnvelope;
}

export const BUS_CAPACITY = 512;
export const LAGGED_HINT = "slow client, skipped events";

export interface Subscriber {
  readonly id: number;
  send(ev: BusEvent): void;
  close(): void;
}

interface InternalSubscriber extends Subscriber {
  buffer: BusEvent[];
  dropped: number;
  /** A drain microtask is already scheduled for this subscriber. */
  draining: boolean;
  /** close() was called: buffered frames are discarded, never delivered. */
  closed: boolean;
}

export interface SseBus {
  emit(kind: SseEventName, turn: number, payload: Record<string, unknown>): BusEvent;
  subscribe(handler: (ev: BusEvent) => void): Subscriber;
  /** Current global sequence counter (next value to be handed out). */
  seq(): number;
  subscriberCount(): number;
}

export interface SseBusOptions {
  capacity?: number;
  statusline?: () => Statusline | Record<string, unknown>;
  nextTurn?: () => number;
}

function laggedMarker(
  capacity: number,
  sub: InternalSubscriber,
  turn: number,
  seq: number,
  opts: SseBusOptions,
): number {
  // Slow client: drop everything queued, then hand it the lagged marker.
  sub.buffer = [];
  sub.dropped += 1;
  void capacity;
  sub.buffer.push({
    kind: "status",
    data: {
      v: 2,
      session: null,
      turn,
      seq: seq,
      payload: {
        phase: "lagged",
        hint: LAGGED_HINT,
        statusline: opts.statusline ? opts.statusline() : {},
      },
    },
  });
  return seq + 1;
}

/**
 * Queue one frame for delivery and drain on a microtask.
 *
 * W834 F02 (R3 batch A): `emit` used to stop at `sub.buffer.push`, so the
 * handler passed to `subscribe` was never called. Delivery is deferred to a
 * microtask on purpose: it is what keeps the 512-capacity LAGGED semantics
 * observable (a synchronous drain would always empty the queue inside the same
 * `emit`, and a slow client could never fall behind).
 */
function scheduleDrain(sub: InternalSubscriber): void {
  if (sub.draining || sub.closed) return;
  sub.draining = true;
  queueMicrotask(() => {
    sub.draining = false;
    if (sub.closed) {
      sub.buffer = [];
      return;
    }
    while (sub.buffer.length > 0) {
      const next = sub.buffer.shift();
      if (next !== undefined) sub.send(next);
    }
  });
}

export function createSseBus(opts: SseBusOptions = {}): SseBus {
  const capacity = opts.capacity ?? BUS_CAPACITY;
  const subs = new Set<InternalSubscriber>();
  let seq = 0;
  let nextSubId = 1;

  function emit(kind: SseEventName, turn: number, payload: Record<string, unknown>): BusEvent {
    const ev: BusEvent = { kind, data: { v: 2, session: null, turn, seq: seq++, payload } };
    for (const sub of subs) {
      if (sub.buffer.length >= capacity) {
        // Slow client: drop everything queued, then hand it ONE lagged marker.
        seq = laggedMarker(capacity, sub, turn, seq, opts);
      } else {
        sub.buffer.push(ev);
      }
      scheduleDrain(sub);
    }
    return ev;
  }

  function subscribe(handler: (ev: BusEvent) => void): Subscriber {
    const sub: InternalSubscriber = {
      id: nextSubId++,
      buffer: [],
      dropped: 0,
      draining: false,
      closed: false,
      send(ev) {
        if (!sub.closed) handler(ev);
      },
      close() {
        sub.closed = true;
        sub.buffer = [];
        subs.delete(sub);
      },
    };
    subs.add(sub);
    return sub;
  }

  return { emit, subscribe, seq: () => seq, subscriberCount: () => subs.size };
}
