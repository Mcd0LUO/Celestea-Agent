/**
 * EventBus seam — port of `crates/core/src/event_bus.rs`.
 *
 * A typed bus with three independent dispatch modes, keyed by event type:
 *   - on / emit          observe-only broadcast;
 *   - bail / runBail     intercept chain: first non-`undefined` answer
 *                        short-circuits (the guard primitive);
 *   - waterfall / runWaterfall
 *                        transform chain: each listener maps the running value
 *                        handed to the next one.
 *
 * The three modes live in separate maps, so a listener registered in one mode
 * never interferes with another. In Rust the event type is a TypeId; here it is
 * an explicit token — a well-known string, a symbol, or a class constructor
 * used by identity (see `context.ts:ServiceToken`).
 *
 * `undefined` is `None`: a bail listener that returns `undefined` passes, and a
 * `null`/`false`/`0` answer short-circuits (unlike a truthiness check).
 * `runWaterfall` cannot verify at runtime that every listener shares one value
 * type (Rust panics on a failed downcast); the TS generic makes one value type
 * per event type a compile-time contract — pass a `transform` that keeps it.
 */

import type { ServiceToken } from "./context.js";

export type EventKey<E> = ServiceToken<E>;

type Listener = (...args: never[]) => unknown;

export interface EventBus {
  /** Observe-only broadcast listener. */
  on<E>(key: EventKey<E>, listener: (event: E) => void): void;
  /** Deliver to every listener registered with `on` for this key. */
  emit<E>(key: EventKey<E>, event: E): void;
  /** Intercept listener; returning `undefined` passes to the next one. */
  bail<E, R>(key: EventKey<E>, listener: (event: E) => R | undefined): void;
  /** First non-`undefined` answer in registration order, else undefined. */
  runBail<E, R>(key: EventKey<E>, event: E): R | undefined;
  /** Transform listener; each layer receives the previous layer's value. */
  waterfall<E, R>(key: EventKey<E>, listener: (event: E, value: R) => R): void;
  /** The value after every waterfall listener has run, in order. */
  runWaterfall<E, R>(key: EventKey<E>, event: E, init: R): R;
  /** Registered listener counts per mode (diagnostics / tests). */
  counts(key: EventKey<unknown>): { on: number; bail: number; waterfall: number };
}

function busKey(key: EventKey<unknown>): unknown {
  return typeof key === "string" ? `event:${key}` : key;
}

export function createEventBus(): EventBus {
  const subs = new Map<unknown, Listener[]>();
  const bailers = new Map<unknown, Listener[]>();
  const waterfalls = new Map<unknown, Listener[]>();

  const push = (map: Map<unknown, Listener[]>, key: EventKey<unknown>, fn: Listener): void => {
    const k = busKey(key);
    const list = map.get(k);
    if (list) list.push(fn);
    else map.set(k, [fn]);
  };

  return {
    on(key, listener) {
      push(subs, key, listener as Listener);
    },
    emit(key, event) {
      for (const fn of subs.get(busKey(key)) ?? []) (fn as (e: unknown) => void)(event);
    },
    bail(key, listener) {
      push(bailers, key, listener as Listener);
    },
    runBail(key, event) {
      for (const fn of bailers.get(busKey(key)) ?? []) {
        const answer = (fn as (e: unknown) => unknown)(event);
        if (answer !== undefined) return answer as never;
      }
      return undefined;
    },
    waterfall(key, listener) {
      push(waterfalls, key, listener as Listener);
    },
    runWaterfall(key, event, init) {
      let value = init;
      for (const fn of waterfalls.get(busKey(key)) ?? []) {
        value = (fn as (e: unknown, v: unknown) => unknown)(event, value) as never;
      }
      return value;
    },
    counts(key) {
      const k = busKey(key);
      return {
        on: (subs.get(k) ?? []).length,
        bail: (bailers.get(k) ?? []).length,
        waterfall: (waterfalls.get(k) ?? []).length,
      };
    },
  };
}

/** Well-known token for the engine event bus service. */
export const EVENT_BUS_SERVICE = "celestea.core.EventBus";
