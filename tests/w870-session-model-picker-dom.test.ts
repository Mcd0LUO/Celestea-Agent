// @vitest-environment jsdom
/**
 * W870 · statusline 的模型选择器打**哪个端点**（真实模块 + 真实 DOM 事件，jsdom）。
 *
 * 用户报案：「点击切换模型后，若干秒模型又回到了切换前的状态」。根因是徽标轮询
 * `GET /api/status?session=<聚焦会话>`，其 model 来自会话实例的 profile（全局 base +
 * `session.json.model` 覆盖），而 W750 的选择器只写全局 `POST /api/config` ——
 * 带覆盖的会话会在 ≤2s 后的轮询被打回原值。
 *
 * 本文件钉住 W870 的产品语义与请求目标：
 *   ① 有聚焦会话 → 切模型打 `PUT /api/sessions/{id}/model`，**不打** /api/config；
 *   ② 无聚焦会话（旧单会话容器）→ 回落 `/api/config`（全局默认路径不丢）；
 *   ③ 成功提示如实区分「已切换本会话模型」/「已切换默认模型」；
 *   ④ 会话带覆盖时选择器显式说明「本会话已固定模型」；
 *   ⑤ W795 的乐观显示 / 失败回滚 / 409 挂起结构原样保留（不推翻 W795）。
 *
 * 加载范式沿用 tests/session-mode-dom.test.ts（pathToFileURL 动态 import 真实前端模块）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface El {
  textContent: string | null;
  innerHTML: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  title: string;
  type: string;
  isConnected: boolean;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
  appendChild(n: El): El;
  replaceChildren(...n: El[]): void;
  remove(): void;
  setAttribute(k: string, v: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
interface Doc {
  body: El;
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
interface SlMod {
  statusline: {
    setSession(id: string): void;
    merge(p: Record<string, unknown>): void;
    stop(): void;
    sessionModelFixed: boolean;
  };
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src");
const at = (rel: string): string => pathToFileURL(join(SRC, rel)).href;

const doc = (globalThis as unknown as { document: Doc }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;

/** 与 index.html 的 id/class 一致的最小骨架（statusline + 状态栏）。 */
const HTML =
  '<div id="messages"></div>' +
  '<div id="statusline" class="statusline">' +
  '<span class="sl-ring"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle>' +
  '<circle class="sl-ring-prog"></circle></svg></span>' +
  '<span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button>' +
  '<button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button>' +
  '<span class="sl-tps" id="slTps"></span><span class="sl-cache" id="slCache"></span>' +
  '<span class="sl-steps" id="slSteps"></span><span class="sl-hint" id="slHint"></span>' +
  "</div>";

let sl: SlMod;
let calls: { url: string; method: string; body: string }[];
let statusBySession: Record<string, unknown>;
let sessionModelStatus: number;
let configStatus: number;
/** GET /api/config 的清单；空数组 = 弹层走「手工输入」降级。 */
let configModels: unknown[];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const click = (n: El | null): void => void n?.dispatchEvent(new Ev("click"));
const badge = (): El => doc.getElementById("slModel") as El;
const hint = (): string => doc.getElementById("slHint")?.textContent ?? "";
/** 只数**写**请求：GET /api/config 是弹层取清单，不算「切换打向哪里」。 */
const modelCalls = (): { url: string; method: string; body: string }[] =>
  calls.filter((c) => c.method !== "GET" && (c.url.includes("/model") || c.url === "/api/config"));
const opts = (): El[] => [...doc.querySelectorAll("#statusline .sl-opt")];
const popupText = (): string => doc.querySelector("#statusline .sl-popup")?.textContent ?? "";

const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

