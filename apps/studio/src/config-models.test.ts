/**
 * W750 · 模型选择器：`GET /api/config` 的 available.models 与
 * `POST /api/providers/default` 的 provider 消歧。
 *
 * 生产 bug 的回归防线：同一个 model id 由两个 provider 提供时（线上
 * `deepseek-flash` 同时属于网关与「基元」），旧的**全局** id 去重会把后一个
 * provider 整组吞掉 —— 用户只看到「当前 provider 的模型」，且没有任何接口能
 * 表达「切到那个 provider」（按模型 id 切只会命中第一个列出它的 provider）。
 *
 * 独立成文件（而不是塞进 app.test.ts / app-domains.test.ts）：本仓 eslint 有
 * max-lines(400) 与 max-lines-per-function(150)，两个大文件的预算不能挪。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const SECRET = "sk-live-W750-CAFEBABE";
const harnesses: StudioHarness[] = [];

function model(id: string, efforts: string[] = ["low"]): Record<string, unknown> {
  return { id, name: id, reasoning_efforts: efforts, context_window: null, max_output_tokens: null };
}

function provider(id: string, name: string, baseUrl: string, models: Array<Record<string, unknown>>): Record<string, unknown> {
  return { id, name, note: "", base_url: baseUrl, request_format: "chat_completions", api_key: SECRET, models };
}

function make(files: Record<string, unknown>, runtimeModel: string): StudioHarness {
  const h = makeHarness({
    runtime: createFakeRuntimeAdapter({ profile: { model: runtimeModel } }),
    files,
  });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** 线上拓扑：网关 4 个模型（含 deepseek-flash）+「基元」也提供 deepseek-flash。 */
function production(): Record<string, unknown> {
  return {
    "providers.json": {
      providers: [
        provider("celestea", "Celestea 网关", "http://127.0.0.1:3001/v1", [
          model("deepseek-v4-flash-0731", ["low", "high"]),
          model("deepseek-flash", ["low", "high", "max"]),
          model("deepseek-flash", ["low", "high", "max"]), // 同一 provider 内重复 = 笔误，仍只出一行
          model("glm-5.3-flash", []),
        ]),
        provider("jiyuan", "基元", "https://tokenrhythm.studio/v1", [model("deepseek-flash", ["low", "high", "max"])]),
      ],
      default_model: "deepseek-flash",
    },
  };
}

describe("W750 GET /api/config — available.models", () => {
  it("同一 id 在两个 provider 下是两条，去重只在 provider 内做", async () => {
    const h = make(production(), "deepseek-flash");
    const { body } = await getJson(h.app, "/api/config");
    const models = (body["available"] as { models: Array<Record<string, unknown>> }).models;
    expect(models).toEqual([
      { id: "deepseek-v4-flash-0731", name: "deepseek-v4-flash-0731", provider: "Celestea 网关", provider_id: "celestea", active: false, reasoning: true },
      { id: "deepseek-flash", name: "deepseek-flash", provider: "Celestea 网关", provider_id: "celestea", active: true, reasoning: true },
      { id: "glm-5.3-flash", name: "glm-5.3-flash", provider: "Celestea 网关", provider_id: "celestea", active: false, reasoning: false },
      { id: "deepseek-flash", name: "deepseek-flash", provider: "基元", provider_id: "jiyuan", active: false, reasoning: true },
    ]);
    // 两个 provider 都在；撞名 id 有且只有一条 active（端点决定归属）。
    expect(new Set(models.map((m) => m["provider_id"]))).toEqual(new Set(["celestea", "jiyuan"]));
    expect(models.filter((m) => m["active"] === true)).toHaveLength(1);
    expect(models.filter((m) => m["active"] === true)[0]?.["provider_id"]).toBe("celestea");
    // 多出来的字段不得带出密钥。
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("切到另一个 provider 之后，active 跟着端点走（基元那一条变成当前）", async () => {
    const h = make(production(), "deepseek-flash");
    const res = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "deepseek-flash", provider_id: "jiyuan" }));
    expect(res.status).toBe(200);
    const models = ((await getJson(h.app, "/api/config")).body["available"] as { models: Array<Record<string, unknown>> }).models;
    expect(models.filter((m) => m["active"] === true)).toEqual([
      { id: "deepseek-flash", name: "deepseek-flash", provider: "基元", provider_id: "jiyuan", active: true, reasoning: true },
    ]);
  });

  it("无端点匹配时：撞名 id 不虚标 active，唯一 id 才算当前", async () => {
    const solo = make({ "providers.json": { providers: [provider("a", "A", "http://127.0.0.1:1111/v1", [model("solo", [])])], default_model: "solo" } }, "solo");
    const dup = make({ "providers.json": { providers: [provider("a", "A", "http://127.0.0.1:1111/v1", [model("dup", [])]), provider("b", "B", "http://127.0.0.1:2222/v1", [model("dup", [])])], default_model: "dup" } }, "dup");
    const soloModels = ((await getJson(solo.app, "/api/config")).body["available"] as { models: Array<Record<string, unknown>> }).models;
    const dupModels = ((await getJson(dup.app, "/api/config")).body["available"] as { models: Array<Record<string, unknown>> }).models;
    expect(soloModels.map((m) => m["active"])).toEqual([true]);
    // 端点都不匹配 + id 出现两次 → 诚实地不标（点哪一行都会显式切 provider）
    expect(dupModels.map((m) => m["active"])).toEqual([false, false]);
  });
});

describe("W750 POST /api/providers/default — provider 消歧", () => {
  it("带 provider_id：切到该 provider 自己的端点；不带：沿用第一个列出者", async () => {
    const h = make(production(), "deepseek-flash");
    const viaId = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "deepseek-flash", provider_id: "jiyuan" }));
    expect(viaId.status).toBe(200);
    expect(h.runtime.profile().base_url).toBe("https://tokenrhythm.studio/v1");
    expect(h.runtime.profile().model).toBe("deepseek-flash");
    expect(viaId.body["default_model"]).toBe("deepseek-flash");

    const legacy = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "deepseek-flash" }));
    expect(legacy.status).toBe(200);
    expect(h.runtime.profile().base_url).toBe("http://127.0.0.1:3001/v1");
  });

  it("被拒的 provider_id 绝不落半成品（先校验后改）", async () => {
    const h = make(production(), "deepseek-flash");
    const badModel = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "nope", provider_id: "jiyuan" }));
    expect(badModel.status).toBe(400);
    expect(badModel.body).toEqual({ ok: false, error: "provider 'jiyuan' does not list model 'nope'" });
    const badProvider = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "deepseek-flash", provider_id: "ghost" }));
    expect(badProvider.status).toBe(404);
    expect(badProvider.body).toEqual({ ok: false, error: "unknown provider 'ghost'" });
    expect((await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: " ", provider_id: "jiyuan" }))).status).toBe(400);
    expect(h.runtime.profile().base_url).toBe("http://127.0.0.1:3001/v1");
    expect(h.runtime.profile().model).toBe("deepseek-flash");
  });
});
