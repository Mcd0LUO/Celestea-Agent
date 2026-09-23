/**
 * W1470 — what a process RESTART must preserve about the persisted worker table.
 *
 * The bug this file pins (reported as "重启后不可寻址 worker 不见了"):
 *
 *   1. ADDRESSABILITY. `SessionRegistry` mints `<prefix>session-<n>` in memory and
 *      has no rehydration path, so after a restart the id a row names
 *      (`sess=`) resolves to `not_found` and the worker can no longer be
 *      addressed at all.
 *   2. COLLISION. The counter restarts at 0 while the table still names
 *      `...session-0`, so the next spawn hands the SAME id to a DIFFERENT worker.
 *   3. GHOSTS. A RUNNING row of the dead process is never claimed (the `proc`
 *      rule makes it foreign) and P0 never acts, so it reads live forever.
 *
 * The three "must" statements below are the acceptance criteria; the P2 half
 * (settling) is exercised through `applyRecovery` and stays OFF by default.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { getExtra, parseRegistryTsv } from "./registry-tsv.js";
import { applyRecovery, recoveryEnabled } from "./recover-apply.js";
import { workerTools } from "./tools.js";

const NOW = Date.parse("2026-09-23T12:00:00Z");
/** The host conversation of this test — the shape the studio composes. */
const HOST = "celestea_studio-ts/W1470";
/** `workerSessionPrefix(HOST)` (packages/runtime/src/host/engine-session.ts). */
const PREFIX = "celestea_studio-ts_W1470-session-";

function tmpTsv(): string {
  return join(mkdtempSync(join(tmpdir(), "w1470-")), "registry.tsv");
}

/** One LIFE of the studio process: its own pid, its own per-host registry. */
function life(path: string, pid: number, host: string | null = HOST): WorkerRegistry {
  return new WorkerRegistry({
    tsvPath: path,
    logFactory: recordingSessionLog,
    now: () => NOW,
    pid,
    resultsDir: join(path, "..", "results"),
    hostSessionId: host,
    sessionIdPrefix: `${(host ?? "").replace(/[^A-Za-z0-9._-]/g, "_")}-session-`,
  });
}

/** Spawn through the REAL tool, so the row carries the tokens a spawn writes. */
async function spawn(registry: WorkerRegistry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = workerTools(registry).find((t) => t.spec().name === "spawn_worker");
  return (await tool?.execute({ report_to: "cli-main", ...args })) as Record<string, unknown>;
}

