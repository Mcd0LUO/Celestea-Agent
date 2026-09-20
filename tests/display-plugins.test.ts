/**
 * W895-C1 — the display-component enabled table over HTTP.
 *
 *   GET /api/display-plugins -> {ok:true, disabled:[...]}
 *   PUT /api/display-plugins   body {disabled:[...]}
 *
 * The server is the source of truth; the payload mirrors the retired
 * localStorage value (a disabled-id array). These cases pin read/write, the
 * fail-safe default, the 422 validation, and that concurrent writes never
 * corrupt or partially lose the file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const GET = "/api/display-plugins";

function make(): StudioHarness {
  return makeHarness();
}

function readFile(h: StudioHarness): { version: number; disabled: string[] } {
  return JSON.parse(readFileSync(join(h.root, "display-plugins.json"), "utf8")) as { version: number; disabled: string[] };
}

describe("W895-C1 /api/display-plugins", () => {
  it("GET with no file answers the empty disabled list (all ON)", async () => {
    const h = make();
    try {
      const res = await getJson(h.app, GET);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, disabled: [] });
    } finally {
      h.cleanup();
    }
  });

  it("PUT replaces the list and GET reads it back (normalized)", async () => {
    const h = make();
    try {
      const put = await getJson(h.app, GET, jsonRequest("PUT", { disabled: ["  hint-text-card ", "hint-text-card", "rail-preview"] }));
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ ok: true, disabled: ["hint-text-card", "rail-preview"] });
      expect(readFile(h).disabled).toEqual(["hint-text-card", "rail-preview"]);

      const get = await getJson(h.app, GET);
      expect(get.body).toEqual({ ok: true, disabled: ["hint-text-card", "rail-preview"] });

      // A second PUT is a full replace, not a merge.
      const cleared = await getJson(h.app, GET, jsonRequest("PUT", { disabled: [] }));
      expect(cleared.body).toEqual({ ok: true, disabled: [] });
    } finally {
      h.cleanup();
    }
  });

  it("422s a non-array / non-string / blank entry without touching the file", async () => {
    const h = make();
    try {
      await getJson(h.app, GET, jsonRequest("PUT", { disabled: ["rail-preview"] }));
      for (const disabled of ["x", [1, 2], ["ok", 3], [""], ["  "]]) {
        const res = await getJson(h.app, GET, jsonRequest("PUT", { disabled }));
        expect(res.status, JSON.stringify(disabled)).toBe(422);
      }
      expect(readFile(h).disabled).toEqual(["rail-preview"]);
    } finally {
      h.cleanup();
    }
  });

  it("a corrupt file degrades to all-ON on GET and is replaced on the next PUT", async () => {
    const h = make();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(h.root, "display-plugins.json"), "{ not json", "utf8");
      const res = await getJson(h.app, GET);
      expect(res.body["disabled"]).toEqual([]);
      expect(Array.isArray(res.body["warnings"])).toBe(true);
      const put = await getJson(h.app, GET, jsonRequest("PUT", { disabled: ["hint-text-card"] }));
      expect(put.status).toBe(200);
      expect(readFile(h).disabled).toEqual(["hint-text-card"]);
    } finally {
      h.cleanup();
    }
  });

  it("concurrent PUTs never corrupt or partially lose the file", async () => {
    const h = make();
    try {
      const lists = [["alpha"], ["beta"], ["gamma"]];
      const results = await Promise.all(lists.map((disabled) => getJson(h.app, GET, jsonRequest("PUT", { disabled }))));
      for (const res of results) expect(res.status).toBe(200);
      const after = await getJson(h.app, GET);
      // The final state is EXACTLY one submitted full list (atomic replace).
      expect(lists).toContainEqual(after.body["disabled"]);
      expect(readFile(h).disabled).toEqual(after.body["disabled"]);
    } finally {
      h.cleanup();
    }
  });
});
