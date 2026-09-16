/**
 * W833 (R3 B7 / W816 F3) — POST /api/worker/spawn with an unknown session.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B7 W816 F3: real HTTP POST with a session that does not resolve must answer
 * 404 and compose NO ghost instance / worker row; a legal session still 200s.
 *
 * The fix point is the HANDLER (the adapter is deliberately untouched), so this
 * drives the real Hono app over the real engine adapter.
 */

import { afterEach, describe, expect, it } from "vitest";

import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness } from "./test-util.js";

const harnesses: StudioHarness[] = [];

function make(): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: [] } });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("W833 B7/F3: worker spawn session must resolve", () => {
  it("404s an unknown session and composes no ghost instance or worker row", async () => {
    const h = make();
    const ghost = "sample-ws/ghost";
    const res = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W9", brief: "b", session: ghost }));
    expect(res.status).toBe(404);
    expect(String(res.body["error"])).toContain("unknown session");
    expect(engineOf(h).liveSessions()).not.toContain(ghost);
    expect(engineOf(h).workerSessions().some((row) => row.wid === "W9")).toBe(false);
  });

  it("still accepts a resolvable session", async () => {
    const h = make();
    await activate(h, "sample-ws/s1");
    const res = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W10", brief: "b", session: "sample-ws/s1" }));
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
  });

  it("still accepts an omitted session (the detached default)", async () => {
    const h = make();
    const res = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W11", brief: "b" }));
    expect(res.status).toBe(200);
  });
});
