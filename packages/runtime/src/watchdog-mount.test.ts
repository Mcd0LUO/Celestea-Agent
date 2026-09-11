/**
 * W740: the watchdog at the composition root.
 *
 * These tests are about the MOUNT, not about adjudication (that is
 * `packages/workers/src/watchdog.test.ts`): does a composed generation really
 * schedule the sweep, does the registry's own stop path kill the timer, and does
 * the terminal verdict reach the registry view the panel/tool reads?
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { definePlugin } from "@celestea/core";
import { WORKER_REGISTRY_SERVICE, WorkerRegistry, utcNow } from "@celestea/workers";
import { compose } from "./compose.js";
import { memorySessionPlugin, testProfile } from "./fakes.test-util.js";
import {
  WATCHDOG_ENV,
  WATCHDOG_GRACE_ENV,
  WATCHDOG_INTERVAL_ENV,
  WATCHDOG_MAX_RETRIES_ENV,
  WATCHDOG_MOUNT_DEFAULTS,
  WATCHDOG_PLUGIN_NAME,
  celesteaWatchdogSettings,
  mountWatchdog,
  watchdogDisabled,
} from "./watchdog-mount.js";

const NOW_MS = Date.parse("2026-09-10T12:00:00Z");

interface Fixture {
  dir: string;
  results: string;
  registry: WorkerRegistry;
}

/** A registry whose only worker already ENDED (turn closed, no deliverable yet). */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "celestea-w740-"));
  const results = join(dir, "worker-results");
  const registry = new WorkerRegistry({ tsvPath: join(dir, "registry.tsv"), resultsDir: results, now: () => NOW_MS });
  const session = registry.sessions.create({ title: "W1·t" });
  session.log.append({ type: "turn_start", id: "t1" });
  session.log.append({ type: "turn_end", id: "t1", outcome: "completed" });
  registry.upsert({
    wid: "W1",
    started_at: utcNow(NOW_MS - 700_000),
    status: "RUNNING",
    extra: `sess=${session.meta.id}`,
  });
  return { dir, results, registry };
}

/** The status map the panel and the `worker_status` tool both read. */
function byStatus(registry: WorkerRegistry): unknown {
  return registry.status()["by_status"];
}

/**
 * The registry is mounted the way a HOST provides one: as a plugin over the
 * frozen token. (`WorkerWiring.registry` is NOT the host path — `compose` would
 * ignore it and create the default registry over the shared tsv.)
 */
function registryPlugin(registry: WorkerRegistry): ReturnType<typeof definePlugin> {
  return definePlugin("test.workers", (ctx) => ctx.provide(WORKER_REGISTRY_SERVICE, registry));
}

