// @vitest-environment jsdom
/**
 * W866 · 用户与 worker 的交互 + worker 的即时显示（用户反馈 2/3）。
 *
 * 三条真实模块（不是复刻逻辑）的回归：
 *   ① 用户能在 worker 会话里输入并发出 —— 走**同一条** POST /api/turn，
 *      session = 'worker:<sid>'（后端据此投进该 worker 的收件箱），
 *      气泡与「已送达」注记当帧出现，失败则回滚；
 *   ② 模型 spawn 出 worker 后**无需等待轮询**：工具结果到达那一帧，
 *      会话页左上角的 worker 快捷条里就出现该行（断言全程零 /api/sessions 请求）；
 *   ③ 位置与结构：快捷条挂在会话页（#main）里、**不在**滚动容器 .sess-pane 内，
 *      不遮挡正文（z-index 低于 rail 悬停卡、只占左侧留白带），
 *      侧栏的谱系 Worker 组（.ws-worker-host）仍归 #sessionTree —— 两者分工不冲突。
 *
 * 反向变异（报告里贴原始输出）：
 *   · 拿掉「即时插入」（applyToolResult 里的 noteSpawnedWorker）→ ② 必须变红；
 *   · 恢复 worker 输入禁用（setInputMode('readonly') 分支）→ ① 必须变红。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ClassListLike {
  contains(c: string): boolean;
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
}
interface StyleLike {
  [k: string]: unknown;
}
interface ElLike {
  tagName: string;
  className: string;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  title: string;
  dataset: Record<string, string | undefined>;
  classList: ClassListLike;
  style: StyleLike;
  children: ArrayLike<ElLike>;
  parentElement: ElLike | null;
  isConnected: boolean;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  closest(sel: string): ElLike | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface DocLike {
  body: ElLike & { replaceChildren(...n: ElLike[]): void };
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
const doc = (globalThis as unknown as { document: DocLike }).document;

/** 基础规则区（首个 @media 之前）：窄屏降级会覆写同名选择器，取真源看这一段。 */
const base = (cssText: string): string => {
  const i = cssText.indexOf("@media");
  return i < 0 ? cssText : cssText.slice(0, i);
};

/** 取某选择器**最后一条**规则体（后写的规则才是生效的那条）。 */
function rule(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...cssText.matchAll(new RegExp(esc + "\\s*\\{([^}]*)\\}", "g"))];
  expect(all.length, "找不到规则：" + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? "";
}

/** 与 index.html 同构的最小骨架（会话页 + 输入栏 + statusline + 状态栏）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle><circle class="sl-ring-prog"></circle></svg></span>' +
  '<span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">—</span><span class="sl-cache" id="slCache">—</span>' +
  '<span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><div class="input-box"><textarea id="input" rows="2"></textarea></div>' +
  '<div class="input-side"><button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const PARENT = "sample-ws/s1";
const WORKER = "worker:session-7";

type Listener = (e: { data: string }) => void;
class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  seq = 0;
  private listeners = new Map<string, Listener[]>();
  constructor() {
    lastES = this;
  }
  addEventListener(name: string, fn: Listener): void {
    const l = this.listeners.get(name) || [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  close(): void {}
  fire(name: string, payload: Record<string, unknown>, session: string): void {
    const env = { v: 2, session, turn: 1, seq: this.seq++, payload };
    for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(env) });
  }
}
let lastES: FakeES | null = null;

/** 网络记录：每个 POST /api/turn 的请求体 + 列表请求次数（证明「不等轮询」）。 */
interface TurnReq {
  input?: string;
  session?: string;
  mode?: string;
}
const net: { turns: TurnReq[]; sessionListCalls: number; workerTurnStatus: number } = {
  turns: [],
  sessionListCalls: 0,
  workerTurnStatus: 200,
};

const jsonReply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const flush = async (n = 16): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** jsdom 没有 ResizeObserver（rail 的滚动绑定会用它）——补一个空实现，别让监听器中途抛错。 */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function installGlobals(): void {
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u === "/api/turn") {
      const body = JSON.parse(init?.body ?? "{}") as TurnReq;
      net.turns.push(body);
      if (net.workerTurnStatus !== 200) return jsonReply(net.workerTurnStatus, { error: "unknown session" });
      return jsonReply(200, { ok: true, delivered: true, status: "RUNNING", state: "idle", worker: "session-7" });
    }
    if (u === "/api/sessions") {
      net.sessionListCalls += 1;
      return jsonReply(200, { sessions: [], active_session: null });
    }
    return jsonReply(200, { ok: true, sessions: [], messages: [], workspaces: [], providers: [] });
  });
}

