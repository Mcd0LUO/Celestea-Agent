/**
 * W1470b — the PREVIOUS generation must be visible in the ENDPOINTS and the PANEL,
 * not only in the tool face.
 *
 * W1470 made the tool face address a restart worker again (resolve + inherited),
 * but `GET /api/worker/status.workers[]` and `GET /api/sessions` were built from
 * `ownEntries()` (the `proc=` filter), so a user looking at the panel still saw
 * nothing after a restart. These cases pin the three properties of the fix:
 *
 *   1. the inherited rows ARE reported (`inherited: true`, with their session),
 *   2. the COUNTS do not move (`total` / `by_status` / `by_state` stay "this
 *      generation"),
 *   3. a row is never listed twice, and never for a conversation this studio no
 *      longer has (that is P0 orphans).
 */

import { describe, expect, it } from "vitest";
import type { WorkerEntry } from "@celestea/core";
import { getJson, type StudioHarness } from "../harness.test-util.js";
import { inheritedRowsOf } from "./worker-table.js";
import { activate, engineOf, makeEngineHarness, turns } from "./test-util.js";

/** The conversation the harness plants (`sample-ws/s1`). */
const HOST = "sample-ws/s1";
/** Its worker-session prefix (`workerSessionPrefix(HOST)`). */
const PREFIX = "sample-ws_s1-session-";

function row(wid: string, extra: string): WorkerEntry {
  return { wid, started_at: "2026-09-23_11:00:00Z", status: "RUNNING", extra };
}

/** A ghost of a DEAD process, for a session this studio still has. */
function ghost(): WorkerEntry {
  return row("W701", `sess=${PREFIX}0 title=ghost host=${HOST} attempt=0 lease=999999@1789000000 proc=999999`);
}

/** The table every endpoint case uses: one ghost plus three look-alikes. */
function table(): string {
  return [
    ghost(),
    // A session this studio does NOT have: P0 orphan territory, never a panel row.
    // Its `sess` DOES match its own host prefix (`workerSessionPrefix("ws/gone")`),
    // so the ONLY rule that can exclude it is the knownHost one — otherwise the
    // prefix check would mask that guard and the case would assert nothing.
    row("W702", "sess=ws_gone-session-0 title=x host=ws/gone attempt=0 lease=999998@1789000000 proc=999998"),
    // a SIBLING conversation that sanitizes onto our prefix: not ours to adopt
    row("W704", `sess=other-session-0 title=sib host=${HOST} attempt=0 lease=999997@1789000000 proc=999997`),
  ].map((e) => `${e.wid}\t${e.started_at}\t${e.status}\t${e.extra}`).join("\n") + "\n";
}

function make(): StudioHarness {
  return makeEngineHarness({ sessions: { s1: turns(1) }, rawFiles: { "worker-registry.tsv": table() } });
}

describe("W1470b: inheritedRowsOf — the pure rule", () => {
  const entries = [ghost(), row("W703", `sess=${PREFIX}1 host=${HOST} proc=${process.pid}`)];
  const base = { ownWids: [] as string[], pid: process.pid, knownHost: (sid: string) => sid === HOST };

  it("takes a dead generation row of a session we still have", () => {
    expect(inheritedRowsOf(entries, base).map((e) => e.wid)).toEqual(["W701"]);
  });

  it("never lists a row a LIVE instance owns (no duplicates) or one of ours", () => {
    expect(inheritedRowsOf(entries, { ...base, ownWids: ["W701"] }).map((e) => e.wid)).toEqual([]);
    expect(inheritedRowsOf([entries[1] as WorkerEntry], base)).toEqual([]);
  });

  it("never guesses without evidence: no knownHost, no inherited rows", () => {
    const { knownHost, ...blind } = base;
    void knownHost;
    expect(inheritedRowsOf(entries, blind)).toEqual([]);
  });

  it("skips an unknown host, a missing sess and a foreign prefix", () => {
    const rows = [
      row("W9", "sess=ws_gone-session-0 host=ws/gone proc=999999"),
      row("W8", `host=${HOST} proc=999999`),
      row("W7", `sess=other-session-0 host=${HOST} proc=999999`),
    ];
    expect(inheritedRowsOf(rows, base)).toEqual([]);
  });
});

