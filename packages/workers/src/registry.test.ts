import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry, isOwn, withProc, withState } from "./registry.js";
import { getExtra, parseRegistryTsv, receiptDelivered, receiptKey, serializeRegistryTsv, workerAttempt, workerHost, workerLease } from "./registry-tsv.js";
import { workerTools } from "./tools.js";
import { scriptedDrivers, scriptedLoop, waitUntil } from "./fakes.test-util.js";

const FIXED_NOW = Date.parse("2026-09-10T12:00:00Z");

function tmpTsv(): string {
  return join(mkdtempSync(join(tmpdir(), "celestea-reg-")), "registry.tsv");
}

function registry(tsvPath: string | null, pid = 4242): WorkerRegistry {
  return new WorkerRegistry({ tsvPath, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid, resultsDir: "results" });
}

describe("WorkerRegistry tsv state", () => {
  it("upserts a row, stamps proc, and reloads it from disk byte-for-byte", () => {
    const path = tmpTsv();
    const reg = registry(path);
    expect(reg.upsert({ wid: "W1", started_at: "2026-09-10_12:00:00Z", status: "RUNNING", extra: "sess=session-0 title=t" })).toBeNull();
    const text = readFileSync(path, "utf8");
    expect(text.trim().split("\t")).toEqual(["W1", "2026-09-10_12:00:00Z", "RUNNING", "sess=session-0 title=t proc=4242"]);
    const reloaded = registry(path);
    expect(reloaded.entries()).toEqual(reg.entries());
    expect(getExtra(reloaded.getEntry("W1")!, "proc")).toBe("4242");
  });

  it("replaces an existing wid in place, keeping foreign rows untouched", () => {
    const path = tmpTsv();
    writeFileSync(path, "W9\t2026-09-10_11:00:00Z\tRUNNING\tproc=999\n", "utf8");
    const reg = registry(path);
    reg.upsert({ wid: "W1", started_at: "2026-09-10_12:00:00Z", status: "RUNNING", extra: "sess=session-0" });
    reg.upsert({ wid: "W1", started_at: "2026-09-10_12:00:00Z", status: "DONE", extra: "sess=session-0" });
    const rows = parseRegistryTsv(readFileSync(path, "utf8")).entries;
    expect(rows.map((r) => r.wid)).toEqual(["W9", "W1"]);
    expect(rows[1]?.status).toBe("DONE");
  });

  it("treats only this process's rows as ours (W234)", () => {
    const path = tmpTsv();
    writeFileSync(path, "W1\t2026-09-10_11:00:00Z\tRUNNING\tproc=4242\nW2\t2026-09-10_11:00:00Z\tRUNNING\tproc=999\nW3\t2026-09-10_11:00:00Z\tRUNNING\t\n", "utf8");
    const reg = registry(path);
    expect(reg.ownEntries().map((e) => e.wid)).toEqual(["W1"]);
    expect(isOwn({ wid: "W3", started_at: "", status: "RUNNING", extra: "" }, 4242)).toBe(false);
  });

  it("summarizes only own rows and filters by wid", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0 state=in-turn" });
    reg.upsert({ wid: "W2", started_at: "t", status: "DONE", extra: "sess=session-1" });
    const all = reg.status();
    expect(all["total"]).toBe(2);
    expect(all["by_status"]).toEqual({ RUNNING: 1, DONE: 1, FAILED: 0, STOPPED: 0 });
    expect(all["by_state"]).toEqual({ "in-turn": 1, idle: 0, running: 0 });
    const one = reg.status("W2");
    expect(one["ok"]).toBe(true);
    expect((one["worker"] as Record<string, unknown>)["sess"]).toBe("session-1");
    expect(reg.status("W404")).toEqual({ ok: false, step: "lookup", error: "no worker W404 in registry" });
  });

  it("W7: finalize honours an explicit terminal status and freezes exactly once", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });
    const stopped = reg.finalize("W1", { ok: false, status: "STOPPED", reason: "operator halt" });
    expect(stopped?.status).toBe("STOPPED");
    expect(getExtra(reg.getEntry("W1")!, "stop")).toBe("operator-halt");
    expect(getExtra(reg.getEntry("W1")!, "fail")).toBeNull();
    expect(getExtra(reg.getEntry("W1")!, "state")).toBe("idle");
    expect(getExtra(reg.getEntry("W1")!, "ended_at")).not.toBeNull();
    // the single terminal write point freezes: a second verdict is a no-op.
    expect(reg.finalize("W1", { ok: true })).toBeNull();
    expect(reg.getEntry("W1")!.status).toBe("STOPPED");
  });

  it("annotates the state token of a RUNNING row and freezes DONE rows", () => {
    const path = tmpTsv();
    const reg = registry(path);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });
    reg.setWorkerState("session-0", "idle");
    expect(getExtra(reg.getEntry("W1")!, "state")).toBe("idle");
    reg.setWorkerState("session-0", "in-turn");
    expect(getExtra(reg.getEntry("W1")!, "state")).toBe("in-turn");
    reg.upsert({ wid: "W1", started_at: "t", status: "DONE", extra: "sess=session-0" });
    reg.setWorkerState("session-0", "idle");
    expect(getExtra(reg.getEntry("W1")!, "state")).toBeNull();
  });

  it("ignores a state update for an unknown session", () => {
    const reg = registry(null);
    reg.setWorkerState("session-404", "idle");
    expect(reg.entries()).toEqual([]);
  });

  it("keeps everything in memory when tsvPath is null", () => {
    const reg = registry(null);
    expect(reg.tsvPath).toBeNull();
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "" });
    expect(reg.entries().map((e) => e.wid)).toEqual(["W1"]);
  });

  it("maps a session id back to its wid", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W7", started_at: "t", status: "RUNNING", extra: "sess=session-3" });
    expect(reg.sessionFor("W7")).toBe("session-3");
    expect(reg.sessionFor("W8")).toBe("");
  });

  it("round-trips through the shared serializer", () => {
    const rows = parseRegistryTsv("W1\tt\tRUNNING\tsess=session-0 proc=1\n").entries;
    expect(parseRegistryTsv(serializeRegistryTsv(rows)).entries).toEqual(rows);
  });

  it("stamps proc/state tokens without duplicating or reordering the rest", () => {
    const entry = { wid: "W1", started_at: "t", status: "RUNNING" as const, extra: "sess=session-0 proc=1 title=x" };
    expect(withProc(entry, 5).extra).toBe("sess=session-0 title=x proc=5");
    expect(withState(entry, "idle").extra).toBe("sess=session-0 proc=1 title=x state=idle");
  });
});

