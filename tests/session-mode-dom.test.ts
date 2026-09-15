// @vitest-environment jsdom
/**
 * W788 · 双模式 P1 前端（工具暴露差异的 UI：新建会话「工作方式」+ statusline 徽标与切换）。
 *
 * 权威依据：docs/modes-standard-vs-execution.md §3.1（切换端点契约）、§3.2（前端入口）、
 * §6（可机械检验的验收）、§9 P1 第 8 项。
 *
 * 为什么这么写：本机**没有浏览器**，CSS 观感与真点击无法验证（见报告「诚实边界」）。
 * 这里退而求其次——用 jsdom 加载**真实模块**（不是复刻逻辑），驱动真实 DOM 事件，
 * 断言请求体、徽标文案、三态分支与老服务降级；沿用 tests/question-card-dom.test.ts
 * 的跨仓加载范式（pathToFileURL 动态导入 + 本地最小 DOM 类型，因为根 tsconfig 的
 * lib 里没有 DOM）。模块级单例（statusline）每个用例用 vi.resetModules() 重建，
 * 避免能力位缓存与弹层句柄在用例之间串味。
 *
 * 仍未覆盖：CSS 布局/观感（jsdom 不套样式表）、真实浏览器的点击命中与 Esc 行为。
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

interface CopyMod {
  MODE_CHOICES: { value: string; label: string }[];
  MODE_NOTES: Record<string, string>;
  DEFAULT_MODE: string;
  modeLabel(v: unknown): string;
  modeTitle(v: unknown): string;
}
interface ReqMod {
  buildCreateReq(input: Record<string, unknown>, includeOptional?: boolean): Record<string, unknown>;
}
interface DialogMod {
  newSessionDialog(host: { loadSessions(): Promise<void> }): void;
}
interface SlMod {
  statusline: {
    setSession(id: string): void;
    merge(p: Record<string, unknown>): void;
    fromSse(p: Record<string, unknown>): void;
  };
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web", "src");
const at = (rel: string): string => pathToFileURL(join(SRC, rel)).href;

const doc = (globalThis as unknown as { document: Doc }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;

/** statusline 的宿主骨架（与 index.html 的 id/class 一致，含 W788 的 #slMode）。 */
const HTML =
  '<div id="messages"></div>' +
  // 新建会话弹窗的依赖链（ui/sessiontree/newsession → ui/restore → ui/grants/flow）
  // 在模块顶层 need 了状态栏节点，这里照 index.html 补齐最小骨架。
  '<footer id="statusbar"><span id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
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

const OK_HEALTH = { ok: true, capabilities: { session_mode: true, session_mode_tools: true } };

let copy: CopyMod;
let req: ReqMod;
let sl: SlMod;
let calls: { url: string; body: string }[];
let health: unknown;
let statusBySession: Record<string, unknown>;
let switchResp: { status: number; payload: unknown };
let createResp: { status: number; payload: unknown };

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const click = (n: El | null): void => void n?.dispatchEvent(new Ev("click"));
const badge = (): El => doc.getElementById("slMode") as El;
const hidden = (): boolean => badge().classList.contains("hidden");
const opts = (): El[] => [...doc.querySelectorAll("#statusline .sl-opt")];
const modePosts = (): { url: string; body: string }[] => calls.filter((c) => c.url.endsWith("/mode"));
const sessionOf = (url: string): string => {
  const m = /session=([^&]*)/.exec(url);
  return m?.[1] === undefined ? "" : decodeURIComponent(m[1]);
};

beforeEach(async () => {
  calls = [];
  health = OK_HEALTH;
  statusBySession = {};
  switchResp = { status: 200, payload: { ok: true, session: "ws/s1", mode: "execution", effective: "next_turn" } };
  createResp = { status: 200, payload: { ok: true, id: "ws/s1" } };
  doc.body.innerHTML = HTML;
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body === undefined ? "" : String(init.body) });
    if (u.startsWith("/api/health")) return reply(200, health);
    if (u.endsWith("/mode")) return reply(switchResp.status, switchResp.payload);
    if (u === "/api/sessions") return reply(createResp.status, createResp.payload);
    if (u.startsWith("/api/status")) return reply(200, statusBySession[sessionOf(u)] ?? { ok: true });
    return reply(404, { ok: false });
  });
  vi.resetModules(); // 模块级单例/能力位缓存每个用例重建
  copy = (await import(/* @vite-ignore */ at("ui/mode/copy.ts"))) as CopyMod;
  req = (await import(/* @vite-ignore */ at("ui/mode/create-req.ts"))) as ReqMod;
  sl = (await import(/* @vite-ignore */ at("statusline.ts"))) as SlMod;
});

afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