describe("W1470b: GET /api/worker/status reports the previous generation", () => {
  it("lists it under inherited[] with the marker, and does NOT move the counts", async () => {
    const h = make();
    try {
      const status = await getJson(h.app, "/api/worker/status");
      const body = status.body;
      // ① reported, with the same marker the tool face uses
      const inherited = body["inherited"] as Array<Record<string, unknown>>;
      expect(inherited.map((r) => [r["wid"], r["inherited"], r["sess"], r["host_session"]])).toEqual([
        ["W701", true, `${PREFIX}0`, HOST],
      ]);
      // ② the counting basis is untouched: no live worker exists in this process
      expect(body["total"]).toBe(0);
      expect(body["by_status"]).toEqual({});
      expect(body["by_state"]).toEqual({});
      expect(body["workers"]).toEqual([]);
      // ③ the P0 judgement is unchanged: it judges EVERY dead-owner row of the
      // table (including the ones the panel must not adopt), and reports them.
      expect((body["stale"] as Array<Record<string, unknown>>).map((c) => c["wid"])).toEqual(["W701", "W702", "W704"]);
      expect((body["orphans"] as Array<Record<string, unknown>>).map((c) => c["wid"])).toEqual(["W702"]);
    } finally {
      h.cleanup();
    }
  });

  it("answers a wid lookup for a ghost instead of claiming it does not exist", async () => {
    const h = make();
    try {
      const hit = await getJson(h.app, "/api/worker/status?wid=W701");
      expect(hit.body["ok"]).toBe(true);
      expect(hit.body["total"]).toBe(0);
      expect(hit.body["workers"]).toEqual([]);
      expect((hit.body["inherited"] as Array<Record<string, unknown>>).map((r) => r["wid"])).toEqual(["W701"]);
      // A wid nobody knows is still the old not-found answer.
      const miss = await getJson(h.app, "/api/worker/status?wid=W999");
      expect(miss.body["ok"]).toBe(false);
      expect(miss.body["error"]).toBe("no worker W999 in registry");
    } finally {
      h.cleanup();
    }
  });

  it("a worker spawned by THIS process stays out of inherited[]", async () => {
    const h = make();
    try {
      await activate(h, HOST);
      const spawn = await getJson(h.app, "/api/worker/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wid: "W710", brief: "b", title: "T", session: HOST }),
      });
      expect(spawn.status).toBe(200);
      const body = (await getJson(h.app, "/api/worker/status")).body;
      expect(body["total"]).toBe(1);
      expect((body["workers"] as Array<Record<string, unknown>>).map((r) => r["wid"])).toEqual(["W710"]);
      // The ghost is still the only inherited row: the live one is not listed twice.
      expect((body["inherited"] as Array<Record<string, unknown>>).map((r) => r["wid"])).toEqual(["W701"]);
      void engineOf(h);
    } finally {
      h.cleanup();
    }
  });
});

describe("W1470b: GET /api/sessions carries the previous generation into the panel", () => {
  it("lists the ghost as a worker row bound to its session", async () => {
    const h = make();
    try {
      const list = await getJson(h.app, "/api/sessions");
      const rows = list.body["sessions"] as Array<Record<string, unknown>>;
      const ghostRow = rows.find((r) => r["wid"] === "W701");
      expect(ghostRow).toMatchObject({
        kind: "worker",
        inherited: true,
        status: "RUNNING",
        host_session: HOST,
        parentSessionId: HOST,
        sess: `${PREFIX}0`,
        id: `worker:${PREFIX}0`,
        workspace: "engine",
      });
      // The orphan row (unknown host) and the foreign-prefix row stay OUT of the panel.
      expect(rows.some((r) => r["wid"] === "W702")).toBe(false);
      expect(rows.some((r) => r["wid"] === "W704")).toBe(false);
      // The session itself is still listed normally.
      expect(rows.some((r) => r["id"] === HOST && r["kind"] === "session")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
