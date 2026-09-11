/**
 * W737: `TurnBusyError` has exactly ONE identity across the engine seam.
 *
 * Audit W732 found two classes of the same name — `packages/runtime/src/errors.ts`
 * (the real engine's, a `StudioError` -> 409 + `kind:"turn_busy"`) and an
 * `extends Error` copy in `apps/studio/src/runtime-adapter.ts`. The handlers
 * branched on the COPY, so under the real engine the busy race was rethrown as a
 * 500 (and `/api/clear` while a turn ran 500'd instead of 409), while the fake
 * adapter threw the copy the handler knew — which is why the contract tests
 * stayed green.
 *
 * These tests pin the identity and drive the race on the REAL engine (and on the
 * fake) so the masking cannot come back.
 */

import { afterEach, describe, expect, it } from "vitest";
import { StudioError } from "@celestea/core";
import { TurnBusyError as EngineTurnBusyError } from "@celestea/runtime";
import { createFakeRuntimeAdapter } from "../fake-runtime-adapter.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../harness.test-util.js";
import { TurnBusyError as SeamTurnBusyError, type RuntimeAdapter } from "../runtime-adapter.js";
import { activate, engineOf, makeEngineHarness, readSessionLog, waitIdle } from "./test-util.js";

/** A turn slow enough (500 frames x 4ms) to keep the busy slot taken. */
const SLOW_LLM = { script: [{ text: "x".repeat(4000) }], deltaMs: 4, chunkChars: 8 };

const harnesses: StudioHarness[] = [];

function track(h: StudioHarness): StudioHarness {
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/**
 * Force the atomic re-check race: the handler's `isBusy()` pre-check reads a
 * stale slot (false) while the engine's own slot is taken, so `startTurn` IS
 * reached and throws. Everything else still goes to the REAL adapter (methods
 * are bound to the target, so its private state is untouched).
 */
function stalePrecheck(real: RuntimeAdapter): RuntimeAdapter {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "isBusy") return (): boolean => false;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as RuntimeAdapter;
}

describe("W737: TurnBusyError identity", () => {
  it("the seam re-export IS the engine's class (StudioError, 409, turn_busy)", () => {
    expect(SeamTurnBusyError).toBe(EngineTurnBusyError);
    const error = new SeamTurnBusyError();
    expect(error).toBeInstanceOf(EngineTurnBusyError);
    expect(error).toBeInstanceOf(StudioError);
    expect(error.status).toBe(409);
    expect(error.kind).toBe("turn_busy");
  });

  it("the real engine's busy slot and busy clear both throw THAT class", async () => {
    const h = track(makeEngineHarness({ sessions: { s1: [] }, llm: SLOW_LLM }));
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(first.status).toBe(202);

    const engine = engineOf(h);
    await expect(engine.startTurn({ input: "again", session: "sample-ws/s1" })).rejects.toBeInstanceOf(SeamTurnBusyError);
    await expect(engine.clear("sample-ws/s1")).rejects.toBeInstanceOf(SeamTurnBusyError);

    engine.cancel("sample-ws/s1");
    await waitIdle(h);
  });
});

describe("W737: busy race over HTTP (real engine)", () => {
  it("POST /api/clear during a running turn is a 409, never a 500", async () => {
    const h = track(makeEngineHarness({ sessions: { s1: [] }, llm: SLOW_LLM }));
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(first.status).toBe(202);

    const clear = await getJson(h.app, "/api/clear", jsonRequest("POST"));
    expect(clear.status).toBe(409);
    expect(clear.body).toEqual({ ok: false, error: "a turn is already running" });
    // A refused clear must not truncate the log of the turn in flight.
    expect(readSessionLog(h, "s1")).toContain("turn_start");

    engineOf(h).cancel("sample-ws/s1");
    await waitIdle(h);
  });

  it("POST /api/turn in the atomic re-check race falls back to injection (200)", async () => {
    const h = track(makeEngineHarness({ sessions: { s1: [] }, llm: SLOW_LLM }));
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(first.status).toBe(202);

    h.studio.services.runtime = stalePrecheck(engineOf(h));
    const raced = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "again" }));
    expect(raced.status).toBe(200);
    expect(raced.body["ok"]).toBe(true);
    expect(raced.body["injected"]).toBe(true);
    expect(raced.body["placement"]).toBe("steering");

    engineOf(h).cancel("sample-ws/s1");
    await waitIdle(h);
  });
});

describe("W737: the fake adapter cannot mask the race anymore", () => {
  it("the fake throws the same class and takes the same injection path", async () => {
    const fake = createFakeRuntimeAdapter({ stepDelayMs: 300, profile: { model: "test-model" } });
    const h = track(makeHarness({ runtime: fake }));
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(first.status).toBe(202);
    expect(fake.isBusy()).toBe(true);

    await expect(fake.startTurn({ input: "again", session: null })).rejects.toBeInstanceOf(SeamTurnBusyError);

    h.studio.services.runtime = stalePrecheck(fake);
    const raced = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "again" }));
    expect(raced.status).toBe(200);
    expect(raced.body["injected"]).toBe(true);
    await fake.whenIdle();
  });
});
