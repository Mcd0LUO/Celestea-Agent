/**
 * W1479 — the worker-table host probe must ask about EXISTENCE, not LOCATION.
 *
 * WHY THIS FILE EXISTS: the probe was wired as `sessions.resolve(sid).ok`, and
 * `resolve` only validates the id's shape and picks a candidate directory — it
 * answers ok for a session that was never written. So every host looked alive,
 * `orphans[]` could never fill, and a row whose host was gone was filed STALE
 * (action `respawn`) instead of an orphan. §2.2.4 row 6 says an orphan is NEVER
 * re-dispatched; a misclassification therefore points straight at that rule.
 *
 * WHY `w1470b` DID NOT CATCH IT: its orphan row names host `ws/gone`, an
 * UNKNOWN WORKSPACE, so `resolve` fails there too and the two lookups agree by
 * accident. The dangerous case is the opposite one — the workspace still exists
 * but the session directory is gone — and that is exactly what these cases pin.
 */

import { describe, expect, it } from "vitest";
import type { WorkerEntry } from "@celestea/core";
import { getJson, type StudioHarness } from "../harness.test-util.js";
import { makeEngineHarness, turns } from "./test-util.js";

/** The conversation the harness plants (`sample-ws/s1`). */
const HOST = "sample-ws/s1";
/** Its worker-session prefix (`workerSessionPrefix(HOST)`). */
const PREFIX = "sample-ws_s1-session-";

function row(wid: string, extra: string): WorkerEntry {
  return { wid, started_at: "2026-09-23_11:00:00Z", status: "RUNNING", extra };
}

function asTable(entries: readonly WorkerEntry[]): string {
  return entries.map((e) => e.wid + "\t" + e.started_at + "\t" + e.status + "\t" + e.extra).join("\n") + "\n";
}

/**
 * A row whose host workspace EXISTS but whose session directory does NOT.
 *
 * This is the case the location-shaped lookup got wrong: `resolve` returns ok
 * (the workspace is registered, the id is well formed), while `require` sees
 * that no directory holds the session log and says no.
 */
/** A host whose WORKSPACE is registered but whose session directory is gone. */
const DELETED_HOST = "sample-ws/deleted-session";
/** Its own worker-session prefix, so only the host probe can exclude the row. */
const DELETED_PREFIX = "sample-ws_deleted-session-session-";

function deletedSessionRow(): WorkerEntry {
  return row("W711", "sess=" + DELETED_PREFIX + "0 title=deleted host=" + DELETED_HOST + " attempt=0 lease=999999@1789000000 proc=999999");
}

function make(entries: readonly WorkerEntry[]): StudioHarness {
  return makeEngineHarness({
    sessions: { s1: turns(1) },
    rawFiles: { "worker-registry.tsv": asTable(entries) },
  });
}

describe("W1479: the host probe means EXISTENCE", () => {
  it("calls a row an ORPHAN when its host workspace exists but the session is gone", async () => {
    const h = make([deletedSessionRow()]);
    try {
      const body = (await getJson(h.app, "/api/worker/status")).body;
      // The host conversation is NOT on disk, so this row is an orphan ...
      expect((body["orphans"] as Array<Record<string, unknown>>).map((c) => c["wid"])).toEqual(["W711"]);
      // ... and §2.2.4 row 6 makes it an OBSERVE, never a re-dispatch.
      expect((body["stale"] as Array<Record<string, unknown>>).map((c) => c["wid"])).toEqual(["W711"]);
      const orphan = (body["orphans"] as Array<Record<string, unknown>>)[0]!;
      expect(orphan["reason"]).toBe("orphan_host");
      expect(orphan["action"]).toBe("observe");
    } finally {
      h.cleanup();
    }
  });

  it("keeps a row of a session that DOES exist out of orphans[]", async () => {
    // `sample-ws/s1` is planted by the harness, so its own ghost is inherited.
    const h = make([row("W712", "sess=" + PREFIX + "0 title=live host=" + HOST + " attempt=0 lease=999999@1789000000 proc=999999")]);
    try {
      const body = (await getJson(h.app, "/api/worker/status")).body;
      expect(body["orphans"]).toEqual([]);
      expect((body["inherited"] as Array<Record<string, unknown>>).map((r) => r["wid"])).toEqual(["W712"]);
    } finally {
      h.cleanup();
    }
  });
});
