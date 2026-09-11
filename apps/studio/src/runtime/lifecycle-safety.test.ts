/**
 * W742 — the three lifecycle promises, proven on the REAL adapter.
 *
 *   §1 an epoch bump (`POST /api/config` / `POST /api/providers/default` / a
 *      grant write) must not tear down an instance that is still driving a
 *      worker: rebuilding disposes the old generation, which aborts the worker's
 *      driver and erases its registry row — a silent kill the caller never sees;
 *   §2 `CELESTEA_SESSION_IDLE_TTL_MS` is real: the host arms a low-frequency
 *      reclaimer that reclaims idle instances without any explicit call;
 *   §1' the two endpoints that swap the engine profile refuse (409) while a
 *      worker is in flight, so the fix is visible in the HTTP contract too.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness, turns } from "./test-util.js";

/** A brief turn slow enough to observe the worker while its row is RUNNING. */
const SLOW_BRIEF = { script: [{ text: "x".repeat(4_000) }], deltaMs: 4, chunkChars: 8 };

const harnesses: StudioHarness[] = [];

function make(opts: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: turns(1) }, ...opts });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Poll until `check` holds (the engine settles asynchronously). */
async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The worker's row survives, i.e. its brief has not been adjudicated yet. */
function running(h: StudioHarness, wid: string): boolean {
  return engineOf(h).workerStatus(wid).by_status["RUNNING"] === 1;
}

describe("W742 §1: an epoch bump never tears down an instance with live worker work", () => {
  it("keeps the worker's instance, registry and row, and lands the rebuild after", async () => {
    const h = make({ llm: SLOW_BRIEF });
    const session = "sample-ws/s1";
    await activate(h, session);
    const engine = engineOf(h);
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "a long brief", title: "T", session }));
    expect(spawn.status).toBe(200);
    const registry = engine.workersOf(session);
    expect(registry).not.toBeNull();
    expect(running(h, "W1")).toBe(true);

    // The very bump `POST /api/config` performs (that endpoint 409s first, which
    // is exactly why the race needs the registry-side defence as well).
    const epochBefore = engine.generationEpoch();
    await engine.configure({ model: "swapped-model" });
    expect(engine.generationEpoch()).toBe(epochBefore + 1);

    // Same instance → same worker registry → the driver, its row and its mailbox
    // survived. Before W742 this call disposed the old runtime and aborted it.
    expect(engine.workersOf(session)).toBe(registry);
    expect(running(h, "W1")).toBe(true);
    // …and the generation swap is MARKED, not applied: an ensure must not do it.
    expect(engine.ensureSession(session).rebuilt).toBe(false);

    // The brief reaches its OWN verdict on that original instance: the receipt
    // path wrote the report file, which an aborted worker never produces.
    await until(() => !running(h, "W1"), "the worker's brief to settle");
    const reports = readdirSync(join(h.root, "worker-results"));
    expect(reports.some((name) => name.startsWith("W1"))).toBe(true);
    expect(engine.workerStatus("W1").ok).toBe(true);

    // §1 second half: once that work ended, the deferred swap lands (a session is
    // never frozen in a stale generation because it once spawned a worker).
    await until(() => engine.ensureSession(session).rebuilt, "the deferred rebuild to land");
    expect(engine.workersOf(session)).not.toBe(registry);
    expect(engine.workersOf(session)?.ownEntries()).toEqual([]);
  });
});

describe("W742 §1: the 409 guard of both profile-swapping endpoints", () => {
  it("refuses a config change and a provider default while a worker is in flight", async () => {
    const h = make({ llm: SLOW_BRIEF });
    const engine = engineOf(h);
    expect((await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "a long brief", title: "T" }))).status).toBe(200);
    expect(running(h, "W1")).toBe(true);
    const epochBefore = engine.generationEpoch();

    const config = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "another-model" }));
    expect(config.status).toBe(409);
    expect(config.body).toEqual({ ok: false, error: "a worker is running; config applies between turns" });
    const providers = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "another-model" }));
    expect(providers.status).toBe(409);
    expect(providers.body).toEqual({ ok: false, error: "a worker is running; provider default applies between turns" });
    // Nothing was applied behind the 409.
    expect(engine.generationEpoch()).toBe(epochBefore);
    expect(engine.profile().model).not.toBe("another-model");

    // Once the worker settled the very same change is accepted again.
    await until(() => !running(h, "W1"), "the worker to settle");
    const after = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "another-model" }));
    expect(after.status).toBe(200);
    expect(engine.generationEpoch()).toBe(epochBefore + 1);
  });
});

describe("W742 §2: the idle reclaimer is wired in the host", () => {
  it("reclaims an instance that only went past the idle TTL (no explicit sweep)", async () => {
    // 1ms idle TTL → the derived reclaimer period is the 1s floor.
    const h = make({ env: { CELESTEA_SESSION_IDLE_TTL_MS: "1" } });
    const session = "sample-ws/s1";
    await activate(h, session);
    const engine = engineOf(h);
    expect(engine.liveSessions()).toContain(session);

    await until(() => !engine.liveSessions().includes(session), "the idle instance to be reclaimed", 10_000);
    expect(engine.liveSessions()).not.toContain(session);
    // The detached default instance is pinned and stays (it backs `/api/tools`).
    expect(engine.tools().length).toBeGreaterThan(0);
  });
});
