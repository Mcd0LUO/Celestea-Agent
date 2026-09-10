import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry, isOwn, withProc, withState } from "./registry.js";
import { getExtra, parseRegistryTsv, serializeRegistryTsv } from "./registry-tsv.js";
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
    expect(all["by_status"]).toEqual({ RUNNING: 1, DONE: 1, FAILED: 0 });
    expect(all["by_state"]).toEqual({ "in-turn": 1, idle: 0, running: 0 });
    const one = reg.status("W2");
    expect(one["ok"]).toBe(true);
    expect((one["worker"] as Record<string, unknown>)["sess"]).toBe("session-1");
    expect(reg.status("W404")).toEqual({ ok: false, step: "lookup", error: "no worker W404 in registry" });
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
