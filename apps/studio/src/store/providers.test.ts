import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_API_KEY, UNSUPPORTED_FORMAT, probeModels, resolveProbeKey, testProvider, type ProbeFetch, type ProbeResponse } from "./provider-probe.js";
import { ProvidersStore } from "./providers.js";

const SECRET = "sk-live-DEADBEEF-0123456789";
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "providers-"));
  file = join(root, "providers.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function store(): ProvidersStore {
  return new ProvidersStore(file);
}

function plant(): ProvidersStore {
  const s = store();
  s.upsert({ id: "celestea", name: "Gateway", note: "local", base_url: "http://127.0.0.1:3001/v1", request_format: "chat_completions", api_key: SECRET, models: [{ id: "m-1", name: "M1", reasoning_efforts: ["low", "high"] }] });
  s.setDefaultModel("m-1");
  return s;
}

function respond(status: number, body: string): ProbeResponse {
  return { status, text: () => Promise.resolve(body) };
}

describe("providers.json store (0600, redacted)", () => {
  it("round-trips and forces mode 0600 on every save", () => {
    const s = plant();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(SECRET);
    s.upsert({ id: "celestea", base_url: "http://127.0.0.1:3001/v1", models: [{ id: "m-1" }] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store().defaultModel()).toBe("m-1");
  });

  it("NEVER exposes the key in a public view (not even the field name)", () => {
    const s = plant();
    const text = JSON.stringify(s.response());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("api_key");
    expect(s.response().providers[0]).toMatchObject({ id: "celestea", has_key: true, is_default: true });
    expect(Object.keys(s.response().providers[0] ?? {})).not.toContain("api_key");
  });

  it("keeps the stored key when api_key is absent/null/blank and clears models when absent", () => {
    const s = plant();
    s.upsert({ id: "celestea", base_url: "http://127.0.0.1:3001/v1" });
    expect(s.find("celestea")?.api_key).toBe(SECRET);
    expect(s.find("celestea")?.models).toEqual([]);
    expect(s.find("celestea")?.note).toBe("");
    expect(s.find("celestea")?.name).toBe("celestea");
    expect(s.find("celestea")?.request_format).toBe("chat_completions");
  });

  it("validates with the frozen error strings", () => {
    const s = store();
    expect(s.upsert({ id: " ", base_url: "http://x" })).toEqual({ ok: false, status: 400, error: "provider id must not be empty" });
    expect(s.upsert({ id: "a" })).toEqual({ ok: false, status: 400, error: "base_url is required" });
    expect(s.upsert({ id: "a", base_url: "ftp://x" })).toEqual({ ok: false, status: 400, error: "base_url must be an http:// or https:// URL" });
    expect(s.upsert({ id: "a", base_url: "http://x", request_format: "grpc" })).toEqual({
      ok: false,
      status: 400,
      error: "invalid request_format 'grpc': expected chat_completions | responses | anthropic_messages",
    });
    expect(s.upsert({ id: "a", base_url: "http://x", models: [{ name: "no id" }] })).toEqual({ ok: false, status: 400, error: "each model needs a non-empty id" });
  });

  it("drops a default_model that no live provider lists any more", () => {
    const s = plant();
    expect(s.remove("ghost")).toEqual({ ok: false, status: 404, error: "unknown provider 'ghost'" });
    expect(s.remove("celestea")).toEqual({ ok: true, value: undefined });
    expect(store().defaultModel()).toBeNull();
    expect(store().response()).toEqual({ providers: [], default_model: null });
  });

  it("refuses a malformed file instead of overwriting it", () => {
    writeFileSync(file, "{oops");
    expect(() => store()).toThrow(/providers.json .* is malformed/);
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });
});

describe("provider probe (keyless borrow)", () => {
  const opts = { engineBaseUrl: "http://127.0.0.1:3001/v1/", engineKey: "engine-key", fetch: undefined as ProbeFetch | undefined };

  it("borrows the engine key only for a same-origin keyless provider", () => {
    expect(resolveProbeKey({ id: "a", base_url: "http://127.0.0.1:3001/v1", request_format: "chat_completions", api_key: null }, opts)).toEqual({
      key: "engine-key",
      borrowed: true,
    });
    expect(resolveProbeKey({ id: "a", base_url: "http://elsewhere/v1", request_format: "chat_completions", api_key: null }, opts)).toEqual({
      key: null,
      borrowed: false,
    });
    expect(resolveProbeKey({ id: "a", base_url: "http://elsewhere/v1", request_format: "chat_completions", api_key: "own" }, opts)).toEqual({
      key: "own",
      borrowed: false,
    });
  });

  it("reports the unsupported format and the missing key WITHOUT issuing a request", async () => {
    let called = 0;
    const spy: ProbeFetch = () => {
      called += 1;
      return Promise.resolve(respond(200, "{}"));
    };
    const fmt = await probeModels({ id: "a", base_url: "http://x", request_format: "anthropic_messages", api_key: "k" }, { ...opts, fetch: spy });
    expect(fmt).toEqual({ ok: false, error: UNSUPPORTED_FORMAT });
    const noKey = await probeModels({ id: "a", base_url: "http://elsewhere", request_format: "chat_completions", api_key: null }, { ...opts, fetch: spy });
    expect(noKey).toEqual({ ok: false, error: NO_API_KEY });
    expect(called).toBe(0);
  });

  it("sends the borrowed key to /models and returns the ids", async () => {
    const seen: string[] = [];
    const spy: ProbeFetch = (url, init) => {
      seen.push(`${init.method} ${url} ${init.headers["authorization"] ?? ""}`);
      return Promise.resolve(respond(200, JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] })));
    };
    const out = await probeModels({ id: "a", base_url: "http://127.0.0.1:3001/v1/", request_format: "chat_completions", api_key: null }, { ...opts, fetch: spy });
    expect(out).toEqual({ ok: true, models: [{ id: "m-1" }, { id: "m-2" }] });
    expect(seen).toEqual(["GET http://127.0.0.1:3001/v1/models Bearer engine-key"]);
  });

  it("keeps HTTP errors and non-JSON bodies in the error text", async () => {
    const http = await probeModels(
      { id: "a", base_url: "http://x", request_format: "chat_completions", api_key: "k" },
      { ...opts, fetch: () => Promise.resolve(respond(401, '{"error":"unauthorized"}')) },
    );
    expect(http).toEqual({ ok: false, error: 'HTTP 401: {"error":"unauthorized"}' });
    const notJson = await probeModels(
      { id: "a", base_url: "http://x", request_format: "chat_completions", api_key: "k" },
      { ...opts, fetch: () => Promise.resolve(respond(200, "<html>nope</html>")) },
    );
    expect(notJson.ok).toBe(false);
    expect(notJson.error).toContain("response is not JSON");
  });

  it("reports latency + model_count for /api/providers/test", async () => {
    let clock = 100;
    const out = await testProvider(
      { id: "a", base_url: "http://x", request_format: "chat_completions", api_key: "k" },
      { ...opts, fetch: () => Promise.resolve(respond(200, JSON.stringify({ data: [{ id: "m-1" }] }))) },
      () => (clock += 25),
    );
    expect(out).toEqual({ ok: true, latency_ms: 25, model_count: 1 });
  });
});
