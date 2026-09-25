// @vitest-environment jsdom
/**
 * W847 · 思考段「实时流 vs 历史重放」分段一致性（用户实报）
 *
 * 缺陷：落盘的 ThinkingBuffer（packages/agent-loop/src/thinking.ts:26-31）在
 * text/done/terminal 处把一段连续推理 flush 成一条 thinking_delta 行，所以历史
 * 重放天然是 thinking → tool → thinking → tool … 交替；而 live 侧 ctx.thinkSeg
 * 原先只在 endTurn（整轮结束）清空，整轮所有 reasoning 累进同一个段，导致
 * 「刷新后才发现有间隔的思考」。
 *
 * 修法：apps/web/src/ui/messages.ts 新增 flushThinkSegment(ctx)（一步结束收尾，
 * 幂等），chat.ts 在 onDone（assistant 早退之前）与 onTool 调用。
 *
 * 本文件用真实模块（pathToFileURL 动态 import，见 tests/frontend-batch-a-dom.test.ts
 * 的既有跨仓模式）驱动真实 SSE 接线与真实重放渲染器，断言两条路径的分段序列一致。
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
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  classList: ClassListLike;
  style: Record<string, unknown>;
  children: ArrayLike<ElLike>;
  childElementCount: number;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  closest(sel: string): ElLike | null;
}
interface DocLike {
  body: ElLike;
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

const doc = (globalThis as unknown as { document: DocLike }).document;

/** 与 tests/frontend-batch-a-dom.test.ts 同构的最小骨架（statusline 构造器需要的全部节点）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle><circle class="sl-ring-prog"></circle></svg></span>' +
  '<span class="sl-ctx" id="slCtx">—/—</span><span class="sl-sep">·</span>' +
  '<button class="sl-model" id="slModel">—</button><span class="sl-sep">·</span>' +
  '<button class="sl-effort" id="slEffort">—</button><span class="sl-sep">·</span>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-tier" id="slGrantTier"></span><span class="sl-grant-badge" id="slGrantBadge"></span><span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="btnMode" class="sl-mode-btn hidden" type="button">插话</button>' +
  '<button id="slStop" class="sl-stop hidden"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"></rect></svg></button>' +
  '<span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">— tok/s</span><span class="sl-sep">·</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-sep">·</span><span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

/** 两条链路的会话 id（各自一个 SessionPane）。 */
const LIVE = "test/w847-live";
const REPLAY = "test/w847-replay";

type Listener = (e: { data: string }) => void;
class FakeES {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  seq = 0;
  private listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
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

/** 一行落盘事件 → Studio 投影行（与 packages/session/src/messages.ts 同形）。 */
const thinkRow = (text: string): Record<string, unknown> => ({ role: "thinking", content: text });
const callRow = (id: string): Record<string, unknown> => ({
  role: "tool",
  kind: "call",
  tool_call_id: id,
  tool_name: "run_code",
  tool_args: {},
});
const resultRow = (id: string): Record<string, unknown> => ({
  role: "tool",
  kind: "result",
  tool_call_id: id,
  tool_value: "ok",
});
const assistantRow = (text: string): Record<string, unknown> => ({ role: "assistant", content: text });

/** 重放事件序列：一步 = thinking + 两个 run_code（call/result 各两条）。 */
const REPLAY_ROWS: Record<string, unknown>[] = [
  thinkRow("d1"),
  callRow("c1"),
  resultRow("c1"),
  callRow("c2"),
  resultRow("c2"),
  thinkRow("d2"),
  callRow("c3"),
  resultRow("c3"),
  callRow("c4"),
  resultRow("c4"),
  assistantRow("最终回答"),
];

/** 容器内直接子节点的消息种类（跳过空态提示等非 .mcol 节点）。 */
function kindsOf(root: ElLike): string[] {
  const out: string[] = [];
  for (const child of Array.from(root.children)) {
    const cls = (child.className || "").split(/\s+/);
    if (!cls.includes("mcol")) continue;
    if (child.querySelector(".msg.think-seg")) out.push("thinking");
    else if (child.querySelector(".msg.tool")) out.push("tool");
    else if (child.querySelector(".msg.assistant")) out.push("assistant");
    else if (child.querySelector(".msg.user")) out.push("user");
    else out.push("other");
  }
  return out;
}

function thinkBodies(root: ElLike): string[] {
  return Array.from(root.querySelectorAll(".msg.think-seg .think-seg-body")).map(
    (n) => n.textContent || "",
  );
}

async function boot(): Promise<{ V: any; chat: any; restore: any }> {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", async (url: unknown) => {
    if (String(url).indexOf("/messages") !== -1) {
      return { ok: true, status: 200, json: async () => ({ messages: REPLAY_ROWS }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, questions: [] }) };
  });
  const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as any;
  V.initViewCtx();
  const chat = (await import(/* @vite-ignore */ at("chat.ts"))) as any;
  const restore = (await import(/* @vite-ignore */ at("ui/restore.ts"))) as any;
  chat.connectSse();
  return { V, chat, restore };
}

function fire(name: string, payload: Record<string, unknown>): void {
  if (!lastES) throw new Error("connectSse 没有创建 EventSource");
  lastES.fire(name, payload);
}

function startTurn(): void {
  fire("status", { phase: "start", statusline: {} });
}

