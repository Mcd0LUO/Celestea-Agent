/**
 * Studio SSE bus — the host side of `GET /api/events` (W513).
 *
 * Contract points implemented here:
 *   - envelope `{v:2, session, turn, seq, payload}`: `session` is the session the
 *     frame belongs to (`null` = process-level), `turn` is the SESSION-local turn
 *     number, `seq` stays a monotonic process-global counter and `payload` is
 *     byte-identical to the frozen 8-event contract;
 *   - exactly 8 event names (`SSE_EVENT_NAMES` lives in `@celestea/core`);
 *   - default = one connection receives EVERY session (the client routes
 *     locally); `subscribe({session})` = server-side split for narrow clients;
 *   - back-pressure is PER SESSION BUCKET: a background session's text flood can
 *     no longer evict the focused session's frames. Only the overflowing bucket
 *     is dropped, and the marker carries `{session, dropped, hint}`.
 *
 * NOTE (W513): the design sketch also proposed coalescing `status` frames per
 * session. That is NOT done here: the P5 replay harness compares the frame
 * stream byte-for-byte against the derived transcript, and dropping a status
 * frame silently is indistinguishable from losing a real frame. Per-session
 * bucketing alone provides the isolation the feature needs.
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
/** Envelope version this bus writes (`2` = per-session envelope). */
export const SSE_ENVELOPE_VERSION = 2;
/** Smallest per-session bucket (never starve one session in a busy process). */
export const MIN_BUCKET_CAPACITY = 64;

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

/** Server-side split: keep only these sessions (plus process-level frames). */
export interface SubscribeOptions {
  /** One session id (`null` keeps only process-level frames). */
  session?: string | null;
  /** Several session ids (repeatable `?session=`). */
  sessions?: readonly string[];
}

export interface StudioBus {
  emit(event: SseEventName, turn: number, payload: Record<string, unknown>, session?: string | null): BusFrame;
  subscribe(opts?: SubscribeOptions): BusSubscription;
  /** Current global sequence counter (next value to be handed out). */
  seq(): number;
  subscriberCount(): number;
}

export interface StudioBusOptions {
  capacity?: number;
  /** Per-session bucket floor (default [MIN_BUCKET_CAPACITY], clamped to capacity). */
  minBucket?: number;
  /** Statusline snapshot embedded in the `lagged` marker. */
  statusline?: () => Statusline | Record<string, unknown>;
}

interface Waiter {
  resolve: (frame: BusFrame | null) => void;
}

function bucketKey(session: string | null): string {
  return session ?? "";
}

/** One subscriber: an ordered frame list plus per-session occupancy counts. */
class SessionBuckets {
  private readonly frames: BusFrame[] = [];
  private readonly counts = new Map<string, number>();
  private waiter: Waiter | null = null;
  private closed = false;
  private dropCount = 0;

  constructor(
    private readonly capacity: number,
    private readonly minBucket: number,
    private readonly accept: (frame: BusFrame) => boolean,
    private readonly lagged: (session: string | null, dropped: number) => BusFrame,
  ) {}

  push(frame: BusFrame): void {
    if (this.closed || !this.accept(frame)) return;
    const key = bucketKey(frame.envelope.session);
    if ((this.counts.get(key) ?? 0) >= this.bucketCap()) {
      this.dropCount += 1;
      this.append(this.lagged(frame.envelope.session, this.dropBucket(key) + 1));
      return;
    }
    this.append(frame);
  }

  next(): Promise<BusFrame | null> {
    const frame = this.shift();
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

  /** Per-session bucket cap: the fair share, never below `minBucket`. */
  private bucketCap(): number {
    const buckets = Math.max(1, this.counts.size);
    return Math.max(Math.min(this.minBucket, this.capacity), Math.floor(this.capacity / buckets));
  }

  private append(frame: BusFrame): void {
    this.frames.push(frame);
    const key = bucketKey(frame.envelope.session);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.wake();
  }

  /** Drop ONE session's backlog; returns how many frames were discarded. */
  private dropBucket(key: string): number {
    const kept: BusFrame[] = [];
    let removed = 0;
    for (const frame of this.frames) {
      if (bucketKey(frame.envelope.session) === key) removed += 1;
      else kept.push(frame);
    }
    this.frames.length = 0;
    this.frames.push(...kept);
    this.counts.set(key, 0);
    return removed;
  }

  /** Dequeue one frame and release its bucket slot. */
  private shift(): BusFrame | undefined {
    const frame = this.frames.shift();
    if (frame === undefined) return undefined;
    const key = bucketKey(frame.envelope.session);
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 1) - 1));
    return frame;
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter.resolve(this.shift() ?? null);
  }
}

function assertEventName(event: string): asserts event is SseEventName {
  if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error(`unknown SSE event '${event}': the contract freezes ${SSE_EVENT_NAMES.length} names`);
  }
}

/** The `?session=` filter: matching sessions plus process-level frames. */
function sessionFilter(opts: SubscribeOptions): (frame: BusFrame) => boolean {
  const one = opts.session;
  const many = opts.sessions;
  if (one === undefined && many === undefined) return () => true;
  const wanted = new Set<string>(many ?? []);
  if (one !== undefined && one !== null) wanted.add(one);
  return (frame) => frame.envelope.session === null || wanted.has(frame.envelope.session);
}

/** One bus per Studio app; adapters and handlers share it. */
export function createStudioBus(opts: StudioBusOptions = {}): StudioBus {
  const capacity = opts.capacity ?? SSE_BUS_CAPACITY;
  const minBucket = Math.min(opts.minBucket ?? MIN_BUCKET_CAPACITY, capacity);
  const queues = new Set<SessionBuckets>();
  let seq = 0;

  const laggedFrame = (session: string | null, dropped: number): BusFrame => ({
    event: "status",
    envelope: {
      v: SSE_ENVELOPE_VERSION,
      session,
      turn: 0,
      seq: seq++,
      payload: {
        phase: "lagged",
        hint: LAGGED_HINT,
        session,
        dropped,
        statusline: opts.statusline ? opts.statusline() : {},
      },
    },
  });

  function emit(event: SseEventName, turn: number, payload: Record<string, unknown>, session: string | null = null): BusFrame {
    assertEventName(event);
    const frame: BusFrame = { event, envelope: { v: SSE_ENVELOPE_VERSION, session, turn, seq: seq++, payload } };
    for (const q of queues) q.push(frame);
    return frame;
  }

  function subscribe(sub?: SubscribeOptions): BusSubscription {
    const q = new SessionBuckets(capacity, minBucket, sessionFilter(sub ?? {}), laggedFrame);
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
