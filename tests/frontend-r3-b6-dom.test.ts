// @vitest-environment jsdom
/**
 * R3 W838 · B6 —— 其余 UI 行为（第 9 批 web 前端）。
 * 来源：/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 *   F5：会话容器 drop 后提问卡片（live 强引用 + 倒计时 ticker）必须同步回收。
 *   F9：初始「已收起」时 --sidebar-w 必须保持 0px（y1224 不被 applyWidth 覆写）。
 *   F10：/compact 去重按会话记录 —— A 刚压缩不得吞 B 的 compact SSE。
 * 范式：jsdom + pathToFileURL 加载真实模块，驱动真实 dropPane / 真实事件 / 真实 SSE 入口。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

interface StyleLike {
  setProperty(k: string, v: string): void;
  getPropertyValue(k: string): string;
  width: string;
}
interface ElLike {
  id: string;
  textContent: string | null;
  value: string;
  disabled: boolean;
  hidden: boolean;
  title: string;
  parentElement: ElLike | null;
  isConnected: boolean;
  style: StyleLike;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean };
  appendChild(n: ElLike): ElLike;
  replaceChildren(): void;
  remove(): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
}
interface DocLike {
  body: ElLike & { innerHTML: string };
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface Pane {
  id: string;
  el: ElLike;
  streaming: boolean;
}
interface ViewMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): Pane;
  dropPane(id: string): boolean;
}
interface CardMod {
  renderQuestionCard(ctx: unknown, raw: unknown): unknown;
  liveCardCount(): number;
}
interface SidebarMod {
  initSidebar(): void;
}
interface CompactMod {
  runCompact(ctx: unknown): Promise<void>;
  onCompact(p: { session?: string; note?: string }): void;
}

const doc = (globalThis as unknown as { document: DocLike }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;

const HTML =
  '<div id="app"><aside id="sidebar"></aside><div id="sidebarResizer"></div><span id="btnSidebar"></span>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">—</span><span class="sl-cache" id="slCache">—</span>' +
  '<span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div>';

const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const flush = async (n = 16): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const store = (globalThis as unknown as {
  localStorage: { setItem(k: string, v: string): void; clear(): void };
}).localStorage;

const FRAME = {
  session: "ws/s1",
  id: "q-r3",
  expires_at: Date.now() + 300_000,
  timeout_ms: 300_000,
  questions: [{ id: "mode", question: "选哪个方案？", options: [{ label: "A" }, { label: "B" }] }],
};

async function bootView(): Promise<ViewMod> {
  const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as unknown as ViewMod;
  view.initViewCtx();
  view.ensurePane("ws/s1", "session", "甲会话");
  view.activatePane("ws/s1", "session", "甲会话");
  return view;
}

describe("R3 W838-F5 · dropPane 回收提问卡片", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("挂一张提问卡后 dropPane → live 清零且 ticker 停表", async () => {
    const view = await bootView();
    const card = (await import(/* @vite-ignore */ at("ui/question/card.ts"))) as unknown as CardMod;
    const win = globalThis as unknown as { clearInterval(id: number): void };
    const clearSpy = vi.spyOn(win, "clearInterval");
    const pane = view.ensurePane("ws/s1", "session", "甲会话");
    card.renderQuestionCard(pane, FRAME);
    expect(card.liveCardCount()).toBe(1);
    view.dropPane("ws/s1");
    expect(card.liveCardCount()).toBe(0);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("R3 W838-F9 · 初始已收起时 --sidebar-w 保持 0px", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); store.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); store.clear(); doc.body.replaceChildren(); });

  it("collapsed=1 + width=400 → 初始化后 --sidebar-w 仍是 0px", async () => {
    store.setItem("celestea-studio.sidebar-collapsed", "1");
    store.setItem("celestea-studio.sidebar-width", "400");
    const sb = (await import(/* @vite-ignore */ at("ui/sidebar.ts"))) as unknown as SidebarMod;
    sb.initSidebar();
    const app = doc.getElementById("app") as ElLike;
    const sidebar = doc.getElementById("sidebar") as ElLike;
    expect(app.style.getPropertyValue("--sidebar-w")).toBe("0px");
    expect(sidebar.style.width).toBe("400px");
  });
});

describe("R3 W838-F10 · /compact 去重按会话", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("本地压缩 A 后，A 的 SSE 被吞而 B 的 SSE 触发恢复", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.indexOf("/compact") >= 0) return reply(200, { ok: true, compacted: true, note: "" });
      if (u.indexOf("/messages") >= 0) return reply(200, { ok: true, messages: [] });
      return reply(200, { ok: true });
    });
    const view = await bootView();
    const a = view.ensurePane("ws/a", "session", "A");
    view.activatePane("ws/a", "session", "A");
    view.ensurePane("ws/b", "session", "B");
    const compact = (await import(/* @vite-ignore */ at("ui/compact.ts"))) as unknown as CompactMod;
    await compact.runCompact(a);
    calls.length = 0;
    compact.onCompact({ session: "ws/a", note: "A 压缩" });
    await flush(10);
    expect(calls.some((u) => u.indexOf("/api/sessions/ws%2Fa/messages") === 0)).toBe(false);
    calls.length = 0;
    compact.onCompact({ session: "ws/b", note: "B 压缩" });
    await flush(16);
    expect(calls.some((u) => u.indexOf("/api/sessions/ws%2Fb/messages") === 0)).toBe(true);
  });
});