function fire(name: string, payload: Record<string, unknown>, session = PARENT): void {
  if (!lastES) throw new Error("connectSse 没有创建 EventSource");
  lastES.fire(name, payload, session);
}

/** 装配「worker 会话 + 输入栏 + 真实 dispatchSend」。 */
async function bootWorkerSend(): Promise<{ send: { dispatchSend(t: string, m?: string): void }; bar: any; V: any }> {
  const V = (await import(at("ui/viewctx.ts"))) as any;
  V.initViewCtx();
  V.ensurePane(WORKER, "worker", "W866·互动");
  V.activatePane(WORKER, "worker", "W866·互动");
  const send = (await import(at("ui/send.ts"))) as any;
  const bar = (await import(at("ui/inputbar.ts"))) as any;
  bar.initInputBar({ send: (t: string, m: string) => send.dispatchSend(t, m), cancel: () => {} });
  // chat.ts 是输入栏模式的真源；这里直接调它同步一次（等价于 onPaneChange 的效果）。
  const chat = (await import(at("chat.ts"))) as any;
  chat.initChat();
  return { send, bar, V };
}

/** 装配「真实 SSE 接线 + 快捷条」。 */
async function bootChat(): Promise<{ V: any; chat: any; strip: any }> {
  const V = (await import(at("ui/viewctx.ts"))) as any;
  V.initViewCtx();
  const strip = (await import(at("ui/worker-strip.ts"))) as any;
  strip.initWorkerStrip();
  const chat = (await import(at("chat.ts"))) as any;
  chat.connectSse();
  return { V, chat, strip };
}

const count = (root: ElLike, sel: string): number => Array.from(root.querySelectorAll(sel)).length;

beforeEach(() => {
  lastES = null;
  net.turns = [];
  net.sessionListCalls = 0;
  net.workerTurnStatus = 200;
  doc.body.innerHTML = HTML;
  vi.resetModules();
  installGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W866 ① 用户可以在 worker 会话里发言（真实 dispatchSend → POST /api/turn）", () => {
  it("发送走同一条 turn 请求，目标是该 worker 会话；气泡与送达注记当帧出现", async () => {
    const { send, V } = await bootWorkerSend();
    const paneEl = V.paneOf(WORKER).el as ElLike;

    send.dispatchSend("用户对 worker 说话");
    // 乐观优先：这一帧（还没 await 网络）气泡已经在流里。
    expect(paneEl.querySelector(".msg.user .content")?.textContent).toBe("用户对 worker 说话");

    await flush();
    expect(net.turns).toHaveLength(1);
    expect(net.turns[0]?.session).toBe(WORKER);
    expect(net.turns[0]?.input).toBe("用户对 worker 说话");
    expect(paneEl.querySelector(".interject-note")?.textContent).toContain("已送达");
    expect((doc.getElementById("input") as ElLike).value).toBe("");
  });

  it("发送失败：撤销气泡 + 文本还原到输入框 + 说明原因", async () => {
    const { send, V } = await bootWorkerSend();
    const paneEl = V.paneOf(WORKER).el as ElLike;
    net.workerTurnStatus = 404;

    send.dispatchSend("这条会失败");
    await flush();

    expect(net.turns).toHaveLength(1);
    expect(paneEl.querySelector(".msg.user")).toBeNull();
    expect((doc.getElementById("input") as ElLike).value).toBe("这条会失败");
    expect(paneEl.textContent ?? "").toContain("未送达");
  });

  it("切到 worker 会话：输入栏模式真源给的是可发送态（#inputbar 无 .readonly、按钮可用）", async () => {
    const { V } = await bootWorkerSend();
    // 真源路径：切走再切回 worker → onPaneChange → chat.refreshInputMode。
    V.activatePane(PARENT, "session", "主会话");
    V.activatePane(WORKER, "worker", "W866·互动");
    await flush();
    expect(V.activePane().kind).toBe("worker");
    const box = doc.getElementById("inputbar") as ElLike;
    expect(box.classList.contains("readonly")).toBe(false);
    expect(box.classList.contains("worker")).toBe(true);
    expect((doc.getElementById("btnSend") as ElLike).disabled).toBe(false);
    expect((doc.getElementById("input") as ElLike).getAttribute("readonly")).toBeNull();
  });
});

