/**
 * W870 — the statusline's model picker switches the FOCUSED SESSION's model.
 *
 * The bug (user report: 「点击切换模型后，若干秒模型又回到了切换前的状态」):
 * `apps/web/src/statusline.ts` polls `GET /api/status?session=<focus>` every 2s and
 * merges the answer unconditionally. That answer's `model` comes from the SESSION
 * INSTANCE's profile — global base profile + the session's own `session.json.model`
 * override (`session-compose.ts` `profileFor`) — while the W750 picker wrote ONLY the
 * global default (`POST /api/config`). For a session that declares an override the
 * optimistic badge was therefore bounced back to the override by the very next poll.
 *
 * The fix is the product semantic this file pins: the picker on a session's statusline
 * switches THAT session's model (`PUT /api/sessions/{id}/model`), and
 * `POST /api/config` keeps meaning 「the global default」.
 *
 * Level: the REAL adapter (`RealRuntimeAdapter` through `createStudioEngine`), over the
 * HTTP contract — the divergence lived exactly between the handler's write and the
 * adapter's `statusline(session)` reading. Never a re-derivation of `profileFor`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, waitIdle } from "./test-util.js";
import type { OfflineStep } from "./offline-llm.js";

/** The session-level override the reporter's two sessions actually carry (live 3777). */
const OVERRIDE = "glm-5.3-flash";
/** The model the user picks in the statusline. */
const PICKED = "deepseek-v9-pro";
/** The harness engine's BASE (global) model — `OFFLINE_PROFILE.model`. */
const BASE = "offline-model";

const FOCUSED = "sample-ws/focused";
const NEIGHBOUR = "sample-ws/neighbour";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** One process, three sessions: two with an override, one without. */
function engine(requested: string[] = [], script: OfflineStep[] = []): StudioHarness {
  const h = makeEngineHarness({
    sessions: { focused: [], neighbour: [], plain: [] },
    meta: {
      focused: { title: "甲会话", model: OVERRIDE, mode: "standard" },
      neighbour: { title: "乙会话", model: OVERRIDE },
    },
    llm: { script, onRequest: (req) => requested.push(req.model) },
  });
  harnesses.push(h);
  return h;
}

const modelPath = (id: string): string => "/api/sessions/" + encodeURIComponent(id) + "/model";

/** `GET /api/status?session=` — the value the statusline badge renders. */
async function statusModel(h: StudioHarness, id: string): Promise<string> {
  const res = await getJson(h.app, "/api/status?session=" + encodeURIComponent(id));
  expect(res.status).toBe(200);
  return String(res.body["model"]);
}

/** The session's `session.json` exactly as it is on disk. */
function metaOf(h: StudioHarness, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h.workspace, name, "session.json"), "utf8")) as Record<string, unknown>;
}

const switchModel = async (h: StudioHarness, id: string, model: string): Promise<Response> =>
  h.app.request(modelPath(id), jsonRequest("PUT", { model }));

describe("W870 · session-scoped model switch (the bounce-back bug)", () => {
  it("THE BUG: switching a session's model must survive the next status poll", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    expect(await statusModel(h, FOCUSED), "the session starts on its own override").toBe(OVERRIDE);

    const res = await switchModel(h, FOCUSED, PICKED);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["session"]).toBe(FOCUSED);
    expect(body["model"]).toBe(PICKED);

    // The write is the session's OWN meta (title/mode kept), never the global default.
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: PICKED, mode: "standard" });
    expect((await getJson(h.app, "/api/config")).body["model"], "the global default is untouched").toBe(BASE);

    // …and the next 2s poll reads the NEW value — this is the assertion that was red.
    expect(await statusModel(h, FOCUSED)).toBe(PICKED);
    // A second read (the 「若干秒后」 poll) still answers the new model.
    expect(await statusModel(h, FOCUSED)).toBe(PICKED);
  });

  it("the next turn of THAT session really runs on the switched model", async () => {
    const requested: string[] = [];
    const h = engine(requested, [{ text: "答" }]);
    await activate(h, FOCUSED);
    expect((await switchModel(h, FOCUSED, PICKED)).status).toBe(200);

    const turn = await h.app.request("/api/turn", jsonRequest("POST", { input: "用哪个模型", session: FOCUSED }));
    expect(turn.status).toBe(202);
    await waitIdle(h);
    expect(requested).toEqual([PICKED]);
  });

  it("model:\"\" clears the override and the session falls back to the global default", async () => {
    const requested: string[] = [];
    const h = engine(requested, [{ text: "答" }]);
    await activate(h, FOCUSED);

    const res = await switchModel(h, FOCUSED, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["model"]).toBe(BASE);
    expect(body["covered"]).toBe(false);
    // The KEY is gone; every other key survives (K8: absent = no override).
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", mode: "standard" });
    expect(await statusModel(h, FOCUSED)).toBe(BASE);

    await h.app.request("/api/turn", jsonRequest("POST", { input: "回落了吗", session: FOCUSED }));
    await waitIdle(h);
    expect(requested).toEqual([BASE]);
  });

  it("is session-scoped: the neighbour keeps its own override and model", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    await activate(h, NEIGHBOUR);
    await activate(h, "sample-ws/plain");

    expect((await switchModel(h, FOCUSED, PICKED)).status).toBe(200);
    expect(await statusModel(h, NEIGHBOUR)).toBe(OVERRIDE);
    expect(metaOf(h, "neighbour")["model"]).toBe(OVERRIDE);
    // A no-override session reads the global default before and after.
    expect(await statusModel(h, "sample-ws/plain")).toBe(BASE);
  });
});

describe("W870 · session model endpoint: guards", () => {
  it("409 while that session's turn is running (the W791 mode/compact semantics)", async () => {
    const h = engine([], [{ text: "x".repeat(4000) }]);
    await activate(h, FOCUSED);
    const slow = await h.app.request("/api/turn", jsonRequest("POST", { input: "慢", session: FOCUSED }));
    expect(slow.status).toBe(202);
    try {
      const res = await switchModel(h, FOCUSED, PICKED);
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as Record<string, unknown>)["error"])).toContain("turn 进行中");
      // Nothing was written: a refused switch must not half-apply.
      expect(metaOf(h, "focused")["model"]).toBe(OVERRIDE);
    } finally {
      h.runtime.cancel(FOCUSED);
      await waitIdle(h);
    }
  });

  it("422 for a non-string, 400 for an illegal name, 404 for an unknown session", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    const notString = await h.app.request(modelPath(FOCUSED), jsonRequest("PUT", { model: 7 }));
    expect(notString.status).toBe(422);
    const illegal = await switchModel(h, FOCUSED, "bad model!");
    expect(illegal.status).toBe(400);
    expect(String(((await illegal.json()) as Record<string, unknown>)["error"])).toContain("invalid model name");
    const missing = await switchModel(h, "sample-ws/ghost", PICKED);
    expect(missing.status).toBe(404);
    // Every refusal left the file exactly as it was.
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: OVERRIDE, mode: "standard" });
  });
});