describe("WorkerRegistry lifecycle", () => {
  it("cannot drive without the three seams", () => {
    const reg = registry(null);
    reg.sessions.create({ title: "W1·t" });
    expect(reg.canDrive()).toBe(false);
    expect(reg.driveIfPossible("session-0", "brief")).toBe(false);
  });

  it("drives a known session and reaps the task when it exits", async () => {
    const reg = registry(null);
    const scripted = scriptedLoop();
    reg.attachDrivers(scriptedDrivers(scripted));
    const session = reg.sessions.create({ title: "W1·brief" });
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id}` });
    expect(reg.canDrive()).toBe(true);
    expect(reg.driveIfPossible(session.meta.id, "do it")).toBe(true);
    expect(reg.backgroundLen()).toBe(1);
    await waitUntil(() => scripted.inputs.length === 1);
    reg.stopDriver(session.meta.id);
    await reg.joinDrivers();
    expect(reg.backgroundLen()).toBe(0);
    expect(scripted.inputs).toEqual(["do it"]);
  });

  it("refuses to drive an unknown session", () => {
    const reg = registry(null);
    reg.attachDrivers(scriptedDrivers(scriptedLoop()));
    expect(reg.driveIfPossible("session-404", "brief")).toBe(false);
    expect(reg.backgroundLen()).toBe(0);
  });

  it("shutdown stops drivers, purges queues and clears sessions", async () => {
    const reg = registry(null);
    const scripted = scriptedLoop();
    reg.attachDrivers(scriptedDrivers(scripted));
    const session = reg.sessions.create({ title: "W1·brief" });
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id}` });
    // Park the driver on its mailbox before shutting down.
    reg.driveIfPossible(session.meta.id, "brief");
    await waitUntil(() => scripted.inputs.length === 1);
    reg.mailbox.send(session.meta.id, "queued", "host");
    reg.mailbox.send("cli-main", "stale receipt", "W1");

    reg.shutdown();
    await reg.joinDrivers();
    expect(reg.mailbox.pendingTotal()).toBe(0);
    expect(reg.sessions.size).toBe(0);
    expect(reg.entries()).toEqual([]);
    expect(reg.backgroundLen()).toBe(0);
  });

  it("release marks the registry unusable for good", () => {
    const reg = registry(null);
    reg.release();
    expect(reg.isReleased).toBe(true);
    expect(reg.canDrive()).toBe(false);
    expect(reg.driveIfPossible("session-0", "brief")).toBe(false);
  });

  it("exposes registry metadata and setters", () => {
    const reg = registry(null);
    expect(reg.pid).toBe(4242);
    expect(reg.resultsDir).toBe("results");
    reg.setResultsDir("/tmp/out");
    expect(reg.resultsDir).toBe("/tmp/out");
    reg.setSourceLabel("W278");
    expect(reg.sourceLabel).toBe("W278");
    expect(reg.mailbox.pendingTotal()).toBe(0);
  });
});

