import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { parseRegistryTsv } from "./registry-tsv.js";

/**
 * W885/W891: mode bits mean nothing on Windows (W883 E10).
 *
 * Deliberately INLINE rather than imported from the tools package: workers is a
 * tier-1 package, and the architecture rule tier1-no-peer-deps-workers
 * (.dependency-cruiser.cjs) forbids horizontal package imports — same precedent
 * as packages/session/src/checkpoint-log.test.ts.
 */
const fileModesMeaningful = process.platform !== "win32";

/**
 * W831 R3 (B4) — registry persistence robustness + lifecycle.
 *
 * Moved out of registry.test.ts to keep every file inside the ARCHITECTURE §3
 * max-lines budget. Probes are the ones named in the W827-R3 fix plan (B4 items
 * 9 / 10 / 22).
 */

const FIXED_NOW = Date.parse("2026-09-10T12:00:00Z");

function tmpTsv(): string {
  return join(mkdtempSync(join(tmpdir(), "celestea-reg-")), "registry.tsv");
}

function registry(tsvPath: string | null, pid = 4242): WorkerRegistry {
  return new WorkerRegistry({ tsvPath, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid, resultsDir: "results" });
}

describe("W831 R3 B4 — registry persistence robustness + lifecycle (W813 P1-persist-foreign / P1-spawns / R2-A4)", () => {
  /**
   * Acceptance probe from W827-R3 fix plan B4 item 9: a transient READ failure
   * (EACCES on the table, directory still writable) must ABORT the write instead
   * of rewriting the table from this process's rows alone. The old
   * readTableRows -> [] made the merge base empty, so the rename wiped every
   * foreign row while reporting success. (The plan's chmod-000-directory variant
   * fails the WRITE too, so only file-unreadable + directory-writable actually
   * triggers read-failure-then-write.)
   */
  it("W813-9: an unreadable table aborts the write instead of deleting foreign rows", (ctx) => {
    // W891: chmod(0o000) does not make a file unreadable on Windows, so the
    // fixture cannot be built there — visible skip, Linux assertion unchanged.
    if (!fileModesMeaningful) {
      ctx.skip("a chmod-based read denial needs POSIX mode bits");
      return;
    }
    const path = tmpTsv();
    writeFileSync(path, "W9\t2026-09-10_11:00:00Z\tRUNNING\tproc=999\n", "utf8");
    const reg = registry(path);
    expect(reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" })).toBeNull();

    // The table itself becomes unreadable; the containing directory stays writable,
    // so the tmp+rename write would otherwise succeed and drop W9.
    chmodSync(path, 0o000);
    let failure: string | null;
    try {
      failure = reg.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: "sess=session-1" });
    } finally {
      chmodSync(path, 0o644);
    }

    expect(failure).not.toBeNull();
    expect(reg.persistFailures().map((f) => f.wid)).toEqual(["W2"]);
    const rows = parseRegistryTsv(readFileSync(path, "utf8")).entries;
    expect(rows.map((r) => r.wid)).toEqual(["W9", "W1"]);
  });

  /** W827-R3 B4 item 9: a line this process cannot parse must survive the rewrite. */
  it("W813-9: an unparsed line survives a persist (raw passthrough)", () => {
    const path = tmpTsv();
    writeFileSync(path, "W9\t2026-09-10_11:00:00Z\tRUNNING\tproc=999\nBROKEN-NO-TABS\n", "utf8");
    const reg = registry(path);
    expect(reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" })).toBeNull();

    const text = readFileSync(path, "utf8");
    expect(text).toContain("BROKEN-NO-TABS");
    const parsed = parseRegistryTsv(text);
    expect(parsed.entries.map((r) => r.wid).sort()).toEqual(["W1", "W9"]);
    expect(parsed.skipped.map((s) => s.raw)).toEqual(["BROKEN-NO-TABS"]);
  });

  /** W827-R3 B4 item 10: releaseSession must stop pinning the full brief forever. */
  it("W813-10: releaseSession forgets the in-memory spawn facts", () => {
    const reg = registry(null);
    reg.rememberSpawn("session-0", { wid: "W1", short: "s", brief: "the brief", reportTo: null, mode: null });
    expect(reg.spawnInfo("session-0")).toBeDefined();
    reg.releaseSession("session-0");
    expect(reg.spawnInfo("session-0")).toBeUndefined();
  });

  it("W813-10: N spawn/release rounds leave no spawn facts behind", () => {
    const reg = registry(null);
    const leaked: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const sid = "session-" + i;
      reg.rememberSpawn(sid, { wid: "W" + i, short: "s", brief: "x".repeat(200), reportTo: null, mode: null });
      reg.releaseSession(sid);
      if (reg.spawnInfo(sid) !== undefined) leaked.push(sid);
    }
    expect(leaked).toEqual([]);
  });

  /**
   * W827-R3 B4 item 22 (R2-A4): a persist failure must be OBSERVABLE. Today the
   * error string is dropped, so memory says DONE while disk still says RUNNING and
   * nothing warns. The no-throw contract stays; the failure is recorded per row
   * and appended to the alert log (a file, so it survives the restart).
   */
  it("R2-A4: a failed persist is recorded per row, alerted, and leaves disk RUNNING", (ctx) => {
    // W891: the failure is induced by making the DIRECTORY read-only via chmod,
    // which Windows does not honour.
    if (!fileModesMeaningful) {
      ctx.skip("a chmod-based write denial needs POSIX mode bits");
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "celestea-reg-a4-"));
    const dir = join(root, "data");
    mkdirSync(dir);
    const path = join(dir, "registry.tsv");
    const alerts = join(root, "alerts.log");
    const reg = new WorkerRegistry({
      tsvPath: path,
      logFactory: recordingSessionLog,
      now: () => FIXED_NOW,
      pid: 4242,
      resultsDir: "results",
      alertsLog: alerts,
    });
    reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=session-0" });

    // The table stays readable; the directory becomes read-only so tmp+rename fails.
    chmodSync(dir, 0o555);
    try {
      expect(reg.finalize("W1", { ok: true })?.status).toBe("DONE");
    } finally {
      chmodSync(dir, 0o755);
    }

    // The bug is this split: memory DONE / disk RUNNING. It is now named loudly.
    expect(reg.getEntry("W1")!.status).toBe("DONE");
    expect(parseRegistryTsv(readFileSync(path, "utf8")).entries[0]?.status).toBe("RUNNING");
    const failures = reg.persistFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ wid: "W1" });
    expect(failures[0]?.error).toBeTruthy();
    expect(readFileSync(alerts, "utf8")).toContain("registry persist failed");
    expect(readFileSync(alerts, "utf8")).toContain("W1");

    // A restart still reads RUNNING from disk; the durable alert is what stops it
    // being "silent" (recovery would otherwise look like a normal re-dispatch).
    const restarted = registry(path);
    expect(restarted.getEntry("W1")!.status).toBe("RUNNING");
    expect(restarted.persistFailures()).toEqual([]);
  });
});
