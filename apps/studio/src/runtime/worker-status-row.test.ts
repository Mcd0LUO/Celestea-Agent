/**
 * W894 — the worker status report's ROW shape and the per-worker context reading.
 *
 * Two things this pins, both wrong before:
 *   1. the report returned the PANEL row (16 fields, four of them hard-coded
 *      constants in every row: workspace "engine", modified 0, active false, kind "worker");
 *   2. it carried NO per-worker context reading, so a coordinator could not tell a
 *      worker that was about to run out of context from one that was fine.
 */
import { describe, expect, it } from "vitest";
import { aggregateWorkerStatus } from "./worker-bridge.js";
import { toStatusRow } from "./worker-status-row.js";
import { getJson, jsonRequest, makeHarness } from "../harness.test-util.js";
import { engineOf, makeEngineHarness } from "./test-util.js";
import type { WorkerContextUsage, WorkerSessionRow } from "../runtime-adapter.js";

function panelRow(over: Partial<WorkerSessionRow> = {}): WorkerSessionRow {
  return {
    id: "worker:s1",
    workspace: "engine",
    kind: "worker",
    title: "T",
    model: null,
    mode: "standard",
    size: 3,
    modified: 0,
    active: false,
    wid: "W1",
    sess: "s1",
    started_at: "2026-01-01_00:00:00",
    status: "RUNNING",
    state: "idle",
    host_session: "host-1",
    attempt: 1,
    last_receipt: null,
    busy: false,
    ...over,
  };
}

const CTX: WorkerContextUsage = {
  used: 100,
  window: 1000,
  ratio: 0.1,
  estimated: false,
  method: "usage_prompt_tokens",
  projected: false,
  window_source: "profile",
};

describe("W894 worker status row", () => {
  it("projects away the hard-coded constants and keeps the orchestration facts", () => {
    const row = toStatusRow(panelRow(), CTX);
    for (const dead of ["workspace", "modified", "active", "kind", "id"]) {
      expect(row, "panel-only field must not leak into the report: " + dead).not.toHaveProperty(dead);
    }
    expect(row).toMatchObject({
      wid: "W1",
      sess: "s1",
      host_session: "host-1",
      title: "T",
      status: "RUNNING",
      state: "idle",
      mode: "standard",
      size: 3,
      attempt: 1,
      last_receipt: null,
      started_at: "2026-01-01_00:00:00",
      busy: false,
      context: CTX,
    });
  });

  it("measures every worker from ITS OWN conversation", () => {
    const seen: string[] = [];
    const report = aggregateWorkerStatus(
      [panelRow({ wid: "W1", sess: "s1" }), panelRow({ wid: "W2", sess: "s2" })],
      undefined,
      (sess) => {
        seen.push(sess);
        return CTX;
      },
    );
    expect(seen).toEqual(["s1", "s2"]);
    expect(report.workers.map((w) => w.wid)).toEqual(["W1", "W2"]);
    expect(report.workers.every((w) => w.context === CTX)).toBe(true);
  });

  it("reports null (never a fabricated zero) when there is no session to measure", () => {
    const report = aggregateWorkerStatus([panelRow({ sess: null })], undefined, () => {
      throw new Error("must not measure a row that has no session");
    });
    expect(report.workers[0]!.context).toBeNull();
  });

  it("counts by_state over RUNNING workers only", () => {
    const report = aggregateWorkerStatus([
      panelRow({ wid: "W1", status: "RUNNING", state: "in-turn" }),
      panelRow({ wid: "W2", status: "DONE", state: "idle" }),
      panelRow({ wid: "W3", status: "FAILED", state: "idle" }),
      panelRow({ wid: "W4", status: "RUNNING", state: "" }),
    ]);
    expect(report.by_status).toEqual({ RUNNING: 2, DONE: 1, FAILED: 1 });
    // A finished worker's stale "idle" must not inflate the driver-state bucket.
    expect(report.by_state).toEqual({ "in-turn": 1, running: 1 });
  });

  it("serves the SAME row shape over HTTP as the fold produces", async () => {
    const h = makeHarness();
    try {
      await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "b", title: "T" }));
      const res = await getJson(h.app, "/api/worker/status");
      const rows = res.body["workers"] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ wid: "W1", sess: "session-1", status: "RUNNING" });
      expect(rows[0]).not.toHaveProperty("workspace");
      expect(rows[0]!.context).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it("the REAL adapter measures a seeded worker from its own session", () => {
    // The HTTP test above drives the FAKE adapter, so without this the real wiring
    // (which is the only one that can actually read a statusline) would be untested.
    const h = makeEngineHarness();
    try {
      h.runtime.ensureSession(null);
      const registry = engineOf(h).workersOf(null);
      expect(registry).not.toBeNull();
      const sid = registry!.sessions.create({ title: "W1·seeded" }).meta.id;
      registry!.upsert({ wid: "W1", started_at: "2026-01-01_00:00:00", status: "RUNNING", extra: "sess=" + sid + " state=idle" });
      const row = h.runtime.workerStatus().workers.find((w) => w.wid === "W1");
      expect(row).toBeDefined();
      expect(row!.sess).toBe(sid);
      // Measured from the engine, not fabricated: `method` says HOW it was measured.
      expect(row!.context).not.toBeNull();
      expect(typeof row!.context!.method).toBe("string");
    } finally {
      h.cleanup();
    }
  });
});