function reply(status: number, payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/** 打开弹层并等能力位探测落定。 */
async function openPopup(): Promise<void> {
  click(badge());
  await tick();
}

describe("W788 · 工作方式文案（纯函数，node 可断言）", () => {
  it("maps mode values to the two-word badge and to the full option labels", () => {
    expect(copy.modeLabel("standard")).toBe("标准");
    expect(copy.modeLabel("execution")).toBe("执行");
    // 未知/缺失/非法一律空串 —— 调用方据此隐藏入口，而不是显示错误
    expect([copy.modeLabel("fast"), copy.modeLabel(""), copy.modeLabel(undefined), copy.modeLabel(2)]).toEqual(["", "", "", ""]);
    expect(copy.MODE_CHOICES.map((o) => o.label)).toEqual(["标准模式", "执行模式（PTC）"]);
    expect(copy.DEFAULT_MODE).toBe("standard");
    expect(copy.modeTitle("execution")).toBe("执行模式（PTC）");
  });

  it("keeps the frozen 409 copy and the old-service copy verbatim (§3.1)", () => {
    expect(copy.MODE_NOTES.busy).toBe("turn 进行中，无法切换模式");
    expect(copy.MODE_NOTES.applied).toBe("将在会话下一轮生效");
    expect(copy.MODE_NOTES.unsupported).toBe("当前版本不支持切换工作方式");
  });
});

describe("W788 · 新建会话请求体（纯函数）", () => {
  it("carries mode only when the user picked 执行模式（默认路径与今天逐字节一致，K8）", () => {
    const base = { workspace: "ws", title: "t" };
    expect(req.buildCreateReq({ ...base, mode: "execution" })).toEqual({ workspace: "ws", title: "t", mode: "execution" });
    expect(req.buildCreateReq({ ...base, mode: "standard" })).toEqual({ workspace: "ws", title: "t" });
    expect(req.buildCreateReq(base)).toEqual({ workspace: "ws", title: "t" });
  });

  it("passes model/prompt through and drops both new optional keys on the 4xx retry", () => {
    const full = { workspace: null, title: "t", model: "m1", prompt: "p1", mode: "execution" };
    expect(req.buildCreateReq(full)).toEqual({ workspace: null, title: "t", prompt: "p1", model: "m1", mode: "execution" });
    expect(req.buildCreateReq(full, false)).toEqual({ workspace: null, title: "t", prompt: "p1" });
  });
});

describe("W788 · 新建会话弹窗（真实 DOM 接线）", () => {
  const openDialog = async (): Promise<El[]> => {
    const dlg = (await import(/* @vite-ignore */ at("ui/sessiontree/newsession.ts"))) as DialogMod;
    dlg.newSessionDialog({ loadSessions: async () => {} });
    await tick();
    return [...doc.querySelectorAll(".modal-card .prov-field")];
  };

  it("puts 工作方式 in the two-column grid and posts exactly the picked mode", async () => {
    const rows = await openDialog();
    expect(rows.map((r) => r.querySelector(".prov-field-label")?.textContent)).toEqual([
      "标题", "工作区", "模型", "工作方式", "提示词",
    ]);
    const modeSel = rows[3]?.querySelector("select");
    expect([...(modeSel?.querySelectorAll("option") ?? [])].map((o) => o.textContent)).toEqual([
      "标准模式", "执行模式（PTC）",
    ]);
    expect(modeSel?.value).toBe("standard"); // 默认标准
    const title = rows[0]?.querySelector("input");
    if (title) title.value = "T";
    if (modeSel) modeSel.value = "execution";
    click([...doc.querySelectorAll(".modal-card-actions button")][1] ?? null);
    await tick();
    const posts = calls.filter((c) => c.url === "/api/sessions" && c.body !== "");
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({ workspace: null, title: "T", mode: "execution" });
  });

  it("degrades to a retry without the new optional key when the service rejects it (4xx)", async () => {
    createResp = { status: 400, payload: { ok: false, error: "unknown field: mode" } };
    const rows = await openDialog();
    const title = rows[0]?.querySelector("input");
    if (title) title.value = "T";
    const modeSel = rows[3]?.querySelector("select");
    if (modeSel) modeSel.value = "execution";
    click([...doc.querySelectorAll(".modal-card-actions button")][1] ?? null);
    await tick();
    const bodies = calls.filter((c) => c.url === "/api/sessions").map((c) => JSON.parse(c.body));
    expect(bodies).toEqual([
      { workspace: null, title: "T", mode: "execution" },
      { workspace: null, title: "T" },
    ]);
  });
});

describe("W788 · statusline 徽标（真实 DOM，只读）", () => {
  it("renders 标准/执行 from the per-session snapshot and updates on SSE status.payload.mode", () => {
    expect(hidden()).toBe(true); // 快照里没有 mode（老服务）→ 入口隐藏
    sl.statusline.merge({ mode: "execution" });
    expect(badge().textContent).toBe("执行");
    expect(hidden()).toBe(false);
    expect(badge().title).toContain("执行模式");
    sl.statusline.fromSse({ mode: "standard" }); // SSE：status.payload.mode 拍平后合并
    expect(badge().textContent).toBe("标准");
    sl.statusline.merge({ mode: "fast" }); // 非法值 → 不当成功、不显示
    expect(hidden()).toBe(true);
  });

  it("never shows another session's mode (per-session cache, 设计 U7)", async () => {
    statusBySession = { "ws/a": { ok: true, mode: "standard" }, "ws/b": { ok: true, mode: "execution" }, "ws/c": { ok: true } };
    sl.statusline.setSession("ws/a");
    await tick();
    expect(badge().textContent).toBe("标准");
    sl.statusline.setSession("ws/b");
    expect(hidden()).toBe(true); // 切换瞬间不残留上一个会话的徽标
    await tick();
    expect(badge().textContent).toBe("执行");
    sl.statusline.setSession("ws/c");
    await tick();
    expect(hidden()).toBe(true);
    sl.statusline.setSession("ws/a");
    expect(badge().textContent).toBe("标准"); // 缓存命中：立即恢复，不等轮询
  });
});

describe("W788 · 切换弹层三态（真实 DOM）", () => {
  beforeEach(async () => {
    statusBySession = { "ws/s1": { ok: true, mode: "standard" } };
    sl.statusline.setSession("ws/s1");
    await tick();
    expect(badge().textContent).toBe("标准");
  });

  it("POSTs {mode} and lands on 执行, with the「下一轮生效」note", async () => {
    await openPopup();
    expect(opts().map((o) => o.textContent)).toEqual(["标准模式当前", "执行模式（PTC）"]);
    expect(opts()[0]?.disabled).toBe(true); // 当前项禁用：点它没有意义
    click(opts()[1] ?? null);
    await tick();
    expect(modePosts()).toHaveLength(1);
    expect(modePosts()[0]?.url).toBe("/api/sessions/ws%2Fs1/mode");
    expect(JSON.parse(modePosts()[0]?.body ?? "{}")).toEqual({ mode: "execution" });
    expect(badge().textContent).toBe("执行");
    expect(doc.getElementById("slHint")?.textContent).toContain("将在会话下一轮生效");
    expect(doc.querySelector("#statusline .sl-popup")).toBeNull(); // 成功即收起
  });

  it("409 → 冻结文案，且不假装切换成功", async () => {
    switchResp = { status: 409, payload: { ok: false, error: "turn 进行中，无法切换模式" } };
    await openPopup();
    click(opts()[1] ?? null);
    await tick();
    expect(doc.querySelector("#statusline .sl-popup-status")?.textContent).toBe("turn 进行中，无法切换模式");
    expect(doc.getElementById("slHint")?.textContent).toBe("turn 进行中，无法切换模式");
    expect(badge().textContent).toBe("标准"); // 徽标不动
    expect(doc.querySelector("#statusline .sl-popup")).not.toBeNull(); // 弹层留着，用户可重选
  });

  it("404 → 老服务降级：只读提示 + 选项禁用，徽标不动", async () => {
    switchResp = { status: 404, payload: { ok: false, error: "unknown session" } };
    await openPopup();
    click(opts()[1] ?? null);
    await tick();
    expect(doc.querySelector("#statusline .sl-popup-status")?.textContent).toBe("当前版本不支持切换工作方式");
    expect(doc.getElementById("slHint")?.textContent).toBe("当前版本不支持切换工作方式");
    expect(opts().every((o) => o.disabled)).toBe(true); // 清单就地换成禁用态
    expect(badge().textContent).toBe("标准");
  });

  it("capabilities.session_mode_tools 缺省（老后端）→ 弹层只读，零请求、不崩", async () => {
    health = { ok: true }; // 连 capabilities 整块都没有
    await openPopup();
    expect(opts()).toHaveLength(2);
    expect(opts().every((o) => o.disabled)).toBe(true);
    expect(doc.querySelector("#statusline .sl-popup-note")?.textContent).toBe("当前版本不支持切换工作方式");
    click(opts()[1] ?? null);
    await tick();
    expect(modePosts()).toHaveLength(0);
    expect(badge().textContent).toBe("标准");
  });

  it("400（非法 mode）→ 内联报错，不改变徽标", async () => {
    switchResp = { status: 400, payload: { ok: false, error: "invalid mode: x" } };
    await openPopup();
    click(opts()[1] ?? null);
    await tick();
    expect(doc.querySelector("#statusline .sl-popup-status")?.textContent).toBe("工作方式取值无效，请重新选择");
    expect(badge().textContent).toBe("标准");
  });
});
