/**
 * Studio SSE bus — the host side of the frozen `GET /api/events` contract
 * (`contracts/sse-events.json`, `src/main.rs:640-712,871-896`).
 *
 * Contract points implemented here:
 *   - envelope `{turn, seq, payload}`, `seq` a monotonic process-global counter;
 *   - exactly 8 event names (`SSE_EVENT_NAMES` lives in `@celestea/core`);
 *   - capacity 512 per subscriber; a subscriber that falls behind has its
 *     backlog DROPPED and receives one `status` frame carrying
 *     `{phase:"lagged", hint:"slow client, skipped events", statusline}` —
 *     the stream then continues and skipped events are never replayed.
 *
 * The bus is push-based (each subscriber owns a bounded queue plus a waiter) so
 * a Hono `streamSSE` handler awaits frames instead of polling. Delivery is
 * deliberately lossy under back-pressure: that IS the contract.
 */

import {
  BUS_CAPACITY as CORE_CAPACITY,
  LAGGED_HINT,
  SSE_EVENT_NAMES,
  type SseEnvelope,
  type SseEventName,
  type Statusline,
} from "@celestea/core";

export { LAGGED_HINT };
/** Core keeps the canonical bus capacity; the host re-exports it under its own name. */
export const SSE_BUS_CAPACITY = CORE_CAPACITY;

export interface BusFrame {
  event: SseEventName;
  envelope: SseEnvelope;
}

export interface BusSubscription {
  /** Await the next frame; resolves to null once the subscription is closed. */
  next(): Promise<BusFrame | null>;
  close(): void;
  /** Number of times this subscriber fell behind (one lagged frame each). */
  dropped(): number;
}

export interface StudioBus {
  emit(event: SseEventName, turn: number, payload: Record<string, unknown>): BusFrame;
  subscribe(): BusSubscription;
  /** Current global sequence counter (next value to be handed out). */
  seq(): number;
  subscriberCount(): number;
}

export interface StudioBusOptions {
  capacity?: number;
  /** Statusline snapshot embedded in the `lagged` marker. */
  statusline?: () => Statusline | Record<string, unknown>;
}

interface Waiter {
  resolve: (frame: BusFrame | null) => void;
}

/** Bounded frame queue: overflow drops the backlog and pushes one marker. */
class Queue {
  private readonly frames: BusFrame[] = [];
  private waiter: Waiter | null = null;
  private closed = false;
  private dropCount = 0;

  constructor(
    private readonly capacity: number,
    private readonly lagged: () => BusFrame,
  ) {}

  push(frame: BusFrame): void {
    if (this.closed) return;
    if (this.frames.length >= this.capacity) {
      this.frames.length = 0;
      this.dropCount += 1;
      this.frames.push(this.lagged());
    } else {
      this.frames.push(frame);
    }
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter.resolve(this.frames.shift() ?? null);
  }

  next(): Promise<BusFrame | null> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve(null);
    return new Promise<BusFrame | null>((resolve) => {
      this.waiter = { resolve };
    });
  }

  close(): void {
    this.closed = true;
    this.frames.length = 0;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve(null);
  }

  dropped(): number {
    return this.dropCount;
  }
}

function assertEventName(event: string): asserts event is SseEventName {
  if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error(`unknown SSE event '${event}': the contract freezes ${SSE_EVENT_NAMES.length} names`);
  }
}

/** One bus per Studio app; adapters and handlers share it. */
export function createStudioBus(opts: StudioBusOptions = {}): StudioBus {
  const capacity = opts.capacity ?? SSE_BUS_CAPACITY;
  const queues = new Set<Queue>();
  let seq = 0;

  const laggedFrame = (): BusFrame => ({
    event: "status",
    envelope: {
      turn: 0,
      seq: seq++,
      payload: {
        phase: "lagged",
        hint: LAGGED_HINT,
        statusline: opts.statusline ? opts.statusline() : {},
      },
    },
  });

  function emit(event: SseEventName, turn: number, payload: Record<string, unknown>): BusFrame {
    assertEventName(event);
    const frame: BusFrame = { event, envelope: { turn, seq: seq++, payload } };
    for (const q of queues) q.push(frame);
    return frame;
  }

  function subscribe(): BusSubscription {
    const q = new Queue(capacity, laggedFrame);
    queues.add(q);
    return {
      next: () => q.next(),
      close: () => {
        q.close();
        queues.delete(q);
      },
      dropped: () => q.dropped(),
    };
  }

  return { emit, subscribe, seq: () => seq, subscriberCount: () => queues.size };
}
