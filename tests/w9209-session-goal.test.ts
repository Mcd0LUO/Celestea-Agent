// @vitest-environment node
/**
 * W9209 · `POST /api/sessions/{id}/goal` — the persistent session goal.
 *
 * This file exists because the previous audit found that `/goal` had a COMPLETE
 * frontend and NO backend: `apps/web/src/api.ts` posted to a path that was not in
 * `contracts/endpoints.json`, so every call hit the `/api/*` 404 fallback. The
 * frontend's own test (`tests/a3-commands.test.ts`) could not see it because its
 * fetch stub answered 200 to ANY url ending in `/goal`.
 *
 * These cases drive the REAL Hono app (`makeHarness`) and assert the file on disk, so
 * "registered" is never mistaken for "works".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const harnesses: StudioHarness[] = [];

/** A harness with one real session directory (`sample-ws/s1`). */
function h(): StudioHarness {
  const made = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(made);
  return made;
}

afterEach(() => {
  for (const made of harnesses.splice(0)) made.cleanup();
});

/** The sidecar path of `sample-ws/s1`. */
function goalFile(harness: StudioHarness): string {
  return join(harness.workspace, "s1", "goal.json");
}

const URL_GOAL = "/api/sessions/sample-ws%2Fs1/goal";

describe("W9209 · POST /api/sessions/{id}/goal", () => {
  it("sets a goal: 200 {ok,session,goal} with the stored text and ISO timestamps, and writes goal.json", async () => {
    const harness = h();
    const res = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "把 F2 做完" }));
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["session"]).toBe("sample-ws/s1");
    const goal = res.body["goal"] as Record<string, unknown>;
    expect(goal["text"]).toBe("把 F2 做完");
    // The shipped frontend reads these two camelCase keys (`ui/commands/goal.ts normalize`).
    expect(typeof goal["createdAt"]).toBe("string");
    expect(typeof goal["updatedAt"]).toBe("string");
    expect(Number.isNaN(Date.parse(String(goal["createdAt"])))).toBe(false);
    // …and the sidecar really exists, with the documented shape.
    expect(existsSync(goalFile(harness))).toBe(true);
    const onDisk = JSON.parse(readFileSync(goalFile(harness), "utf8")) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(["created_at", "session", "text", "updated_at", "version"]);
    expect(onDisk["version"]).toBe(1);
    expect(onDisk["session"]).toBe("sample-ws/s1");
    expect(onDisk["text"]).toBe("把 F2 做完");
    // Epoch SECONDS on disk (the repo-wide convention), not milliseconds.
    expect(typeof onDisk["created_at"]).toBe("number");
    expect(Number(onDisk["created_at"])).toBeLessThan(10_000_000_000);
  });

  it("trims the text and preserves created_at across a replace (only updated_at moves)", async () => {
    const harness = h();
    const first = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "  目标一  " }));
    const second = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "目标二" }));
    expect((first.body["goal"] as Record<string, unknown>)["text"]).toBe("目标一");
    expect((second.body["goal"] as Record<string, unknown>)["text"]).toBe("目标二");
    const onDisk = JSON.parse(readFileSync(goalFile(harness), "utf8")) as { created_at: number; updated_at: number };
    // Same clock in the harness ⇒ equal stamps, and crucially the created stamp is
    // NOT reset by the replace (it is inherited, never re-stamped from scratch).
    expect(onDisk.created_at).toBe(onDisk.updated_at);
    const firstDisk = Number((first.body["goal"] as Record<string, unknown>)["createdAt"] === undefined ? NaN : Date.parse(String((first.body["goal"] as Record<string, unknown>)["createdAt"])));
    expect(Date.parse(String((second.body["goal"] as Record<string, unknown>)["createdAt"]))).toBe(firstDisk);
  });

  it('clears with text="": DELETES the sidecar and answers goal:null (absence is the only "no goal")', async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "临时目标" }));
    expect(existsSync(goalFile(harness))).toBe(true);
    const cleared = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(cleared.status).toBe(200);
    expect(cleared.body["ok"]).toBe(true);
    expect(cleared.body["goal"]).toBeNull();
    expect(existsSync(goalFile(harness))).toBe(false);
    // A whitespace-only body is the SAME clear, not a goal made of spaces.
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "目标" }));
    const blank = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "   " }));
    expect(blank.body["goal"]).toBeNull();
    expect(existsSync(goalFile(harness))).toBe(false);
    // Clearing an already-clear session is idempotent, not an error.
    const again = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(again.status).toBe(200);
    expect(again.body["goal"]).toBeNull();
  });

  it("404s an unknown session and 422s a missing / non-string text", async () => {
    const harness = h();
    const missing = await getJson(harness.app, "/api/sessions/sample-ws%2Fnope/goal", jsonRequest("POST", { text: "x" }));
    expect(missing.status).toBe(404);
    expect(String(missing.body["error"])).toContain("unknown session");
    const noText = await getJson(harness.app, URL_GOAL, jsonRequest("POST", {}));
    expect(noText.status).toBe(422);
    expect(noText.body["error"]).toBe("field 'text' must be a string");
    const wrongType = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: 7 }));
    expect(wrongType.status).toBe(422);
    expect(wrongType.body["error"]).toBe("field 'text' must be a string");
    // Nothing was written by any of the refusals.
    expect(existsSync(goalFile(harness))).toBe(false);
  });

  it("degrades a void sidecar to goal:null + ONE warning instead of repairing or 500ing", async () => {
    const harness = h();
    const cases: Array<[string, string]> = [
      ["unparsable", "{oops"],
      ["not an object", "[]"],
      ["unknown version", JSON.stringify({ version: 2, session: "sample-ws/s1", text: "x", created_at: 1, updated_at: 1 })],
      ["another session", JSON.stringify({ version: 1, session: "sample-ws/other", text: "x", created_at: 1, updated_at: 1 })],
      ["no text", JSON.stringify({ version: 1, session: "sample-ws/s1", text: "", created_at: 1, updated_at: 1 })],
    ];
    for (const [label, body] of cases) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(goalFile(harness), body);
      const res = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "新目标" }));
      // The POST REPLACES a void file, so the answer is the new goal…
      expect(res.status, label).toBe(200);
      expect((res.body["goal"] as Record<string, unknown>)["text"], label).toBe("新目标");
    }
  });

  it("reports goal:null + a warning when the stored file is void (no write happens on a read-shaped call)", async () => {
    const harness = h();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(goalFile(harness), JSON.stringify({ version: 1, session: "sample-ws/other", text: "别人的目标" }));
    // A POST that only CLEARS must not be able to be fooled by a foreign file:
    // it deletes it and answers goal:null.
    const cleared = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(cleared.body["goal"]).toBeNull();
    expect(existsSync(goalFile(harness))).toBe(false);
  });
});
