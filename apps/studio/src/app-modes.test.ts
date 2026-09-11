/**
 * W729 (P0) — the HTTP surface of session modes.
 *
 * The P0 mode contract is deliberately small: a session carries a mode fixed at
 * creation (`POST /api/sessions.mode`), every read surface reports it
 * (`GET /api/sessions` rows, `GET /api/status`) and `/api/health` advertises the
 * capability. There is NO switch endpoint in P0 (D6: `API_ENDPOINT_COUNT` stays
 * 44), and no tool-face difference between the modes (D5/§1.2).
 *
 * These cases live in their own module because `app-domains.test.ts` is at its
 * K3 size cap (400 non-blank non-comment lines); the domain file keeps the one
 * assertion that belongs to an existing case (worker rows carry a mode).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];

function make(): StudioHarness {
  const h = makeHarness({
    session: { name: "s1", log: `${JSON.stringify({ type: "turn_start", id: "turn-1" })}\n` },
  });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("W729 session mode endpoint surface (P0)", () => {
  it("W729 M1/M2/M3: creates with a mode, rejects an unknown one, defaults to standard", async () => {
    const h = make();
    // M1: an explicit execution session lands on disk and in the list row.
    const exec = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "exec", mode: "execution" }));
    expect(exec.status).toBe(200);
    expect(readFileSync(join(h.workspace, "exec-1700000000.0", "session.json"), "utf8")).toBe('{\n  "mode": "execution"\n}\n');
    const rows = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r["id"] === "sample-ws/exec-1700000000.0")).toMatchObject({ mode: "execution" });
    expect((await getJson(h.app, "/api/status?session=sample-ws%2Fexec-1700000000.0")).body["mode"]).toBe("execution");

    // M2: the frozen 400 text, and nothing was created.
    const bad = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "fast", mode: "fast" }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: "invalid mode: fast" });
    expect(existsSync(join(h.workspace, "fast-1700000000.0"))).toBe(false);

    // M3: without a mode the session is standard and session.json is NOT written
    // (no new key, no new file) — byte-for-byte the pre-W729 behaviour.
    const plain = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "plain" }));
    expect(plain.status).toBe(200);
    expect(existsSync(join(h.workspace, "plain-1700000000.0", "session.json"))).toBe(false);
    const after = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    expect(after.find((r) => r["id"] === "sample-ws/plain-1700000000.0")).toMatchObject({ mode: "standard" });
    expect((await getJson(h.app, "/api/status?session=sample-ws%2Fplain-1700000000.0")).body["mode"]).toBe("standard");
    expect((await getJson(h.app, "/api/health")).body["capabilities"]).toMatchObject({ session_mode: true });
  });


  it("reports the mode of every row and the queried session (workers included)", async () => {
    const h = make();
    await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "exec", mode: "execution" }));
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "x", title: "T" }));
    expect(spawn.body["ok"]).toBe(true);

    const rows = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [String(r["id"]), r]));
    expect(byId.get("sample-ws/exec-1700000000.0")).toMatchObject({ mode: "execution" });
    expect(byId.get("sample-ws/s1")).toMatchObject({ mode: "standard" });
    expect(byId.get("worker:session-1")).toMatchObject({ kind: "worker", mode: "standard" });
    // Every row carries the key: a client can read `mode` without a fallback.
    for (const row of rows) expect(typeof row["mode"], String(row["id"])).toBe("string");
  });
});
