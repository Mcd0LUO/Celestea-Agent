/**
 * Cross-package contract test (P4): every one of the 44 frozen endpoints is
 * bound to the contract method+path and is reachable — none of them falls
 * through to the static/SPA handler.
 *
 * The app runs against a throwaway data directory, so a probe can never touch a
 * production data file, and against the fake runtime adapter (the engine seam).
 */

import { describe, expect, it } from "vitest";
import { loadEndpoints, loadTools } from "@celestea/core";
import { API_ENDPOINT_COUNT, concretePath, toHonoPath } from "@celestea/studio";
import { makeHarness } from "../apps/studio/src/harness.test-util.js";

const harness = makeHarness({ session: { name: "sample-session", log: `${JSON.stringify({ type: "user_message", text: "hi" })}\n` } });
const { app } = harness;

describe("apps/studio contract surface", () => {
  it("binds the 44 contract endpoints exactly once each", () => {
    const contract = loadEndpoints().endpoints.map((e) => `${e.method} ${e.path}`);
    const bound = harness.studio.routes.map((r) => `${r.method} ${r.contractPath}`);
    expect(bound).toHaveLength(API_ENDPOINT_COUNT);
    expect(new Set(bound).size).toBe(API_ENDPOINT_COUNT);
    expect(bound.sort()).toEqual(contract.sort());
  });

  it("translates {param} to :param", () => {
    expect(toHonoPath("/api/sessions/{id}/messages")).toBe("/api/sessions/:id/messages");
    expect(toHonoPath("/api/health")).toBe("/api/health");
  });

  it("answers every endpoint without a 404 fallback", async () => {
    for (const e of loadEndpoints().endpoints) {
      if (e.id === "get_events") continue; // streaming; covered by apps/studio tests
      const url = concretePath(e.path) + (e.request.kind === "query" ? "?path=/tmp" : "");
      const res = await app.request(url, { method: e.method });
      if (res.status !== 404) continue;
      // A handler 404 is `{ok:false,error}`; the static/API fallback is the
      // bare `{error:"not found"}` — the two must never be confused.
      expect(await res.json(), `${e.method} ${e.path}`).toHaveProperty("ok", false);
    }
  });

  it("keeps the health / status / tools shapes frozen", async () => {
    const health = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    // W516/W725/W729: `capabilities.grants|context|session_mode = true` is how
    // the frontend knows the permission panel / context viewer / mode selector
    // exists at all (the Rust backend answered 404 on the first two).
    expect(Object.keys(health).sort()).toEqual(["base_url", "bind", "capabilities", "model", "name", "ok"]);
    expect(health["capabilities"]).toEqual({ grants: true, context: true, session_mode: true });
    const status = (await (await app.request("/api/status")).json()) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual([
      "busy",
      "context_usage",
      "grants_active",
      "mode",
      "model",
      "reasoning_effort",
      "session",
      "steps",
      "tokens_per_sec",
      "usage",
    ]);
    expect(status["mode"]).toBe("standard");
    const tools = (await (await app.request("/api/tools")).json()) as { tools: unknown[] };
    expect(Array.isArray(tools.tools)).toBe(true);
    expect(loadTools().tools).toHaveLength(10);
  });

  it("404s unknown /api/* paths with the JSON envelope (never the SPA)", async () => {
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("falls back to the SPA index for an unknown non-API route", async () => {
    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("studio");
  });
});