describe("WorkerRegistry state machine (W736)", () => {
  it("settles a RUNNING row to DONE on disk, with the terminal stamp", () => {
    const path = tmpTsv();
    const reg = registry(path);
    reg.upsert({ wid: "W1", started_at: "2026-09-10_11:00:00Z", status: "RUNNING", extra: "sess=session-0 state=in-turn" });

    const settled = reg.finalize("W1", { ok: true });
    expect(settled?.status).toBe("DONE");
    // A frozen row is at rest: a stale `in-turn` would read as a running turn.
    expect(getExtra(settled!, "state")).toBe("idle");
    expect(getExtra(settled!, "ended_at")).toBe("2026-09-10_12:00:00Z");
    expect(getExtra(settled!, "fail")).toBeNull();
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries[0]?.status).toBe("DONE");
    // W736: worker_status explains the terminal row (stamp + reason).
    const view = reg.status("W1")["worker"] as Record<string, unknown>;
    expect(view["status"]).toBe("DONE");
    expect(view["ended_at"]).toBe("2026-09-10_12:00:00Z");
  });

  it("settles to FAILED with the reason, then freezes the row", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=session-1" });

    expect(reg.finalize("W2", { ok: false, reason: "no llm" })?.status).toBe("FAILED");
    expect(getExtra(reg.getEntry("W2")!, "fail")).toBe("no-llm");
    expect(reg.finalize("W2", { ok: true })).toBeNull();
    expect(reg.finalize("W404", { ok: true })).toBeNull();
    expect(reg.getEntry("W2")!.status).toBe("FAILED");
  });

  it("finalizes by session id and never rewrites a foreign row", () => {
    const path = tmpTsv();
    writeFileSync(path, "W9\t2026-09-10_11:00:00Z\tRUNNING\tproc=999\n", "utf8");
    const reg = registry(path);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });

    expect(reg.finalize("W9", { ok: true })).toBeNull();
    expect(reg.finalizeSession("session-0", { ok: true })?.wid).toBe("W1");
    expect(reg.finalizeSession("session-404", { ok: true })).toBeNull();
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries[0]?.status).toBe("RUNNING");
  });

  it("counts the REAL statuses in worker_status (never a permanent RUNNING)", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });
    reg.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=session-1" });
    reg.upsert({ wid: "W3", started_at: "t", status: "RUNNING", extra: "sess=session-2" });
    reg.finalizeSession("session-0", { ok: true });
    reg.finalizeSession("session-1", { ok: false, reason: "boom" });

    const all = reg.status();
    expect(all["total"]).toBe(3);
    expect(all["by_status"]).toEqual({ RUNNING: 1, DONE: 1, FAILED: 1, STOPPED: 0 });
    expect(all["by_state"]).toEqual({ idle: 0, "in-turn": 0, running: 1 });
    expect((reg.status("W2")["worker"] as Record<string, unknown>)["fail"]).toBe("boom");
  });

  it("fails a still-RUNNING row when its driver exits (session gone)", async () => {
    const reg = registry(null);
    const scripted = scriptedLoop();
    reg.attachDrivers(scriptedDrivers(scripted));
    const session = reg.sessions.create({ title: "W1·t" });
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id}` });
    // No receipt protocol: only the driver exit can settle this row.
    reg.driveIfPossible(session.meta.id, "brief", false);
    await waitUntil(() => scripted.inputs.length === 1);

    reg.sessions.remove(session.meta.id);
    reg.stopDriver(session.meta.id);
    await reg.joinDrivers();
    const row = reg.getEntry("W1")!;
    expect(row.status).toBe("FAILED");
    expect(getExtra(row, "fail")).toBe("driver-exited:-session-gone");
  });

  it("settles the rows a stopping host abandons", () => {
    const path = tmpTsv();
    const reg = registry(path);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });
    reg.upsert({ wid: "W2", started_at: "t", status: "DONE", extra: "sess=session-1" });

    reg.shutdown();
    const rows = parseRegistryTsv(readFileSync(path, "utf8")).entries;
    expect(rows.map((r) => `${r.wid}:${r.status}`)).toEqual(["W1:FAILED", "W2:DONE"]);
    expect(getExtra(rows[0]!, "fail")).toBe("registry-shutdown");
  });
});

describe("E §2.3 P0/P1 (W787): persisted table, attempt tokens, boot observation", () => {
  it("B1: a NEW registry instance reads the same table; the row is foreign but visible", () => {
    const path = tmpTsv();
    const a = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 1111, resultsDir: "results", hostSessionId: "ws/s1" });
    // Process A dispatches (the tokens the worker tools stamp, §2.2.2).
    a.upsert({ wid: "W1", started_at: "2026-09-10_12:00:00Z", status: "RUNNING", extra: "sess=session-0 host=ws/s1 attempt=1 lease=1111@1789000000 proc=1111" });

    // Process B: another pid — and another host session, so the row is foreign twice over.
    const b = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 2222, resultsDir: "results", hostSessionId: "ws/s2" });
    expect(b.ownEntries()).toEqual([]);
    expect(b.entries().map((e) => e.wid)).toEqual(["W1"]);
    // The judgement is observation-only: the dead owner makes it STALE, and the
    // deliverable decides what P2 would do (close it as DONE).
    const report = b.recoverCandidates({ pidAlive: () => false, artifactExists: () => true, now: 42 });
    expect(report.observed_at).toBe(42);
    expect(report.stale.map((c) => [c.wid, c.reason, c.attempt, c.host_session, c.action, c.artifact])).toEqual([["W1", "stale_lease", 1, "ws/s1", "close_done", true]]);
    expect(report.live).toEqual([]);
    expect(report.frozen).toEqual([]);
    // NOTHING was rewritten: P0 never settles or re-dispatches at boot.
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries[0]?.status).toBe("RUNNING");
  });

  it("B1b: a live owner and a missing host session are told apart", () => {
    const reg = registry(null);
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=s1 host=ws/gone attempt=1 lease=4242@1789000000" });
    reg.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=s2 host=ws/s1 attempt=1 lease=4242@1789000000" });
    reg.upsert({ wid: "W3", started_at: "t", status: "DONE", extra: "sess=s3 host=ws/s1" });
    const report = reg.recoverCandidates({ pidAlive: () => true, knownHost: (sid) => sid === "ws/s1" });
    expect(report.orphans.map((c) => c.wid)).toEqual(["W1"]);
    expect(report.live).toEqual(["W2"]);
    expect(report.frozen).toEqual(["W3"]);
    expect(report.stale).toEqual([]);
  });

  it("B4 (P0 half): RUNNING + dead owner + NO deliverable is judged, never re-dispatched", () => {
    const path = tmpTsv();
    const reg = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 3333, resultsDir: "results", hostSessionId: "ws/s1" });
    reg.upsert({ wid: "W7", started_at: "t", status: "RUNNING", extra: "sess=s7 host=ws/s1 attempt=1 lease=9999@1789000000 retries=0" });
    const before = readFileSync(path, "utf8");
    const report = reg.recoverCandidates({ pidAlive: () => false, artifactExists: () => false });
    expect(report.stale.map((c) => [c.wid, c.action, c.retries])).toEqual([["W7", "respawn", 0]]);
    // B8 (P0 half): a SECOND observation is a no-op — same judgement, same bytes.
    expect(reg.recoverCandidates({ pidAlive: () => false, artifactExists: () => false }).stale).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    // Exhausted retries would be a FAILED close in P2 (the decision is recorded, not taken).
    reg.upsert({ wid: "W8", started_at: "t", status: "RUNNING", extra: "sess=s8 host=ws/s1 attempt=2 lease=9999@1789000000 retries=2" });
    expect(reg.recoverCandidates({ pidAlive: () => false }).stale.map((c) => [c.wid, c.action])).toEqual([["W7", "respawn"], ["W8", "fail"]]);
  });

  it("a row without a lease is judged by its `proc` (the legacy fallback)", () => {
    const reg = registry(null, 4242);
    // A pre-W787 row has neither `lease=` nor `attempt=`: `proc` is the only
    // liveness evidence, and NO attempt token means "a first try" ⇒ 0 (§5.2).
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=s1 host=ws/s1" });
    expect(reg.recoverCandidates({ pidAlive: (pid) => pid === 4242 }).live).toEqual(["W1"]);
    const stale = reg.recoverCandidates({ pidAlive: () => false }).stale;
    expect(stale.map((c) => c.lease_pid)).toEqual([4242]);
    expect(stale.map((c) => c.attempt)).toEqual([0]);
    expect(workerAttempt(reg.getEntry("W1")!)).toBe(0);
  });

  it("stamps host/attempt/lease through the worker tools and bumps the attempt on respawn", async () => {
    const path = tmpTsv();
    const reg = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 4444, resultsDir: "results", hostSessionId: "ws/s1" });
    const tools = new Map(workerTools(reg).map((t) => [t.spec().name, (args: unknown) => t.execute(args) as Promise<unknown>]));
    await tools.get("spawn_worker")!({ wid: "W5", brief: "b", report_to: "host" });
    const row = reg.getEntry("W5")!;
    expect(getExtra(row, "host")).toBe("ws/s1");
    // §5.2 (the cross-capability convention): the FIRST try is attempt 0.
    expect(getExtra(row, "attempt")).toBe("0");
    expect(getExtra(row, "lease")).toBe(`4444@${Math.floor(FIXED_NOW / 1000)}`);
    // A re-dispatch is the NEXT attempt of the same wid: 0 -> 1.
    reg.rememberSpawn(getExtra(row, "sess")!, { wid: "W5", short: "b", brief: "b", reportTo: "host", mode: null });
    const sid = reg.respawn("W5");
    expect(sid).not.toBeNull();
    expect(getExtra(reg.getEntry("W5")!, "attempt")).toBe("1");
    expect(getExtra(reg.getEntry("W5")!, "retries")).toBe("1");
  });

  it("B7: round-trips a row carrying all four new tokens byte-for-byte", () => {
    const line = "W9\t2026-09-10_12:00:00Z\tRUNNING\tsess=s9 title=t host=ws/s1 attempt=3 lease=4242@1789000000 receipt=W9:2 proc=4242";
    const parsed = parseRegistryTsv(`${line}\n`);
    expect(parsed.entries).toHaveLength(1);
    expect(serializeRegistryTsv(parsed.entries)).toBe(`${line}\n`);
    const entry = parsed.entries[0]!;
    expect([workerHost(entry), workerAttempt(entry), workerLease(entry), receiptDelivered(entry, 2), receiptDelivered(entry, 3)]).toEqual(["ws/s1", 3, { pid: 4242, at: 1789000000 }, true, false]);
    expect(receiptKey(entry.wid, workerAttempt(entry))).toBe("receipt:W9:3");
  });

  it("B6: writing one session's row KEEPS the rows another session already wrote", () => {
    const path = tmpTsv();
    const s1 = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 4242, resultsDir: "results", hostSessionId: "ws/s1" });
    const s2 = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 4242, resultsDir: "results", hostSessionId: "ws/s2" });
    s1.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=a host=ws/s1 attempt=1" });
    s2.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=b host=ws/s2 attempt=1" });
    // One process, ONE table, TWO host sessions — and each sees only its own row.
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries.map((e) => e.wid).sort()).toEqual(["W1", "W2"]);
    expect(s1.ownEntries().map((e) => e.wid)).toEqual(["W1"]);
    expect(s2.ownEntries().map((e) => e.wid)).toEqual(["W2"]);
    expect(s2.getEntry("W1")?.status).toBe("RUNNING");
  });
});

describe("W825 P0: the shared table is read-modify-write, never a stale-snapshot merge", () => {
  /**
   * Acceptance probe derived from /tmp/w822-reg.mts (W822 R2 adversarial
   * verification): session A spawns W1, session B — the SAME process and the
   * SAME table, at the SAME pid, which is the W787 architecture — reloads W1, A
   * finalizes W1 DONE, then B's unrelated upsert must not put B's stale RUNNING
   * copy back.
   */
  it("never rolls a sibling's terminal row back to its stale snapshot", () => {
    const path = tmpTsv();
    const A = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 4242, resultsDir: "results", hostSessionId: "ws/A" });
    A.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=a host=ws/A attempt=0" });
    // Session B activates later and reloads W1 into its (then-current) snapshot.
    const B = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid: 4242, resultsDir: "results", hostSessionId: "ws/B" });
    expect(B.getEntry("W1")?.status).toBe("RUNNING");

    expect(A.finalize("W1", { ok: true })?.status).toBe("DONE");
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries[0]?.status).toBe("DONE");

    // B's own worker write is the trigger; A's terminal row must survive.
    B.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=b host=ws/B attempt=0" });
    const rows = parseRegistryTsv(readFileSync(path, "utf8")).entries;
    const w1 = rows.find((r) => r.wid === "W1");
    expect(w1?.status).toBe("DONE");
    expect(getExtra(w1!, "ended_at")).not.toBeNull();
    expect(rows.find((r) => r.wid === "W2")?.status).toBe("RUNNING");
  });
});
