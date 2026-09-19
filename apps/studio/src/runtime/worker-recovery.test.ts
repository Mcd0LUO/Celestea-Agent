/**
 * E §2.3 P0 (W787) on the REAL studio path: the persisted worker table, the boot
 * observation and the two "no" guarantees.
 *
 *   B4 — a RUNNING row of a dead process is OBSERVED (audit + `stale[]`), and
 *        NOTHING is re-dispatched or rewritten at boot;
 *   B6 — the DEFAULT configuration never touches the DSH-side fleet's table
 *        (`workerBase/registry.tsv`), and writes go to the CONFIGURED path;
 *   the optional in-memory mode (`CELESTEA_WORKER_REGISTRY=""` / `tsvPath: null`)
 *        still exists for tests and embedded hosts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { observeWorkerTableOnBoot } from "./worker-recovery.js";
import { RecoveryAuditWriter } from "./recovery-audit.js";
import { workerTablePath } from "./worker-table.js";
import { activate, engineOf, makeEngineHarness, turns } from "./test-util.js";

const harnesses: StudioHarness[] = [];
const temps: string[] = [];

afterEach(async () => {
  // Teardown order matters: an engine that still holds a session directory must
  // be shut down BEFORE the directory is removed, or the checkpoint/ledger
  // writers race the `rmSync` (the store reports that as a swallowed warning).
  for (const h of harnesses.splice(0)) {
    await engineOf(h).shutdown();
    h.cleanup();
  }
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function make(opts: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: turns(1) }, ...opts });
  harnesses.push(h);
  return h;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w787-"));
  temps.push(dir);
  return dir;
}

/** One RUNNING row of a process that is not alive any more (lease pid 999999). */
function staleTable(): string {
  return "W701\t2026-09-10_12:00:00Z\tRUNNING\tsess=s7 title=orphan host=ws/gone attempt=1 lease=999999@1789000000 proc=999999\n";
}

describe("§2.3 P0 ①: where the table lives (B6)", () => {
  it("default config writes <data dir>/worker-registry.tsv and NEVER the fleet's table", async () => {
    const foreign = "workerBase/registry.tsv";
    const h = make({ rawFiles: { [foreign]: "W900\t2026-01-01_00:00:00Z\tRUNNING\tproc=1\n" } });
    const fleetPath = join(h.root, foreign);
    const before = { mtime: statSync(fleetPath).mtimeMs, body: readFileSync(fleetPath, "utf8") };

    await activate(h, "sample-ws/s1");
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W710", brief: "b", title: "T", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);

    // The write target IS the configured default (the data dir of the host).
    const own = join(h.root, "worker-registry.tsv");
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(own, "utf8")).toContain("W710");
    expect(readFileSync(own, "utf8")).toContain("host=sample-ws/s1");
    // …and the OTHER fleet's table is byte-identical, mtime included (R2-1).
    expect(readFileSync(fleetPath, "utf8")).toBe(before.body);
    expect(statSync(fleetPath).mtimeMs).toBe(before.mtime);
  });

  it("honours CELESTEA_WORKER_REGISTRY, and an EMPTY value keeps the table in memory", async () => {
    const custom = join(tempDir(), "custom-registry.tsv");
    const h = make({ env: { CELESTEA_WORKER_REGISTRY: custom } });
    await activate(h, "sample-ws/s1");
    await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W711", brief: "b", session: "sample-ws/s1" }));
    expect(readFileSync(custom, "utf8")).toContain("W711");
    expect(existsSync(join(h.root, "worker-registry.tsv"))).toBe(false);

    const memory = make({ env: { CELESTEA_WORKER_REGISTRY: "  " } });
    await activate(memory, "sample-ws/s1");
    await getJson(memory.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W712", brief: "b", session: "sample-ws/s1" }));
    expect(existsSync(join(memory.root, "worker-registry.tsv"))).toBe(false);
    // The in-memory registry still ANSWERS (tsvPath: null is a first-class mode).
    expect(engineOf(memory).workerStatus("W712").ok).toBe(true);
  });
});