beforeEach(async () => {
  calls = [];
  sessionModelStatus = 200;
  configStatus = 200;
  configModels = [
    { id: "m-old", name: "Old", provider_id: "p1", provider: "P1", active: true },
    { id: "m-new", name: "New", provider_id: "p1", provider: "P1" },
  ];
  statusBySession = {
    "ws/s1": { ok: true, model: "m-old", reasoning_effort: "low", mode: "standard", model_covered: true },
  };
  doc.body.innerHTML = HTML;
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? "" : String(init.body);
    calls.push({ url: u, method, body });
    if (u.startsWith("/api/health")) {
      return reply(200, { ok: true, capabilities: { grants: true, session_mode_tools: true } });
    }
    if (u.startsWith("/api/status")) return reply(200, statusBySession["ws/s1"] ?? { ok: true });
    if (/\/api\/sessions\/.+\/model$/.test(u)) {
      if (sessionModelStatus !== 200) return reply(sessionModelStatus, { ok: false, error: "turn 进行中，无法切换模型" });
      const asked = (JSON.parse(body === "" ? "{}" : body) as { model?: string }).model ?? "";
      return reply(200, { ok: true, session: "ws/s1", model: asked, covered: asked !== "", effective: { model: asked, base_model: "m-base", source: asked === "" ? "global" : "session", next_turn: true } });
    }
    if (u.startsWith("/api/config")) {
      // configStatus 只管 **POST**（写入）：GET 永远回清单，否则弹层根本没得选。
      if (method === "POST" && configStatus !== 200) {
        return reply(configStatus, { ok: false, error: "config write failed" });
      }
      const asked = (JSON.parse(body === "" ? "{}" : body) as { model?: string }).model ?? "";
      const model = asked !== "" ? asked : "m-old";
      return reply(200, {
        ok: true,
        model,
        reasoning_effort: "low",
        // 清单为空 ⇒ 弹层走「手工输入」降级；这条路径也必须打会话端点。
        available: { models: configModels },
      });
    }
    return reply(404, { ok: false });
  });
  vi.resetModules();
  sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
  sl.statusline.setSession("ws/s1");
  await tick();
});

afterEach(() => {
  sl?.statusline.stop();
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

/** 打开模型弹层（等待配置清单落定）。 */
async function openModelPopup(): Promise<void> {
  click(badge());
  await tick();
}

describe("W870 · statusline 模型选择器的请求目标", () => {
  it("① 有聚焦会话：点一行打 PUT /api/sessions/{id}/model，且不打 /api/config", async () => {
    configStatus = 500; // 全局路径一旦被误用会立刻失败 —— 它就是不许被调用
    await openModelPopup();
    const row = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "m-new");
    expect(row, "清单里必须有 m-new 一行").toBeTruthy();
    click(row ?? null);
    // W795 乐观：同一帧就已经是新模型
    expect(badge().textContent).toBe("m-new");
    await tick();
    const switched = modelCalls();
    expect(switched).toHaveLength(1);
    expect(switched[0]?.method).toBe("PUT");
    expect(switched[0]?.url).toBe("/api/sessions/ws%2Fs1/model");
    expect(JSON.parse(switched[0]?.body ?? "{}")).toEqual({ model: "m-new" });
    expect(switched.some((c) => c.url === "/api/config"), "会话级路径不得再写全局默认").toBe(false);
    expect(badge().textContent).toBe("m-new");
    expect(hint()).toBe("已切换本会话模型");
  });

  it("⑤ 会话级写入失败：回滚到原模型并就地说明（W795 结构原样保留）", async () => {
    sessionModelStatus = 500;
    await openModelPopup();
    const row = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "m-new");
    click(row ?? null);
    expect(badge().textContent).toBe("m-new"); // 当帧终态
    await tick();
    expect(badge().textContent, "失败 ⇒ 必须回滚").toBe("m-old");
    expect(popupText()).toContain("切换失败");
    expect(popupText()).toContain("已恢复原设置");
  });

  it("⑤ 409 会话级：回滚 + 挂起 + 本轮结束按同一路径重试", async () => {
    sessionModelStatus = 409;
    await openModelPopup();
    const row = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "m-new");
    click(row ?? null);
    expect(badge().textContent).toBe("m-new");
    await tick();
    expect(badge().textContent).toBe("m-old"); // 本轮没切过去
    expect(hint()).toBe("轮次进行中，将在本轮结束后生效");
    calls = [];
    sessionModelStatus = 200;
    (sl.statusline as unknown as { onSseDone(): void }).onSseDone();
    expect(badge().textContent).toBe("m-new"); // 同一帧就画上
    await tick();
    expect(modelCalls()[0]?.url).toBe("/api/sessions/ws%2Fs1/model");
    expect(hint()).toBe("已切换本会话模型");
  });

  it("⑤ 清单缺失走手工输入降级：同样打会话端点（不许退回全局配置）", async () => {
    configModels = []; // GET /api/config 回空清单 ⇒ 弹层渲染内联输入框
    await openModelPopup();
    const input = doc.querySelector("#statusline .sl-popup-input") as El | null;
    expect(input, "空清单必须降级成手工输入").not.toBeNull();
    calls = [];
    if (input !== null) input.value = "m-custom";
    click([...doc.querySelectorAll("#statusline .sl-popup-textrow button")][0] ?? null);
    await tick();
    const written = modelCalls();
    expect(written).toHaveLength(1);
    expect(written[0]?.url, "手工输入也是切模型 ⇒ 会话级端点").toBe("/api/sessions/ws%2Fs1/model");
    expect(JSON.parse(written[0]?.body ?? "{}")).toEqual({ model: "m-custom" });
  });

  it("④ 会话有覆盖：选择器显式说明「本会话已固定模型」", async () => {
    await openModelPopup();
    expect(popupText()).toContain("本会话已固定模型");
    expect(sl.statusline.sessionModelFixed).toBe(true);
  });
});

