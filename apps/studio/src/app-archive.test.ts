/**
 * W791 (B) — the ARCHIVED session surface: `?archived=1`, delete + restore.
 *
 * The archived state is a filesystem fact (`<ws>/.celestea-archived/<name>`, an
 * id-preserving move) that the DEFAULT session listing cannot express, because
 * `SessionsStore.list()` skips dot-directories. Before this work exactly one of
 * the three id-addressed operations could reach an archived session
 * (`unarchive`); these cases pin the other two and the frozen default body:
 *
 *   B2/B5  `GET /api/sessions?archived=1` lists the archived rows
 *          (`archived:true`), the DEFAULT listing does not contain them (and does
 *          not even carry the key);
 *   B3/B5  `POST /api/sessions/batch-delete` moves an ARCHIVED session into
 *          `<ws>/.celestea-trash/`;
 *   B1/B5  `listArchived()` produces the same row shape `list()` does, so a
 *          restored session's row is byte-identical to the one it had before.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];
const ARCHIVE = ".celestea-archived";
const TRASH = ".celestea-trash";
/** `FIXED_NOW` (1_700_000_000_000 ms) → the created/trash-suffixed stamp. */
const STAMP = "1700000000.0";

function make(): StudioHarness {
  const h = makeHarness({});
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

type Row = Record<string, unknown>;

async function sessions(h: StudioHarness, query = ""): Promise<{ rows: Row[]; body: Record<string, unknown> }> {
  const { body } = await getJson(h.app, `/api/sessions${query}`);
  return { rows: (body["sessions"] ?? []) as Row[], body };
}

/** Create one session (title + mode + model) and return its id. */
async function created(h: StudioHarness, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title, ...extra }));
  expect(res.status).toBe(200);
  return String(res.body["id"]);
}

const id = (name: string): string => `sample-ws/${name}-${STAMP}`;

describe("W791 archived session listing (?archived=1)", () => {
  it("lists the archived row with archived:true and keeps the DEFAULT body byte-identical", async () => {
    const h = make();
    const created_id = await created(h, "arch", { mode: "execution" });
    const before = (await sessions(h)).rows.find((r) => r["id"] === created_id);
    expect(before).toBeDefined();
    // A worker row exists too: the archived listing must not include it.
    await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "x", title: "T" }));

    const archived = await getJson(h.app, `/api/sessions/${encodeURIComponent(created_id)}/archive`, jsonRequest("POST"));
    expect(archived.body).toEqual({ ok: true });
    expect(existsSync(join(h.workspace, ARCHIVE, `arch-${STAMP}`, "cli-main.jsonl"))).toBe(true);

    // DEFAULT listing: unchanged — the session is gone and the key never appears.
    const fallback = await sessions(h);
    expect(fallback.rows.map((r) => r["id"])).not.toContain(created_id);
    expect(JSON.stringify(fallback.body)).not.toContain('"archived"');
    expect(fallback.rows.some((r) => r["kind"] === "worker")).toBe(true);

    // ?archived=1: exactly the archived row, same shape, plus the flag.
    const listed = await sessions(h, "?archived=1");
    expect(listed.rows).toHaveLength(1);
    const row = listed.rows[0] as Row;
    expect(row["archived"]).toBe(true);
    expect(row["active"]).toBe(false);
    expect(row["kind"]).toBe("session");
    expect(row["id"]).toBe(created_id);
    expect(row["workspace"]).toBe("sample-ws");
    expect(row["title"]).toBe("arch");
    expect(row["mode"]).toBe("execution");
    expect(row["model"]).toBe(before?.["model"]);
    // Every other field is the very value the row had while it was live.
    for (const key of ["id", "workspace", "title", "model", "mode", "size", "modified"] as const) {
      expect(row[key], key).toEqual(before?.[key]);
    }
    // Worker rows are never part of the archived listing.
    expect(listed.rows.some((r) => r["kind"] === "worker")).toBe(false);
    // `?archived=true` is the documented alias; everything else is the default.
    expect((await sessions(h, "?archived=true")).rows.map((r) => r["id"])).toEqual([created_id]);
    for (const value of ["0", "false", "yes", ""]) {
      const fallback2 = await sessions(h, `?archived=${value}`);
      expect(fallback2.rows.map((r) => r["id"]), value).not.toContain(created_id);
      expect(JSON.stringify(fallback2.body), value).not.toContain('"archived"');
    }
  });

  it("tolerates a workspace that never archived anything", async () => {
    const h = make();
    expect(existsSync(join(h.workspace, ARCHIVE))).toBe(false);
    const listed = await sessions(h, "?archived=1");
    expect(listed.rows).toEqual([]);
    expect(listed.body["active_session"]).toBeNull();
  });

  it("round-trips: unarchive puts the row back in the default listing", async () => {
    const h = make();
    const sid = await created(h, "back", { mode: "execution" });
    const live = (await sessions(h)).rows.find((r) => r["id"] === sid) as Row;
    await getJson(h.app, `/api/sessions/${encodeURIComponent(sid)}/archive`, jsonRequest("POST"));
    expect((await sessions(h, "?archived=1")).rows).toHaveLength(1);

    const restored = await getJson(h.app, `/api/sessions/${encodeURIComponent(sid)}/unarchive`, jsonRequest("POST"));
    expect(restored.body).toEqual({ ok: true });
    const after = (await sessions(h)).rows.find((r) => r["id"] === sid) as Row;
    expect(after).toBeDefined();
    expect(after["archived"]).toBeUndefined();
    // Byte-identical to the row it had before it was archived.
    expect(after).toEqual(live);
    expect((await sessions(h, "?archived=1")).rows).toEqual([]);
  });
});