beforeEach(() => {
  lastES = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W847 · 实时流分段（真实 SSE 接线）", () => {
  it("两个工具步 + 末轮文本：思考段恰好 2 个且互不相邻，kind 序列完整", async () => {
    const { V } = await boot();
    const pane = V.ensurePane(LIVE, "session", "live");
    startTurn();
    fire("thinking", { delta: "d1" });
    fire("done", { text: "" });
    fire("tool", { id: "c1", name: "run_code", args: {} });
    fire("tool_result", { id: "c1", ok: true, value: "ok1" });
    fire("tool", { id: "c2", name: "run_code", args: {} });
    fire("tool_result", { id: "c2", ok: true, value: "ok2" });
    fire("thinking", { delta: "d2" });
    fire("done", { text: "" });
    fire("tool", { id: "c3", name: "run_code", args: {} });
    fire("tool_result", { id: "c3", ok: true, value: "ok3" });
    fire("tool", { id: "c4", name: "run_code", args: {} });
    fire("tool_result", { id: "c4", ok: true, value: "ok4" });
    fire("text", { delta: "最终回答" });
    fire("done", { text: "最终回答" });

    const kinds = kindsOf(pane.el);
    expect(kinds).toEqual(["thinking", "tool", "tool", "thinking", "tool", "tool", "assistant"]);
    const thinkIdx = kinds.map((k, i) => (k === "thinking" ? i : -1)).filter((i) => i >= 0);
    expect(thinkIdx).toHaveLength(2);
    expect((thinkIdx[1] ?? 0) - (thinkIdx[0] ?? 0)).toBeGreaterThan(1); // 互不相邻
    // 核心：每段只装自己那一步的 reasoning（旧实现里第一段会是 d1d2）
    expect(thinkBodies(pane.el)).toEqual(["d1", "d2"]);
  });

  it("done 帧被丢时，tool 帧兜底收尾（单工具步版）", async () => {
    const { V } = await boot();
    const pane = V.ensurePane(LIVE, "session", "live");
    startTurn();
    fire("thinking", { delta: "d1" });
    fire("done", { text: "" });
    fire("tool", { id: "c1", name: "run_code", args: {} });
    fire("tool_result", { id: "c1", ok: true, value: "ok1" });
    fire("thinking", { delta: "d2" });
    // 这一步的 done 故意不发：tool 帧必须兜底把 d2 段收尾
    fire("tool", { id: "c2", name: "run_code", args: {} });
    fire("tool_result", { id: "c2", ok: true, value: "ok2" });
    fire("text", { delta: "回答" });
    fire("done", { text: "回答" });

    expect(kindsOf(pane.el)).toEqual(["thinking", "tool", "thinking", "tool", "assistant"]);
    expect(thinkBodies(pane.el)).toEqual(["d1", "d2"]);
  });
});

describe("W847 · 单步回归（思考 → 文本 → done）", () => {
  it("恰好 1 个思考段、在文本段之前、结束折回默认折叠态", async () => {
    const { V } = await boot();
    const pane = V.ensurePane(LIVE, "session", "live");
    startTurn();
    fire("thinking", { delta: "只思考一次" });
    fire("text", { delta: "唯一回答" });
    fire("done", { text: "唯一回答" });

    expect(kindsOf(pane.el)).toEqual(["thinking", "assistant"]);
    const seg = pane.el.querySelector(".msg.think-seg");
    expect(seg).not.toBeNull();
    expect(seg!.classList.contains("collapsed"), "段结束自动折回默认折叠").toBe(true);
    expect(seg!.querySelector(".think-fold-mark")!.getAttribute("data-fold")).toBe("collapsed");
    expect(seg!.querySelector(".think-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(seg!.querySelector(".think-seg-body")!.textContent).toBe("只思考一次");
  });
});

describe("W847 · 实时 ↔ 重放一致性（核心验收）", () => {
  it("同一轮实时序列与历史重放行的 kind 序列完全相等", async () => {
    const { V, restore } = await boot();
    // (a) 实时路径
    const live = V.ensurePane(LIVE, "session", "live");
    startTurn();
    fire("thinking", { delta: "d1" });
    fire("done", { text: "" });
    fire("tool", { id: "c1", name: "run_code", args: {} });
    fire("tool_result", { id: "c1", ok: true, value: "ok" });
    fire("tool", { id: "c2", name: "run_code", args: {} });
    fire("tool_result", { id: "c2", ok: true, value: "ok" });
    fire("thinking", { delta: "d2" });
    fire("done", { text: "" });
    fire("tool", { id: "c3", name: "run_code", args: {} });
    fire("tool_result", { id: "c3", ok: true, value: "ok" });
    fire("tool", { id: "c4", name: "run_code", args: {} });
    fire("tool_result", { id: "c4", ok: true, value: "ok" });
    fire("text", { delta: "最终回答" });
    fire("done", { text: "最终回答" });

    // (b) 重放路径（真实 restoreSessionHistory + 真实渲染器）
    const replay = V.ensurePane(REPLAY, "session", "replay");
    await restore.restoreSessionHistory(replay);

    const liveKinds = kindsOf(live.el);
    const replayKinds = kindsOf(replay.el);
    expect(replayKinds).toEqual(liveKinds);
    expect(replayKinds).toEqual(["thinking", "tool", "tool", "thinking", "tool", "tool", "assistant"]);
  });
});
