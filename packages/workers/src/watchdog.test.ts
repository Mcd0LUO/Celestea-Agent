import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context } from "@celestea/core";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { getExtra } from "./registry-tsv.js";
import { utcNow } from "./types.js";
import { WATCHDOG_SERVICE, Watchdog, hasDeliverable, hasInProgressTurn, inGrace, parseUtc, watchdogPlugin } from "./watchdog.js";
import { scriptedDrivers, scriptedLoop, waitUntil } from "./fakes.test-util.js";

const NOW_MS = Date.parse("2026-09-10T12:00:00Z");
const NOW_SECS = Math.floor(NOW_MS / 1_000);
const ANCIENT = utcNow(NOW_MS - 700_000);

interface Harness {
  prefix: string;
  results: string;
  registry: WorkerRegistry;
  watchdog: Watchdog;
}

function harness(tag: string, graceMs = 0): Harness {
  const prefix = mkdtempSync(join(tmpdir(), `celestea-wd-${tag}-`));
  const results = join(prefix, "results");
  const registry = new WorkerRegistry({
    tsvPath: join(prefix, "registry.tsv"),
    logFactory: recordingSessionLog,
    now: () => NOW_MS,
    pid: 4242,
    resultsDir: results,
  });
  const watchdog = new Watchdog(registry, { graceMs, now: () => NOW_MS, maxRetries: 2, intervalMs: 5 });
  return { prefix, results, registry, watchdog };
}

/** A row whose session already ran a complete turn (i.e. is not alive). */
function endedWorker(h: Harness, wid: string, extra: string, startedAt = ANCIENT): string {
  const session = h.registry.sessions.create({ title: `${wid}·t` });
  session.log.append({ type: "turn_start", id: "t1" });
  session.log.append({ type: "turn_end", id: "t1", outcome: "completed" });
  h.registry.upsert({ wid, started_at: startedAt, status: "RUNNING", extra: `sess=${session.meta.id} ${extra}` });
  return session.meta.id;
}

describe("watchdog predicates", () => {
  it("parses a registry timestamp with or without the Z mark", () => {
    expect(parseUtc(utcNow(NOW_MS))).toBe(NOW_SECS);
    expect(parseUtc("2026-09-10_12:00:00")).toBe(NOW_SECS);
    expect(parseUtc(" 2026-09-10_12:00:00Z ")).toBe(NOW_SECS);
    expect(parseUtc("2026-13-10_12:00:00")).toBeNull();
    expect(parseUtc("2026-09-10T12:00:00Z")).toBeNull();
  });

  it("counts a turn as in progress only while its turn_end is missing", () => {
    expect(hasInProgressTurn([])).toBe(false);
    expect(hasInProgressTurn([{ type: "turn_start", id: "t1" }])).toBe(true);
    expect(hasInProgressTurn([{ type: "turn_start", id: "t1" }, { type: "turn_end", id: "t1", outcome: "completed" }])).toBe(false);
  });

  it("reads a deliverable, treating a missing results dir as 'not yet'", () => {
    const prefix = mkdtempSync(join(tmpdir(), "celestea-wd-probe-"));
    expect(hasDeliverable(join(prefix, "results"), "W1")).toEqual({ found: false, error: null });
    mkdirSync(join(prefix, "results"));
    writeFileSync(join(prefix, "results", "W1-report.md"), "r", "utf8");
    expect(hasDeliverable(join(prefix, "results"), "W1")).toEqual({ found: true, error: null });
    expect(hasDeliverable(join(prefix, "results"), "W2").found).toBe(false);
    const file = join(prefix, "not-a-dir");
    writeFileSync(file, "x", "utf8");
    expect(hasDeliverable(file, "W1").error).not.toBeNull();
  });

  it("holds only a fresh spawn inside its grace window", () => {
    expect(inGrace(utcNow(NOW_MS), NOW_SECS, 600)).toBe(true);
    expect(inGrace(ANCIENT, NOW_SECS, 600)).toBe(false);
    expect(inGrace("garbage", NOW_SECS, 600)).toBe(false);
  });
});