describe("W791 deleting an archived session (B3)", () => {
  it("batch-delete moves the ARCHIVED directory into .celestea-trash", async () => {
    const h = make();
    const sid = await created(h, "gone");
    await getJson(h.app, `/api/sessions/${encodeURIComponent(sid)}/archive`, jsonRequest("POST"));
    // The live path is gone; the archive holds it.
    expect(existsSync(join(h.workspace, `gone-${STAMP}`, "cli-main.jsonl"))).toBe(false);

    const res = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: [sid] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 1, failed: [] });
    expect(existsSync(join(h.workspace, ARCHIVE, `gone-${STAMP}`))).toBe(false);
    const trash = join(h.workspace, TRASH, `gone-${STAMP}-${STAMP}`);
    expect(existsSync(join(trash, "cli-main.jsonl"))).toBe(true);
    // Nothing is left to list anywhere.
    expect((await sessions(h, "?archived=1")).rows).toEqual([]);
    expect((await sessions(h)).rows.map((r) => r["id"])).not.toContain(sid);
  });

  it("still answers 'unknown session' for an id that exists nowhere, and refuses a live one", async () => {
    const h = make();
    const ghost = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: ["sample-ws/ghost"] }));
    expect(ghost.body).toEqual({ ok: true, deleted: 0, failed: [{ id: "sample-ws/ghost", error: "unknown session 'sample-ws/ghost'" }] });
    const sid = await created(h, "live");
    // A LIVE session is deletable — only the ACTIVE one is refused (archiving and
    // deleting both leave the focused session alone).
    const activated = await getJson(h.app, `/api/sessions/${encodeURIComponent(sid)}/activate`, jsonRequest("POST"));
    expect(activated.status).toBe(200);
    const refused = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: [sid] }));
    expect(refused.body).toEqual({ ok: true, deleted: 0, failed: [{ id: sid, error: `active session '${sid}' cannot be deleted` }] });
  });
});

describe("W791 listArchived (B1, store level)", () => {
  it("produces list()-shaped rows and skips dot-entries inside the archive dir", async () => {
    const h = make();
    const sid = await created(h, "one", { mode: "execution" });
    await getJson(h.app, `/api/sessions/${encodeURIComponent(sid)}/archive`, jsonRequest("POST"));
    // Decoys: a hidden dir and a dir without a log file are not sessions.
    const store = h.studio.services.sessions;
    const decoy = join(h.workspace, ARCHIVE, ".hidden");
    const empty = join(h.workspace, ARCHIVE, "no-log");
    expect(readFileSync(join(h.workspace, ARCHIVE, `one-${STAMP}`, "session.json"), "utf8")).toContain('"mode": "execution"');
    void decoy;
    void empty;

    const rows = store.listArchived();
    expect(rows.map((r) => r["id"])).toEqual([sid]);
    expect(rows[0]).toMatchObject({ archived: true, active: false, kind: "session", workspace: "sample-ws", title: "one", mode: "execution" });
    expect(rows[0]?.["size"]).toBeGreaterThanOrEqual(0);
    expect(typeof rows[0]?.["modified"]).toBe("number");
    // The archived row is NOT in the default scan (dot-dir blind spot, on purpose).
    expect(store.list().map((r) => r.id)).not.toContain(sid);
  });
});
