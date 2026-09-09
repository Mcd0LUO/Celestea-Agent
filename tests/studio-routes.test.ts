import { describe, expect, it } from "vitest";
import { createStudioApp } from "@celestea/studio";
import { API_ENDPOINT_COUNT, concretePath, toHonoPath } from "@celestea/studio";
import { loadEndpoints, loadTools } from "@celestea/core";

describe("apps/studio Hono skeleton", () => {
  const { app, routes } = createStudioApp({ model: "test-model" });

  it("registers all 39 contract endpoints", () => {
    expect(routes).toHaveLength(API_ENDPOINT_COUNT);
  });

  it("translates {param} to :param", () => {
    expect(toHonoPath("/api/sessions/{id}/messages")).toBe("/api/sessions/:id/messages");
    expect(toHonoPath("/api/health")).toBe("/api/health");
  });

  it("answers every endpoint (none 404)", async () => {
    const contract = loadEndpoints();
    for (const e of contract.endpoints) {
      if (e.id === "get_events") continue; // streaming; covered separately
      const url = concretePath(e.path) + (e.request.kind === "query" ? "?path=/tmp" : "");
      const res = await app.request(url, { method: e.method });
      expect(res.status, `${e.method} ${e.path}`).not.toBe(404);
    }
  });

  it("implements GET /api/health with the frozen shape", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, name: "celestea-studio", model: "test-model", base_url: "http://127.0.0.1:3001/v1", bind: "127.0.0.1:3777" });
  });

  it("returns the frozen statusline shape from GET /api/status", async () => {
    const res = await app.request("/api/status");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["context_usage", "model", "reasoning_effort", "session", "steps", "tokens_per_sec", "usage"]);
  });

  it("serves /api/events as an SSE stream with the envelope", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: status");
    expect(chunk).toContain('"turn":0');
    expect(chunk).toContain('"seq":0');
    expect(chunk).toContain('"payload"');
    await reader!.cancel();
  });

  it("404s unknown /api/* paths with the JSON envelope", async () => {
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("keeps the tool registry at 10 tools", () => {
    expect(loadTools().tools).toHaveLength(10);
  });
});
