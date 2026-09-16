/**
 * B4 / W819-8 (R3): \`tool_extra\` is a RESERVED capability — no tool-exposure
 * point ever consumed it, so presenting it as grantable was a lie. The honest
 * downgrade (the plan's option (b)) stops OFFERING it while keeping stored
 * entries readable, echoed and warned about.
 *
 * Source: \`/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md\`
 * §B4 W819-8 — "选 (b)：GET /api/grants 与前端 grants 面板不再把 tool_extra
 * 列为可授（快照断言）".
 */

import { afterEach, describe, expect, it } from "vitest";
import { getJson, grant, grantToken, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];
const S1 = "sample-ws%2Fs1";
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function make(files?: Record<string, unknown>): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" }, ...(files === undefined ? {} : { files }) });
  harnesses.push(h);
  return h;
}

/** A stored tool_extra entry, as an older Studio would have written it. */
function storedToolExtra(): Record<string, unknown> {
  return {
    "sample-ws/s1/grants.json": {
      version: 1,
      session: "sample-ws/s1",
      updated_at: 1,
      grants: [
        {
          id: "g-seed",
          cap: "tool_extra",
          scope: { tools: ["browser"] },
          granted_at: 1,
          granted_by: "ui:operator",
          expires_at: null,
          uses_left: null,
          note: "",
        },
      ],
    },
  };
}

describe("B4/W819-8: tool_extra is no longer offered", () => {
  it("refuses a new tool_extra grant and its confirm token", async () => {
    const h = make();
    const hash = "0".repeat(64);
    const token = await getJson(h.app, "/api/sessions/" + S1 + "/grants/confirm-token?cap=tool_extra&scope_hash=" + hash, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(token.status).toBe(400);
    expect(token.body).toEqual({ ok: false, error: "invalid cap 'tool_extra'" });

    const post = await getJson(h.app, "/api/sessions/" + S1 + "/grants", jsonRequest("POST", { cap: "tool_extra", scope: { tools: ["browser"] } }));
    expect(post.status).toBe(400);
    expect(post.body).toEqual({ ok: false, error: "invalid cap 'tool_extra'" });

    // A still-supported cap is unaffected.
    const net = await getJson(h.app, "/api/sessions/" + S1 + "/grants/confirm-token?cap=network&scope_hash=" + hash, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(net.status).toBe(200);
    expect(typeof net.body["token"]).toBe("string");
  });

  it("still echoes a stored entry, warns it is ineffective and lets it be revoked", async () => {
    const h = make(storedToolExtra());
    const listed = await getJson(h.app, "/api/sessions/" + S1 + "/grants");
    expect(listed.status).toBe(200);
    expect((listed.body["effective"] as Record<string, unknown>)["tool_extra"]).toEqual(["browser"]);
    expect(String(listed.body["warnings"] ?? "")).toContain("tool_extra_ineffective");

    const revoked = await getJson(h.app, "/api/sessions/" + S1 + "/grants", jsonRequest("DELETE", { cap: "tool_extra" }));
    expect(revoked.status).toBe(200);
    expect(revoked.body["revoked"]).toEqual(["g-seed"]);
  });

  it("does not offer the cap through the normal grant helper either", async () => {
    const h = make();
    // grantToken returns "" when the token endpoint refuses the cap; the POST is
    // still rejected by cap validation before the token is even consulted.
    const stale = await grantToken(h, S1, "tool_extra", { tools: ["browser"] });
    expect(stale).toBe("");
    const out = await grant(h, S1, { cap: "tool_extra", scope: { tools: ["browser"] } }, stale);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ ok: false, error: "invalid cap 'tool_extra'" });
  });
});