describe("W870 · 无聚焦会话的回落路径（旧单会话容器）", () => {
  beforeEach(async () => {
    // 外层 beforeEach 已经把外层实例挂到了当前 #statusline/#slModel 上；
    // 这里**换掉整棵骨架**再重建模块，否则两个实例会同时挂在新节点上
    // （dispatched click 会同时进两条 handler，测的就不是本用例要测的东西）。
    sl.statusline.stop();
    doc.body.innerHTML = HTML;
    vi.resetModules();
    sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
    // 不调 setSession：sessionId 保持 ''（未解析，= 旧单会话容器）
    statusBySession[""] = { ok: true, model: "m-old", reasoning_effort: "low" };
    await tick();
  });

  it("② 切模型回落 POST /api/config，且不打会话端点；提示如实说「默认」", async () => {
    await openModelPopup();
    const row = opts().find((b) => (b.querySelector(".sl-opt-val")?.textContent ?? "") === "m-new");
    expect(row, "无聚焦会话时清单仍要能渲染").toBeTruthy();
    click(row ?? null);
    await tick();
    const written = modelCalls();
    expect(written).toHaveLength(1);
    expect(written[0]?.method).toBe("POST");
    expect(written[0]?.url).toBe("/api/config");
    expect(JSON.parse(written[0]?.body ?? "{}")).toEqual({ model: "m-new" });
    expect(written.some((c) => c.url.includes("/model")), "无聚焦会话不得打会话端点").toBe(false);
    expect(hint()).toBe("已切换默认模型");
  });
});

describe("W870 · 纯函数：目标选择与文案（node 可直接断言）", () => {
  interface SmMod {
    modelTargetOf(sessionId: string): string;
    switchedNote(target: string): string;
  }
  let sm: SmMod;

  beforeEach(async () => {
    vi.resetModules();
    sm = (await import(/* @vite-ignore */ at("statusline/session-model.ts"))) as SmMod;
  });

  it("有/无聚焦会话分别选会话级与全局端点，文案两种目标说两种话", () => {
    expect(sm.modelTargetOf("ws/s1")).toBe("session");
    expect(sm.modelTargetOf("")).toBe("config");
    expect(sm.switchedNote("session")).toBe("已切换本会话模型");
    expect(sm.switchedNote("config")).toBe("已切换默认模型");
  });
});