describe("W866 ② spawn 后无需等待轮询：工具结果到达当帧即出现", () => {
  it("tool_result(spawn_worker) 一到，快捷条立刻有该行 —— 全程零 /api/sessions 请求", async () => {
    const { V } = await bootChat();
    V.ensurePane(PARENT, "session", "主会话");
    V.activatePane(PARENT, "session", "主会话");

    const stripEl = doc.getElementById("wsStrip") as ElLike;
    expect(stripEl.classList.contains("hidden")).toBe(true); // 还没有 worker

    fire("tool", { id: "c1", name: "spawn_worker", args: { wid: "W866", brief: "做事" } });
    fire("tool_result", {
      id: "c1",
      ok: true,
      value: { ok: true, sessionId: "session-7", title: "W866·即时", wid: "W866" },
    });

    // 没有 await：同一帧就应该在。
    expect(stripEl.classList.contains("hidden")).toBe(false);
    const rows = Array.from(stripEl.querySelectorAll(".ws-strip-row"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.id).toBe(WORKER);
    expect(rows[0]?.textContent ?? "").toContain("W866");
    // 「不等轮询」的硬证据：这一路没有任何会话列表请求。
    expect(net.sessionListCalls).toBe(0);
  });

  it("重复结果不重复插行（同 id 只更新）", async () => {
    const { V } = await bootChat();
    V.ensurePane(PARENT, "session", "主会话");
    V.activatePane(PARENT, "session", "主会话");
    const payload = { id: "c1", ok: true, value: { ok: true, sessionId: "session-7", title: "W866·即时", wid: "W866" } };
    fire("tool", { id: "c1", name: "spawn_worker", args: {} });
    fire("tool_result", payload);
    fire("tool_result", { ...payload, id: "c2" });
    const stripEl = doc.getElementById("wsStrip") as ElLike;
    expect(count(stripEl, ".ws-strip-row")).toBe(1);
  });
});

describe("W866 ③ 位置与结构：会话页左上角、不遮挡正文、与侧栏分工", () => {
  it("快捷条挂在 #main 里（不在滚动容器 .sess-pane 内），点击聚焦该 worker", async () => {
    const { V } = await bootChat();
    V.ensurePane(PARENT, "session", "主会话");
    V.activatePane(PARENT, "session", "主会话");
    fire("tool", { id: "c1", name: "spawn_worker", args: {} });
    fire("tool_result", { id: "c1", ok: true, value: { ok: true, sessionId: "session-7", title: "W866·即时", wid: "W866" } });

    const stripEl = doc.getElementById("wsStrip") as ElLike;
    expect(stripEl.closest("#main")).not.toBeNull();
    expect(stripEl.closest(".sess-pane")).toBeNull(); // 不在滚动容器里：不随正文滚动、不抢列宽
    expect(doc.getElementById("sessionTree")?.closest("#main")).toBeNull(); // 侧栏 Worker 组仍归侧栏

    const row = Array.from(stripEl.querySelectorAll(".ws-strip-row"))[0] as ElLike;
    row.click();
    await flush();
    expect(V.activeSessionId()).toBe(WORKER);
    expect((V.paneOf(WORKER).el as ElLike).hidden).toBe(false);
  });

  it("CSS：绝对定位在左侧留白带、z-index 低于 rail 悬停卡、发丝线与 W12 令牌、窄屏隐藏", () => {
    const strip = css("workerstrip.css");
    const s = rule(base(strip), ".ws-strip");
    expect(s).toContain("position: absolute");
    expect(s).toContain("pointer-events: none"); // 空白处穿透，只有 chip 自己可点
    expect(s).toContain("max-width: calc("); // 宽度上限 = 左侧留白带，绝不压到正文列
    const z = Number(/z-index:\s*(\d+)/.exec(s)?.[1] ?? "0");
    const railCss = base(css("rail.css"));
    const railZ = Number(/z-index:\s*(\d+)/.exec(rule(railCss, ".railv3"))?.[1] ?? "0");
    const cardZ = Number(/z-index:\s*(\d+)/.exec(rule(railCss, ".railv3-card"))?.[1] ?? "0");
    expect(z).toBeGreaterThan(railZ); // 盖过轨道细条（否则被压在底下看不见）
    expect(z).toBeLessThan(cardZ); // 低于悬停预览卡：不遮用户的悬停预览
    const row = rule(base(strip), ".ws-strip-row");
    expect(row).toContain("border: var(--hairline) solid var(--c-border-subtle)");
    expect(row).toContain("border-radius: var(--r-badge)");
    expect(strip).not.toMatch(/dashed|dotted/);
    expect(strip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 颜色只走 --c-* 令牌
    const radii = [...strip.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(radii.length).toBeGreaterThan(0);
    for (const r of radii) expect(r.startsWith("var(--r-"), r + " 应引用 --r-* 令牌").toBe(true);
    // 窄屏降级：留白带容不下 chip 时整条隐藏（正文优先）
    expect(strip).toContain("@media (max-width: 1024px)");
    const narrow = strip.slice(strip.indexOf("@media (max-width: 1024px)"));
    expect(narrow).toContain(".ws-strip { display: none; }");
  });
});
