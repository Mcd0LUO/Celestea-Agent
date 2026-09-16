/**
 * W815 (R3 batch B1): studio hot-apply side-effect ORDER and rollback.
 *
 * Every case drives the REAL Hono handler (`app.request` via `makeHarness`),
 * never a bare store/helper: the batch is about the request's effect order, which
 * only the composed app can show.
 * Source: /server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 * (B1 · W815-1/3/4/6/7 + N2 acceptance probes).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { EngineError, type ProfilePatch, type RuntimeAdapter } from "./runtime-adapter.js";
import { busyRuntime, getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { baseUrlOf } from "./handlers/config-shape.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeHarness>[0] = {}): StudioHarness {
  const h = makeHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The fake adapter with a scripted `configure` (the engine seam B1 controls). */
function fakeWithConfigure(configure: (base: RuntimeAdapter, patch: ProfilePatch) => Promise<unknown>): RuntimeAdapter {
  const base = createFakeRuntimeAdapter({ profile: { model: "test-model" } });
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "configure") return (patch: ProfilePatch) => configure(target as RuntimeAdapter, patch);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as RuntimeAdapter;
}

/** 1x1 PNG (valid magic + header) so the attachment store WOULD really write. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("W815-1 prompts hot apply rollback (B1)", () => {
  it("a failed first upsert leaves neither a file nor a registry row", async () => {
    let fail = true;
    const h = make({
      runtime: fakeWithConfigure(async () => {
        if (fail) throw new EngineError("boom");
        return undefined;
      }),
    });
    const rejected = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1" }));
    expect(rejected.status).toBe(500);
    expect(String(rejected.body["error"])).toContain("compose failed: boom");
    expect(existsSync(join(h.root, "prompts.json"))).toBe(false);
    expect((await getJson(h.app, "/api/prompts")).body["prompts"]).toEqual([]);

    // 放开 configure：the same write now lands and file/list agree.
    fail = false;
    const accepted = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1" }));
    expect(accepted.status).toBe(200);
    expect((await getJson(h.app, "/api/prompts")).body["prompts"]).toMatchObject([{ id: "p-1" }]);
    expect(readFileSync(join(h.root, "prompts.json"), "utf8")).toContain("p-1");
  });
});

describe("W815-3 config base_url override ordering (B1)", () => {
  it("a later numeric 400 never applies the base_url override", async () => {
    const h = make();
    const before = baseUrlOf(h.studio.services);
    const res = await getJson(
      h.app,
      "/api/config",
      jsonRequest("POST", { base_url: "http://evil.invalid/v1", max_output_tokens: 4_294_967_296 }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "max_output_tokens must be <= u32::MAX" });
    expect(baseUrlOf(h.studio.services)).toBe(before);
    expect(h.runtime.profile().base_url).not.toBe("http://evil.invalid/v1");
    expect((await getJson(h.app, "/api/config")).body["base_url"]).toBe(before);
  });
});

describe("W815-4 busy turn attachments (B1)", () => {
  it("a busy session 409s before any attachment bytes are written", async () => {
    const h = make({ runtime: busyRuntime(), session: { name: "s1", log: "" } });
    const res = await getJson(
      h.app,
      "/api/turn",
      jsonRequest("POST", { session: "sample-ws/s1", input: "hi", attachments: [{ data: PNG_1X1, name: "one.png" }] }),
    );
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("attachments cannot be injected");
    expect(existsSync(join(h.workspace, "s1", "attachments"))).toBe(false);
  });
});

describe("W815-6 prompts section_overrides type (B1)", () => {
  it("a wrongly-typed field is a 400 and preserves the stored overrides", async () => {
    const h = make();
    const good = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1", section_overrides: { identity: "KEEP" } }));
    expect(good.status).toBe(200);
    const bad = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1", section_overrides: ["identity"] }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: "section_overrides must be an object of string templates" });
    const row = ((await getJson(h.app, "/api/prompts")).body["prompts"] as Array<Record<string, unknown>>).find((p) => p["id"] === "p-1");
    expect(row?.["section_overrides"]).toEqual({ identity: "KEEP" });
  });
});

describe("W815-7 providers models type (B1)", () => {
  it("a non-array models field is a 400 and preserves the stored list", async () => {
    const h = make();
    const base = { id: "p", name: "P", base_url: "http://127.0.0.1:9999/v1" };
    expect((await getJson(h.app, "/api/providers", jsonRequest("POST", { ...base, models: [{ id: "m-1" }] }))).status).toBe(200);
    const bad = await getJson(h.app, "/api/providers", jsonRequest("POST", { ...base, models: "not-array" }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: "models must be an array" });
    const row = ((await getJson(h.app, "/api/providers")).body["providers"] as Array<Record<string, unknown>>).find((p) => p["id"] === "p");
    expect((row?.["models"] as Array<{ id: string }>).map((m) => m.id)).toEqual(["m-1"]);
  });
});

describe("W815-N2 hot-apply serial queue (B1)", () => {
  it("serializes two concurrent prompt writes so the successful one survives", async () => {
    let calls = 0;
    const runtime = fakeWithConfigure(async (base, patch) => {
      calls += 1;
      if (calls === 1) throw new EngineError("first configure fails");
      return base.configure(patch);
    });
    const h = make({ runtime });
    const [a, b] = await Promise.all([
      getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "first", name: "First" })),
      getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "second", name: "Second" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 500]);
    const winner = [a, b].find((r) => r.status === 200);
    const ids = ((await getJson(h.app, "/api/prompts")).body["prompts"] as Array<{ id: string }>).map((p) => p.id);
    // The registry/disk equal the LAST successful apply — the earlier failure's
    // rollback must not clobber it.
    expect(ids).toEqual([String(winner?.body["id"])]);
    expect(existsSync(join(h.root, "prompts.json"))).toBe(true);
  });
});