describe("watchdog tick", () => {
  it("keeps a worker with an open turn RUNNING", () => {
    const h = harness("open");
    const session = h.registry.sessions.create({ title: "W1·t" });
    session.log.append({ type: "turn_start", id: "t1" });
    h.registry.upsert({ wid: "W1", started_at: ANCIENT, status: "RUNNING", extra: `sess=${session.meta.id}` });

    expect(h.watchdog.tick()).toEqual([{ kind: "keep-running", wid: "W1" }]);
    expect(h.registry.getEntry("W1")!.status).toBe("RUNNING");
  });

  it("keeps a parked but driven worker RUNNING (the driver task is alive)", async () => {
    const h = harness("parked");
    const scripted = scriptedLoop();
    h.registry.attachDrivers(scriptedDrivers(scripted));
    const session = h.registry.sessions.create({ title: "W2·t" });
    h.registry.upsert({ wid: "W2", started_at: ANCIENT, status: "RUNNING", extra: `sess=${session.meta.id}` });
    h.registry.driveIfPossible(session.meta.id, "brief", false);
    await waitUntil(() => h.registry.getEntry("W2")!.extra.includes("state=idle"));

    expect(h.watchdog.tick()).toEqual([{ kind: "keep-running", wid: "W2" }]);
    expect(h.registry.getEntry("W2")!.status).toBe("RUNNING");
    h.registry.shutdown();
    await h.registry.joinDrivers();
  });

  it("marks DONE when the session ended and a deliverable exists", () => {
    const h = harness("done");
    const sid = endedWorker(h, "W3", "brief=write-report");
    mkdirSync(h.results, { recursive: true });
    writeFileSync(join(h.results, "W3-report.md"), "report", "utf8");

    expect(h.watchdog.tick()).toEqual([{ kind: "done", wid: "W3" }]);
    const row = h.registry.getEntry("W3")!;
    expect(row.status).toBe("DONE");
    expect(getExtra(row, "ended_at")).toBe(utcNow(NOW_MS));
    // Rust F2: a settled worker gives up its session and its queue.
    expect(h.registry.sessions.get(sid)).toBeUndefined();
  });

  it("fails an ended worker whose session vanished without a deliverable", () => {
    const h = harness("failed");
    const sid = endedWorker(h, "W4", "brief=work retries=2");
    h.registry.sessions.remove(sid);

    expect(h.watchdog.tick()).toEqual([{ kind: "failed", wid: "W4", reason: "retries exhausted (2)" }]);
    const row = h.registry.getEntry("W4")!;
    expect(row.status).toBe("FAILED");
    expect(getExtra(row, "fail")).toBe("retries-exhausted-(2)");
    expect(h.registry.status()["by_status"]).toEqual({ RUNNING: 0, DONE: 0, FAILED: 1 });
  });

  it("defers a fresh anomaly inside the grace window", () => {
    const h = harness("grace", 600_000);
    endedWorker(h, "W5", "brief=work", utcNow(NOW_MS));

    expect(h.watchdog.tick()).toEqual([{ kind: "grace-deferred", wid: "W5" }]);
    expect(h.registry.getEntry("W5")!.status).toBe("RUNNING");
  });

  it("re-dispatches an ended worker with a remembered brief", () => {
    const h = harness("respawn");
    const sid = endedWorker(h, "W6", "brief=work");
    h.registry.rememberSpawn(sid, { wid: "W6", short: "t", brief: "write the report", reportTo: null, mode: null });
    const before = h.registry.sessions.size;

    const actions = h.watchdog.tick();
    expect(actions[0]?.kind).toBe("respawned");
    const row = h.registry.getEntry("W6")!;
    const newSid = getExtra(row, "sess");
    expect(newSid).not.toBe(sid);
    expect(getExtra(row, "retries")).toBe("1");
    expect(getExtra(row, "driven")).toBe("no");
    expect(row.status).toBe("RUNNING");
    // The old session is released, the new one carries the remembered brief.
    expect(h.registry.sessions.get(sid)).toBeUndefined();
    expect(h.registry.sessions.size).toBe(before);
    expect(h.registry.spawnInfo(newSid!)?.brief).toBe("write the report");
  });

  it("re-drives the respawned worker when the driver seams exist", async () => {
    const h = harness("redrive");
    const scripted = scriptedLoop();
    h.registry.attachDrivers(scriptedDrivers(scripted));
    const sid = endedWorker(h, "W10", "brief=work");
    h.registry.rememberSpawn(sid, { wid: "W10", short: "t", brief: "second attempt", reportTo: null, mode: null });

    h.watchdog.tick();
    await waitUntil(() => scripted.inputs.length === 1);
    expect(scripted.inputs[0]).toBe("second attempt");
    h.registry.shutdown();
    await h.registry.joinDrivers();
  });

  it("fails a worker whose brief cannot be recovered", () => {
    const h = harness("nobrief");
    const sid = endedWorker(h, "W7", "brief=work");
    h.registry.sessions.remove(sid);

    expect(h.watchdog.tick()).toEqual([{ kind: "failed", wid: "W7", reason: "no recoverable brief to re-dispatch" }]);
    expect(getExtra(h.registry.getEntry("W7")!, "fail")).toBe("no-recoverable-brief-to-re-dispatch");
  });

  it("skips the round when the deliverable probe itself fails", () => {
    const h = harness("probe");
    const sid = endedWorker(h, "W8", "brief=work");
    h.registry.sessions.remove(sid);
    const file = join(h.prefix, "not-a-dir");
    writeFileSync(file, "x", "utf8");
    const watchdog = new Watchdog(h.registry, { resultsDir: file, now: () => NOW_MS, graceMs: 0 });

    const actions = watchdog.tick();
    expect(actions[0]?.kind).toBe("probe-error");
    expect(h.registry.getEntry("W8")!.status).toBe("RUNNING");
  });

  it("leaves terminal rows alone", () => {
    const h = harness("frozen");
    h.registry.upsert({ wid: "W9", started_at: ANCIENT, status: "FAILED", extra: "sess=gone" });
    expect(h.watchdog.tick()).toEqual([]);
  });

  it("logs every verdict to watcher.log and the noteworthy ones to alerts.log", () => {
    const h = harness("logs");
    const sid = endedWorker(h, "W11", "brief=work retries=2");
    h.registry.sessions.remove(sid);
    const watchdog = new Watchdog(h.registry, {
      now: () => NOW_MS,
      graceMs: 0,
      maxRetries: 2,
      watcherLog: join(h.prefix, "logs", "watcher.log"),
      alertsLog: join(h.prefix, "logs", "alerts.log"),
    });

    watchdog.tick();
    expect(readFileSync(join(h.prefix, "logs", "watcher.log"), "utf8")).toContain("W11 -> FAILED");
    expect(readFileSync(join(h.prefix, "logs", "alerts.log"), "utf8")).toContain("W11 -> FAILED (retries exhausted (2))");
  });
});

describe("watchdogPlugin", () => {
  it("provides the watchdog and sweeps while mounted", () => {
    const registry = new WorkerRegistry({ tsvPath: null, now: () => NOW_MS });
    const ctx = Context.root();
    watchdogPlugin({ registry, config: { intervalMs: 5, now: () => NOW_MS } }).mount(ctx);

    const watchdog = ctx.get(WATCHDOG_SERVICE) as Watchdog;
    expect(watchdog).toBeInstanceOf(Watchdog);
    expect(watchdog.running).toBe(true);
    watchdog.stop();
    expect(watchdog.running).toBe(false);
  });

  it("stays on the caller's cadence with autostart:false", () => {
    const registry = new WorkerRegistry({ tsvPath: null, now: () => NOW_MS });
    const ctx = Context.root();
    const watchdog = new Watchdog(registry, { now: () => NOW_MS });
    watchdogPlugin({ registry, watchdog, autostart: false }).mount(ctx);

    expect(ctx.get(WATCHDOG_SERVICE)).toBe(watchdog);
    expect(watchdog.running).toBe(false);
    expect(watchdog.tick()).toEqual([]);
  });
});