function composeWithWatchdog(f: Fixture, watchdog: Record<string, unknown> | false = {}): ReturnType<typeof compose> {
  return compose({
    profile: testProfile(),
    plugins: [memorySessionPlugin(), registryPlugin(f.registry)],
    watchdog,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchdog settings (env + safe defaults)", () => {
  it("is ON by default and keeps W736's cadence and budgets", () => {
    expect(celesteaWatchdogSettings({})).toEqual(WATCHDOG_MOUNT_DEFAULTS);
    expect(WATCHDOG_MOUNT_DEFAULTS.intervalMs).toBeGreaterThan(0);
  });

  it("reads the cadence, the retry ceiling and the grace window", () => {
    const env = { [WATCHDOG_INTERVAL_ENV]: "1500", [WATCHDOG_MAX_RETRIES_ENV]: "5", [WATCHDOG_GRACE_ENV]: "1200" };
    expect(celesteaWatchdogSettings(env)).toMatchObject({ autostart: true, intervalMs: 1500, maxRetries: 5, graceMs: 1200 });
  });

  it("falls back to the defaults on a typo instead of aborting startup", () => {
    const env = { [WATCHDOG_INTERVAL_ENV]: "soon", [WATCHDOG_MAX_RETRIES_ENV]: "-3", [WATCHDOG_GRACE_ENV]: "" };
    expect(celesteaWatchdogSettings(env)).toEqual(WATCHDOG_MOUNT_DEFAULTS);
    // A zero period would be a hot loop: it means "off", never "as fast as possible".
    expect(celesteaWatchdogSettings({ [WATCHDOG_INTERVAL_ENV]: "0" })).toEqual(WATCHDOG_MOUNT_DEFAULTS);
  });

  it("stays off (interval 0, no autostart) when the switch says so", () => {
    for (const raw of ["off", "OFF", "0", "false", "no"]) {
      expect(watchdogDisabled({ [WATCHDOG_ENV]: raw })).toBe(true);
      expect(celesteaWatchdogSettings({ [WATCHDOG_ENV]: raw })).toMatchObject({ autostart: false, intervalMs: 0 });
    }
    expect(watchdogDisabled({})).toBe(false);
    expect(watchdogDisabled({ [WATCHDOG_ENV]: "on" })).toBe(false);
  });
});

describe("composed watchdog", () => {
  it("mounts the watchdog last, provides WATCHDOG_SERVICE and really schedules a sweep", () => {
    vi.useFakeTimers();
    const f = fixture();
    writeFileSync(join(f.dir, "filler"), "", "utf8"); // results dir stays absent on purpose
    const runtime = composeWithWatchdog(f, { intervalMs: 1_000, graceMs: 0, maxRetries: 0 });

    expect(runtime.pluginNames).toEqual(["test.session", "test.workers", WATCHDOG_PLUGIN_NAME]);
    expect(runtime.ctx.get(WORKER_REGISTRY_SERVICE)).toBe(f.registry);
    const watchdog = runtime.watchdog;
    expect(watchdog).not.toBeNull();
    expect(runtime.ctx.get("celestea.workers.Watchdog")).toBe(watchdog);
    expect(watchdog!.running).toBe(true);
    expect(watchdog!.current.intervalMs).toBe(1_000);

    // The sweep is the TIMER's doing: nobody ticks it in this test.
    expect(byStatus(f.registry)).toEqual({ RUNNING: 1, DONE: 0, FAILED: 0 });
    vi.advanceTimersByTime(1_000);
    expect(byStatus(f.registry)).toEqual({ RUNNING: 0, DONE: 0, FAILED: 1 });
    expect(f.registry.getEntry("W1")!.status).toBe("FAILED");

    // ... and it keeps sweeping (a second period is a second round).
    vi.advanceTimersByTime(1_000);
    expect(f.registry.getEntry("W1")!.status).toBe("FAILED");
  });

  it("stops the sweep on shutdown — the timer does not outlive the generation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const runtime = composeWithWatchdog(f, { intervalMs: 1_000, graceMs: 0, maxRetries: 0 });
    const watchdog = runtime.watchdog!;
    expect(watchdog.running).toBe(true);

    await runtime.shutdown();
    expect(watchdog.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing is adjudicated after the stop: the row stays as shutdown left it.
    f.registry.upsert({ wid: "W2", started_at: utcNow(NOW_MS - 700_000), status: "RUNNING", extra: "sess=gone" });
    vi.advanceTimersByTime(5_000);
    expect(f.registry.getEntry("W2")!.status).toBe("RUNNING");
  });

  it("mounts nothing at all when the watchdog is switched off or disabled by env", async () => {
    const f = fixture();
    const live = composeWithWatchdog(f, { intervalMs: 1_000 });
    await live.shutdown();
    const off = composeWithWatchdog(f, false);
    const disabled = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(), registryPlugin(f.registry)],
      env: { [WATCHDOG_ENV]: "off" },
    });
    expect(live.watchdog).not.toBeNull();
    expect(off.watchdog).toBeNull();
    expect(disabled.watchdog).toBeNull();
    expect(disabled.pluginNames).toEqual(["test.session", "test.workers"]);
    expect(disabled.ctx.get("celestea.workers.Watchdog")).toBeUndefined();
    // `workers: false` has no registry to sweep, so there is no watchdog either.
    const unwired = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], workers: false });
    expect(unwired.watchdog).toBeNull();
    // ... and the harness never touched the shared /tmp registry of the fleet.
    expect(f.registry.tsvPath).not.toBe("/tmp/celestea-workers-registry.tsv");
  });
});

describe("terminal verdict reaches the registry view (W740 §2)", () => {
  it("settles an ended worker to DONE when the deliverable shows up, and the status view follows", async () => {
    const f = fixture();
    const runtime = composeWithWatchdog(f, { intervalMs: 60_000, graceMs: 0, maxRetries: 0 });
    expect(byStatus(f.registry)).toEqual({ RUNNING: 1, DONE: 0, FAILED: 0 });

    mkdirSync(f.results, { recursive: true });
    writeFileSync(join(f.results, "W1-report.md"), "r", "utf8");
    const actions = runtime.watchdog!.tick();
    expect(actions).toEqual([{ kind: "done", wid: "W1" }]);

    expect(byStatus(f.registry)).toEqual({ RUNNING: 0, DONE: 1, FAILED: 0 });
    const entry = f.registry.getEntry("W1")!;
    expect(entry.status).toBe("DONE");
    expect(entry.extra).toContain("ended_at=");
    // The on-disk row is the same verdict (finalize is the single write point).
    expect(readFileSync(join(f.dir, "registry.tsv"), "utf8")).toContain("DONE");
    await runtime.shutdown();
  });

  it("mountWatchdog over a bare registry provides the service and its stop is idempotent", () => {
    const f = fixture();
    const ctx = composeWithWatchdog(f, { intervalMs: 60_000 }).ctx;
    const mounted = mountWatchdog(ctx, f.registry, { intervalMs: 250, maxRetries: 3 });
    expect(mounted).not.toBeNull();
    expect(ctx.get("celestea.workers.Watchdog")).toBe(mounted!.watchdog);
    expect(mounted!.watchdog.current.maxRetries).toBe(3);
    mounted!.stop();
    mounted!.stop();
    expect(mounted!.watchdog.running).toBe(false);
  });
});
