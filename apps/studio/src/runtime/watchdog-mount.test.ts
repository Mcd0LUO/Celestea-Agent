/**
 * W740 §2 — the watchdog at the studio composition root, on the surface the host
 * actually reads.
 *
 * The adapter composes one engine generation per session (`session-compose` ->
 * `packages/runtime/src/compose.ts`), and that root mounts the W736 watchdog over
 * the session's own worker registry. These tests drive the REAL adapter (the
 * production path), never a double, and assert what a panel would see:
 *
 *   1. every composed session gets a sweeping watchdog, and a session that was
 *      never composed is PEEKED — a diagnostic never builds an engine;
 *   2. `worker_status().by_status` follows the sweep: a RUNNING row with a
 *      deliverable settles to DONE and the panel row carries the verdict;
 *   3. the sweep really is the TIMER's, and tearing the generation down stops it.
 *
 * The verdict table itself (keep-running / grace / respawn / probe-error) is
 * `packages/workers/src/watchdog.test.ts`; the mount contract is
 * `packages/runtime/src/watchdog-mount.test.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WATCHDOG_INTERVAL_ENV } from "@celestea/runtime";
import { utcNow, type WorkerRegistry } from "@celestea/workers";
import { engineOf, makeEngineHarness, type EngineHarnessOptions } from "./test-util.js";

/** Cadence under test (production default is 30 s; the env carries the override). */
const SWEEP_MS = 1_000;
/** Older than any grace window: an ended worker is judged immediately. */
const ENDED_AT = utcNow(Date.now() - 700_000);

/** A harness whose engine sweeps on [SWEEP_MS] instead of the 30 s default. */
function sweepingHarness(extra: EngineHarnessOptions = {}): ReturnType<typeof makeEngineHarness> {
  return makeEngineHarness({ ...extra, env: { ...(extra.env ?? {}), [WATCHDOG_INTERVAL_ENV]: String(SWEEP_MS) } });
}

/** Park one RUNNING row whose brief turn already ENDED (no deliverable yet). */
function seedEndedWorker(registry: WorkerRegistry, wid = "W740A"): void {
  const sid = registry.sessions.create({ title: `${wid}·seeded` }).meta.id;
  registry.upsert({ wid, started_at: ENDED_AT, status: "RUNNING", extra: `sess=${sid}` });
}

/** Write the deliverable the watchdog probes for (`<results>/<wid>*.md`). */
function writeDeliverable(resultsDir: string, wid: string): void {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${wid}-report.md`), "deliverable", "utf8");
}

describe("watchdog mounted at the studio composition root (W740)", () => {
  it("sweeps every composed session and peeks (never composes) for an unknown one", () => {
    const h = sweepingHarness();
    try {
      h.runtime.ensureSession(null);
      const engine = engineOf(h);
      expect(engine.watchdogRunning(null)).toBe(true);
      expect(engine.watchdog(null)?.current.intervalMs).toBe(SWEEP_MS);
      expect(h.runtime.workerStatus().watchdogs).toBe(1);
      expect(engine.workersOf(null)).not.toBeNull();
      // A session with no instance is inspected, not composed.
      expect(engine.watchdog("no-such-session")).toBeNull();
      expect(engine.watchdogRunning("no-such-session")).toBe(false);
      expect(engine.workersOf("no-such-session")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("moves the panel's by_status counts when the sweep lands a terminal state", () => {
    const h = sweepingHarness();
    try {
      h.runtime.ensureSession(null);
      const engine = engineOf(h);
      const watchdog = engine.watchdog(null);
      expect(watchdog).not.toBeNull();
      seedEndedWorker(engine.workersOf(null)!);

      const before = h.runtime.workerStatus();
      expect(before.by_status["RUNNING"]).toBe(1);
      expect(before.watchdogs).toBe(1);

      // The deliverable shows up; the sweep is what turns the row terminal.
      writeDeliverable(watchdog!.current.resultsDir, "W740A");
      expect(watchdog!.tick()).toEqual([{ kind: "done", wid: "W740A" }]);

      const after = h.runtime.workerStatus();
      expect(after.by_status["DONE"]).toBe(1);
      // `by_status` only reports statuses that OCCUR: no RUNNING key = none left.
      expect(after.by_status["RUNNING"]).toBeUndefined();
      // The row the panel lists carries the verdict, not just the aggregate.
      expect(h.runtime.workerSessions().find((r) => r.wid === "W740A")?.status).toBe("DONE");
    } finally {
      h.cleanup();
    }
  });

  it("lets the TIMER do the sweeping (no hand-driven tick)", () => {
    vi.useFakeTimers();
    const h = sweepingHarness();
    try {
      h.runtime.ensureSession(null);
      const engine = engineOf(h);
      const watchdog = engine.watchdog(null)!;
      seedEndedWorker(engine.workersOf(null)!, "W740B");
      writeDeliverable(watchdog.current.resultsDir, "W740B");
      expect(watchdog.running).toBe(true);

      expect(h.runtime.workerStatus().by_status["DONE"]).toBeUndefined();
      vi.advanceTimersByTime(SWEEP_MS);
      expect(h.runtime.workerStatus().by_status["DONE"]).toBe(1);
      expect(h.runtime.workerSessions().find((r) => r.wid === "W740B")?.status).toBe("DONE");
    } finally {
      vi.useRealTimers();
      h.cleanup();
    }
  });

  it("stops the sweep when the session's generation is torn down", async () => {
    vi.useFakeTimers();
    const h = sweepingHarness();
    try {
      h.runtime.ensureSession(null);
      const engine = engineOf(h);
      expect(engine.watchdogRunning(null)).toBe(true);
      await engine.shutdown();
      expect(engine.watchdogRunning(null)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      h.cleanup();
    }
  });
});
