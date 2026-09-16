/**
 * W836 R3 batch I — the watchdog mount contract (P2-1).
 *
 * Probe from the authoritative plan
 * `/server-center/runtime/worker-exec/results/W826-R3修复计划-A-core-llm-runtime.md`
 * (§三 批次 I): `watchdog:{autostart:false}` must still mount the service, with
 * NO cadence timer, so the caller can drive `tick()` by hand.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { definePlugin } from "@celestea/core";
import { WORKER_REGISTRY_SERVICE, WorkerRegistry } from "@celestea/workers";
import { compose } from "./compose.js";
import { memorySessionPlugin, testProfile } from "./fakes.test-util.js";
import { WATCHDOG_PLUGIN_NAME } from "./watchdog-mount.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function registryOf(): WorkerRegistry {
  const dir = mkdtempSync(join(tmpdir(), "r3-wd-"));
  roots.push(dir);
  return new WorkerRegistry({ tsvPath: join(dir, "registry.tsv"), resultsDir: join(dir, "results") });
}

describe("P2-1: autostart:false still mounts the watchdog", () => {
  it("provides the service with no timer and supports a manual tick", async () => {
    vi.useFakeTimers();
    const workers = registryOf();
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(), definePlugin("test.workers", (ctx) => ctx.provide(WORKER_REGISTRY_SERVICE, workers))],
      watchdog: { autostart: false },
    });
    const watchdog = runtime.watchdog;
    expect(watchdog).not.toBeNull();
    expect(runtime.pluginNames).toEqual(["test.session", "test.workers", WATCHDOG_PLUGIN_NAME]);
    expect(runtime.ctx.get("celestea.workers.Watchdog")).toBe(watchdog);
    expect(watchdog!.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(watchdog!.tick()).toEqual([]);
    await runtime.shutdown();
  });
});
