// @vitest-environment jsdom
/**
 * W847 · 前端两个 P1 的真实 DOM 回归：
 *   ① 运行中提交的终态按响应 placement 渲染（queued -> 已排队，steering -> 已插话），
 *      不再先看 injected（旧后端对 busy+queue 仍回 injected:true，会把「已排队」
 *      覆盖成「已插话」）；
 *   ② done 携带的权威全文在「本步没有任何 text 帧」时不再被丢（旧实现 early
 *      return 掉了唯一一份正文）。
 * 用 jsdom + pathToFileURL 加载真实模块，驱动真实 dispatchSend / 真实 SSE 接线。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ClassListLike {
  contains(c: string): boolean;
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
}
interface ElLike {
  className: string;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  classList: ClassListLike;
  style: Record<string, unknown>;
  children: ArrayLike<ElLike>;
  appendChild(n: ElLike): ElLike;
  remove(): void;
  setAttribute(k: string, v: string): void;
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
const doc = (globalThis as unknown as { document: DocLike }).document;

const HTML =
  '<div id="app"><div id="layout"><main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle><circle class="sl-ring-prog"></circle></svg></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">—</span><span class="sl-cache" id="slCache">—</span>' +
  '<span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const LIVE = "test/w847-lane";

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
  fire(name: string, payload: Record<string, unknown>): void {
    const env = { v: 2, session: LIVE, turn: 1, seq: this.seq++, payload };
    for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(env) });
  }
}
let lastES: FakeES | null = null;

interface Net {
  turnStatus: number;
  turnPayload: Record<string, unknown>;
}
const net: Net = { turnStatus: 200, turnPayload: {} };
const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const flush = async (n = 16): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function installGlobals(): void {
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u === "/api/turn") return reply(net.turnStatus, net.turnPayload);
    return reply(200, { ok: true, questions: [], messages: [] });
  });
}

interface SendMod {
  dispatchSend(t: string, m: string): void;
}
async function bootSend(): Promise<{ send: SendMod }> {
  const V = (await import(at("ui/viewctx.ts"))) as {
    initViewCtx(): void;
    ensurePane(id: string, kind?: string, title?: string): unknown;
    activatePane(id: string, kind?: string, title?: string): unknown;
    setPaneStreaming(p: unknown, on: boolean): void;
  };
  V.initViewCtx();
  const pane = V.ensurePane(LIVE, "session", "甲会话");
  V.activatePane(LIVE, "session", "甲会话");
  const bar = (await import(at("ui/inputbar.ts"))) as {
    initInputBar(h: { send(): void; cancel(): void }): void;
  };
  bar.initInputBar({ send: () => {}, cancel: () => {} });
  V.setPaneStreaming(pane, true);
  const send = (await import(at("ui/send.ts"))) as unknown as SendMod;
  return { send };
}

async function bootChat(): Promise<{ V: any; chat: any; restore: any }> {
  const V = (await import(at("ui/viewctx.ts"))) as any;
  V.initViewCtx();
  const restore = (await import(at("ui/restore.ts"))) as any;
  const chat = (await import(at("chat.ts"))) as any;
  chat.connectSse();
  return { V, chat, restore };
}

function fire(name: string, payload: Record<string, unknown>): void {
  if (!lastES) throw new Error("connectSse 没有创建 EventSource");
  lastES.fire(name, payload);
}

function kindsOf(root: ElLike): string[] {
  const out: string[] = [];
  for (const child of Array.from(root.children)) {
    const cls = (child.className || "").split(/\s+/);
    if (!cls.includes("mcol")) continue;
    if (child.querySelector(".msg.assistant")) out.push("assistant");
    else if (child.querySelector(".msg.user")) out.push("user");
    else out.push("other");
  }
  return out;
}

function noteText(): string {
  return Array.from(doc.querySelectorAll(".interject-note"))
    .map((n) => n.textContent || "")
    .join("|");
}

beforeEach(() => {
  lastES = null;
  net.turnStatus = 200;
  net.turnPayload = {};
  doc.body.innerHTML = HTML;
  vi.resetModules();
  installGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W847 · 发送终态按 placement 渲染（真实 dispatchSend）", () => {
  it("placement=queued 优先于 injected=true：显示已排队，不显示已插话", async () => {
    net.turnPayload = { ok: true, injected: true, turn: 1, pending: 1, placement: "queued", duplicate: false };
    const { send } = await bootSend();
    send.dispatchSend("排队这句话", "queue");
    await flush();
    expect(noteText()).toContain("已排队");
    expect(noteText()).not.toContain("已插话");
  });

  it("placement=steering 优先于 injected=false：显示已插话", async () => {
    net.turnPayload = { ok: true, injected: false, turn: 1, pending: 1, placement: "steering", duplicate: false };
    const { send } = await bootSend();
    send.dispatchSend("插话这句话", "steer");
    await flush();
    expect(noteText()).toContain("已插话");
  });

  it("旧后端无 placement 时保持旧兜底判定（injected=true -> 已插话）", async () => {
    net.turnPayload = { ok: true, injected: true, turn: 1, pending: 1, duplicate: false };
    const { send } = await bootSend();
    send.dispatchSend("旧后端插话", "steer");
    await flush();
    expect(noteText()).toContain("已插话");
  });
});

describe("W847 · done 权威全文（真实 SSE 接线）", () => {
  it("只有 done{text} 没有 text 帧：仍渲染权威全文气泡", async () => {
    const { V } = await bootChat();
    const pane = V.ensurePane(LIVE, "session", "live");
    fire("status", { phase: "start", statusline: {} });
    fire("done", { text: "只有 done 的权威全文" });
    expect(kindsOf(pane.el)).toEqual(["assistant"]);
    const content = pane.el.querySelector(".msg.assistant .content");
    expect(content?.textContent || "").toContain("只有 done 的权威全文");
  });

  it("done 是已恢复尾部的重放时不产生重复气泡（去重语义保持）", async () => {
    const { V, restore } = await bootChat();
    const pane = V.ensurePane(LIVE, "session", "live");
    pane.dedup.tail = { role: "assistant", content: "重放正文" };
    expect(restore.feedAssistantDelta(pane, "重放正文")).toBeNull();
    fire("status", { phase: "start", statusline: {} });
    fire("done", { text: "重放正文" });
    expect(kindsOf(pane.el)).toEqual([]);
  });
});