describe("W1470 (1): the previous life's worker stays ADDRESSABLE", () => {
  it("resolves the exact persisted sess id after a restart, without touching the row", async () => {
    const path = tmpTsv();
    const first = life(path, 1111);
    const spawned = await spawn(first, { wid: "W1", brief: "do the thing", title: "T" });
    const sid = String(spawned["sessionId"]);
    expect(sid).toBe(`${PREFIX}0`);
    // Before the restart the id resolves (the control half of the comparison).
    expect(first.sessions.resolve(sid).session?.meta.id).toBe(sid);
    const before = readFileSync(path, "utf8");

    const second = life(path, 2222);
    const resolved = second.sessions.resolve(sid);
    expect(resolved.error).toBeUndefined();
    expect(resolved.session?.meta.id).toBe(sid);
    // The meta is rebuilt from the row's own tokens, not invented.
    expect(resolved.session?.meta.title).toBe("W1·T");
    expect(resolved.session?.meta.mode).toBeNull();
    expect(second.sessions.logOf(sid)).toBeDefined();
    // Hydration is READ-ONLY: the persisted row is byte-identical.
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("worker_status reports the inherited row instead of 'no worker ... in registry'", async () => {
    const path = tmpTsv();
    const first = life(path, 1111);
    await spawn(first, { wid: "W1", brief: "b", title: "T" });

    const second = life(path, 2222);
    const one = second.status("W1");
    expect(one["ok"]).toBe(true);
    expect(one["worker"]).toMatchObject({ wid: "W1", status: "RUNNING", inherited: true, sess: `${PREFIX}0` });
    const all = second.status();
    expect((all["inherited"] as Array<Record<string, unknown>>).map((r) => r["wid"])).toEqual(["W1"]);
    // Own rows stay the summary's counting basis (the frozen W787 view rule).
    expect(all["total"]).toBe(0);
    expect(all["by_status"]).toEqual({ RUNNING: 0, DONE: 0, FAILED: 0, STOPPED: 0 });
  });
});

describe("W1470 (3): a restart never mints an id the table already names", () => {
  it("continues the counter past the persisted sessions", async () => {
    const path = tmpTsv();
    const first = life(path, 1111);
    await spawn(first, { wid: "W1", brief: "b", title: "T" });
    await spawn(first, { wid: "W2", brief: "b", title: "T" });

    const second = life(path, 2222);
    const spawned = await spawn(second, { wid: "W3", brief: "b", title: "T" });
    expect(spawned["sessionId"]).toBe(`${PREFIX}2`);
    const sids = parseRegistryTsv(readFileSync(path, "utf8")).entries.map((e) => getExtra(e, "sess"));
    expect(new Set(sids).size).toBe(sids.length);
  });

  it("reserves ids of a SIBLING host that sanitizes to the same prefix", async () => {
    const path = tmpTsv();
    // `celestea_studio-ts_W1470` is a DIFFERENT conversation whose id sanitizes
    // onto our prefix; its row must be neither adopted nor re-minted.
    writeFileSync(
      path,
      `W9\t2026-09-23_11:00:00Z\tRUNNING\tsess=${PREFIX}7 title=sibling host=celestea_studio-ts_W1470 attempt=0 lease=9999@1789000000 proc=9999\n`,
      "utf8",
    );
    const second = life(path, 2222);
    expect(second.sessions.resolve(`${PREFIX}7`).error).toEqual({ kind: "not_found", target: `${PREFIX}7` });
    const spawned = await spawn(second, { wid: "W3", brief: "b", title: "T" });
    expect(spawned["sessionId"]).toBe(`${PREFIX}8`);
  });
});

describe("W1470 (2): P2 settles the ghost — OFF by default, ON behind the switch", () => {
  it("the switch is the literal CELESTEA_WORKER_RECOVER=1", () => {
    expect(recoveryEnabled({})).toBe(false);
    expect(recoveryEnabled({ CELESTEA_WORKER_RECOVER: "0" })).toBe(false);
    expect(recoveryEnabled({ CELESTEA_WORKER_RECOVER: "1" })).toBe(true);
  });

  it("a restart alone NEVER rewrites the stale row (P0 stays observation-only)", async () => {
    const path = tmpTsv();
    const first = life(path, 1111);
    await spawn(first, { wid: "W1", brief: "b", title: "T" });
    const before = readFileSync(path, "utf8");

    const second = life(path, 2222);
    // The P0 judgement is unchanged and still reports the dead owner...
    const report = second.recoverCandidates({ pidAlive: (pid) => pid !== 1111, artifactExists: () => false });
    expect(report.stale.map((c) => [c.wid, c.reason, c.action])).toEqual([["W1", "stale_lease", "respawn"]]);
    // ...and nothing was written: constructing the registry is not an action.
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("closes a stale row DONE when a deliverable exists, FAILED otherwise", () => {
    const path = tmpTsv();
    writeFileSync(
      path,
      `W1\t2026-09-23_11:00:00Z\tRUNNING\tsess=${PREFIX}0 title=a host=${HOST} attempt=0 lease=9999@1789000000 proc=9999\n` +
        `W2\t2026-09-23_11:01:00Z\tRUNNING\tsess=${PREFIX}1 title=b host=${HOST} attempt=0 lease=9999@1789000000 proc=9999\n` +
        `W3\t2026-09-23_11:02:00Z\tRUNNING\tsess=${PREFIX}2 title=c host=${HOST} attempt=2 lease=9999@1789000000 retries=2 proc=9999\n` +
        `W4\t2026-09-23_11:03:00Z\tRUNNING\tsess=${PREFIX}3 title=d host=${HOST} attempt=0 lease=4242@1789000000 proc=4242\n`,
      "utf8",
    );
    const reg = life(path, 2222);
    const report = reg.recoverCandidates({ pidAlive: (pid) => pid === 4242, artifactExists: (e) => e.wid === "W1" });
    expect(report.stale.map((c) => c.wid)).toEqual(["W1", "W2", "W3"]);
    expect(report.live).toEqual(["W4"]);

    const applied = applyRecovery(reg, report, { pidAlive: (pid) => pid === 4242 });
    expect(applied.map((a) => [a.wid, a.action, a.outcome])).toEqual([
      ["W1", "close_done", "closed_done"],
      ["W2", "respawn", "failed"],
      ["W3", "fail", "failed"],
    ]);

    const rows = parseRegistryTsv(readFileSync(path, "utf8")).entries;
    const byWid = new Map(rows.map((r) => [r.wid, r]));
    expect(byWid.get("W1")).toMatchObject({ status: "DONE" });
    expect(getExtra(byWid.get("W1")!, "ended_at")).not.toBeNull();
    expect(getExtra(byWid.get("W1")!, "claimed")).toBe(`2222@${Math.floor(NOW / 1000)}`);
    expect(byWid.get("W2")).toMatchObject({ status: "FAILED" });
    expect(getExtra(byWid.get("W2")!, "fail")).toBe("recovered:-no-recoverable-brief");
    expect(byWid.get("W3")).toMatchObject({ status: "FAILED" });
    expect(getExtra(byWid.get("W3")!, "fail")).toBe("recovered:-stale_lease");
    // The LIVE owner's row is untouched, down to its tokens.
    expect(byWid.get("W4")).toMatchObject({ status: "RUNNING" });
    expect(getExtra(byWid.get("W4")!, "proc")).toBe("4242");
    expect(getExtra(byWid.get("W4")!, "claimed")).toBeNull();
  });

  it("claim re-checks liveness itself: an ALIVE owner is never taken over", () => {
    const path = tmpTsv();
    writeFileSync(
      path,
      `W4\t2026-09-23_11:03:00Z\tRUNNING\tsess=${PREFIX}3 title=d host=${HOST} attempt=0 lease=4242@1789000000 proc=4242\n`,
      "utf8",
    );
    const reg = life(path, 2222);
    const before = readFileSync(path, "utf8");
    // The report is not consulted here: the guard is inside claim(), so a caller
    // that hands it a wrong judgement still cannot take a live worker's row.
    expect(reg.claim("W4", (pid) => pid === 4242)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
    const taken = reg.claim("W4", () => false);
    expect(taken?.status).toBe("RUNNING");
    expect(getExtra(taken!, "proc")).toBe("2222");
    expect(getExtra(taken!, "claimed")).toBe(`2222@${Math.floor(NOW / 1000)}`);
  });

  it("never claims a row whose host belongs to another conversation", () => {
    const path = tmpTsv();
    writeFileSync(
      path,
      `W1\t2026-09-23_11:00:00Z\tRUNNING\tsess=other-session-0 title=x host=celestea_studio-ts/OTHER attempt=0 lease=9999@1789000000 proc=9999\n`,
      "utf8",
    );
    const reg = life(path, 2222);
    const before = readFileSync(path, "utf8");
    // Directly, because the persist merge only writes rows this registry OWNS —
    // which is exactly why claim() must refuse a foreign host up front.
    expect(reg.claim("W1", () => false)).toBeNull();
    expect(reg.getEntry("W1")?.extra).not.toContain("claimed=");
    const applied = applyRecovery(reg, reg.recoverCandidates({ pidAlive: () => false }));
    expect(applied.map((a) => [a.wid, a.outcome])).toEqual([["W1", "refused"]]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
