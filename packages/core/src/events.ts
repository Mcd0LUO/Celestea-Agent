/**
 * In-process SSE bus (P0 skeleton).
 *
 * Mirrors src/main.rs:640-659 (envelope) and 871-896 (512-capacity broadcast
 * with slow-client degradation). The `lagged` semantics are contract:
 * a slow subscriber receives ONE status/lagged event and the stream continues;
 * skipped events are NOT replayed.
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
}

export interface EventBus {
  emit(kind: SseEventName, turn: number, payload: Record<string, unknown>): BusEvent;
  subscribe(handler: (ev: BusEvent) => void): Subscriber;
  /** Current global sequence counter (next value to be handed out). */
  seq(): number;
  subscriberCount(): number;
}

export interface EventBusOptions {
  capacity?: number;
  statusline?: () => Statusline | Record<string, unknown>;
  nextTurn?: () => number;
}

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const capacity = opts.capacity ?? BUS_CAPACITY;
  const subs = new Set<InternalSubscriber>();
  let seq = 0;
  let nextSubId = 1;

  function emit(kind: SseEventName, turn: number, payload: Record<string, unknown>): BusEvent {
    const ev: BusEvent = { kind, data: { turn, seq: seq++, payload } };
    for (const sub of subs) {
      if (sub.buffer.length >= capacity) {
        // Slow client: drop everything queued, then hand it the lagged marker.
        sub.buffer = [];
        sub.dropped += 1;
        sub.buffer.push({
          kind: "status",
          data: {
            turn,
            seq: seq++,
            payload: {
              phase: "lagged",
              hint: LAGGED_HINT,
              statusline: opts.statusline ? opts.statusline() : {},
            },
          },
        });
        continue;
      }
      sub.buffer.push(ev);
    }
    return ev;
  }

  function subscribe(handler: (ev: BusEvent) => void): Subscriber {
    const sub: InternalSubscriber = {
      id: nextSubId++,
      buffer: [],
      dropped: 0,
      send(ev) {
        handler(ev);
      },
      close() {
        subs.delete(sub);
      },
    };
    subs.add(sub);
    return sub;
  }

  return {
    emit,
    subscribe,
    seq: () => seq,
    subscriberCount: () => subs.size,
  };
}