describe("§2.3 P0 ③: boot observation (B4), and it never re-dispatches", () => {
  it("reports stale/orphan rows in the audit and in GET /api/worker/status, without touching the row", async () => {
    // The first attempt's report EXISTS: R2-4's probe accepts ANY
    // `results/<wid>*.md`, so the judgement is "close it as DONE" (not "respawn").
    const h = make({ rawFiles: { "worker-registry.tsv": staleTable(), "worker-results/W701-orphan-a1.md": "report" } });
    const table = join(h.root, "worker-registry.tsv");
    const before = readFileSync(table, "utf8");

    // The boot observer ran inside createStudioApp, before any engine existed.
    const audit = readFileSync(join(h.root, "recovery-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    // `worker_stale` first (the owner is dead), then `worker_orphan` (its host
    // session is gone too), then the ONE summary line of the sweep.
    expect(audit.map((e) => e["event"])).toEqual(["worker_stale", "worker_orphan", "worker_observed"]);
    expect(audit[0]).toMatchObject({ wid: "W701", attempt: 1, host_session: "ws/gone", reason: "stale_lease", action: "close_done" });
    expect(audit[2]).toMatchObject({ session: null, count: 2 });

    // The table was NOT rewritten (P0 = observation only, R2-2).
    expect(readFileSync(table, "utf8")).toBe(before);

    const status = await getJson(h.app, "/api/worker/status");
    const stale = status.body["stale"] as Array<Record<string, unknown>>;
    const orphans = status.body["orphans"] as Array<Record<string, unknown>>;
    expect(stale.map((c) => [c["wid"], c["reason"], c["action"]])).toEqual([["W701", "stale_lease", "close_done"]]);
    expect(orphans.map((c) => c["wid"])).toEqual(["W701"]);
    // No driver was started for it: the row still reads RUNNING and owns no session.
    expect(readFileSync(table, "utf8")).toBe(before);

    // §2.3 P1 ③: the HTTP worker rows carry `attempt` + `last_receipt` too.
    await activate(h, "sample-ws/s1");
    const registry = engineOf(h).workersOf("sample-ws/s1");
    registry?.upsert({ wid: "W720", started_at: "t", status: "RUNNING", extra: "sess=s7 title=T attempt=2 host=sample-ws/s1 receipt=W720:1" });
    const rows = (await getJson(h.app, "/api/worker/status")).body["workers"] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r["wid"] === "W720")).toMatchObject({ attempt: 2, last_receipt: "W720:1", host_session: "sample-ws/s1" });
  });

  it("B8 (P0 half): two boot observations are idempotent — no new row, no rewrite, no receipt", () => {
    const dir = tempDir();
    const path = join(dir, "worker-registry.tsv");
    writeFileSync(path, staleTable(), "utf8");
    const audit = new RecoveryAuditWriter({ dataDir: dir, now: () => 1 });
    const input = { path, knownHost: () => false, resultsDir: join(dir, "worker-results"), audit, warn: (): void => {} };
    const first = observeWorkerTableOnBoot(input);
    const afterFirst = readFileSync(path, "utf8");
    const second = observeWorkerTableOnBoot(input);
    expect(second.stale.map((c) => c.wid)).toEqual(first.stale.map((c) => c.wid));
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    // No re-dispatch and no receipt: the results dir was never even created.
    expect(existsSync(join(dir, "worker-results"))).toBe(false);
  });
});

describe("§2.2.1: the configured path resolution (worker-table.ts)", () => {
  it("prefers the explicit option, then the env, then <data dir>", () => {
    // W891: build every absolute path through resolve()/join() so the assertion
    // holds on Windows too (a bare "/data" is not absolute there).
    const dataDir = resolve(tmpdir(), "w891-worker-data");
    const envPath = resolve(tmpdir(), "w891-worker-registry.tsv");
    const resultsDir = join(dataDir, "worker-results");
    expect(workerTablePath({ env: {}, dataDir })).toBe(join(dataDir, "worker-registry.tsv"));
    expect(workerTablePath({ env: { CELESTEA_WORKER_REGISTRY: envPath }, dataDir })).toBe(envPath);
    expect(workerTablePath({ env: { CELESTEA_WORKER_REGISTRY: "" }, dataDir })).toBeNull();
    expect(workerTablePath({ env: {}, dataDir, override: null })).toBeNull();
    expect(workerTablePath({ env: {}, dataDir: null, resultsDir })).toBe(join(dataDir, "worker-registry.tsv"));
    expect(workerTablePath({ env: {}, dataDir: null, resultsDir: null })).toBeNull();
  });
});


describe("W831 R3 B5/A3: /api/worker/status uses the exact deliverable probe", () => {
  it("a W10 report does not make W1 look DONE (action stays respawn)", async () => {
    const tsv = "W1\t2026-09-10_12:00:00Z\tRUNNING\tsess=s1 title=t host=ws/gone attempt=0 lease=999999@1789000000 proc=999999\n";
    const h = make({ rawFiles: { "worker-registry.tsv": tsv, "worker-results/W10-report-a0.md": "report" } });
    const status = await getJson(h.app, "/api/worker/status");
    const stale = status.body["stale"] as Array<Record<string, unknown>>;
    const row = stale.find((c) => c["wid"] === "W1");
    expect(row?.["action"]).toBe("respawn");
    expect(row?.["artifact"]).toBe(false);
    // The orphan list is the same judgement, so it must not silently drop W1 either.
    const orphans = status.body["orphans"] as Array<Record<string, unknown>>;
    expect(orphans.map((c) => c["wid"])).toEqual(["W1"]);
  });
});
