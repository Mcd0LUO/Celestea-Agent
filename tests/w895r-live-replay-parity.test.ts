// @vitest-environment jsdom
/**
 * W895-R — 实时流与历史重放必须产出**逐字相同**的 DOM。
 *
 * 为什么需要这条：这类 bug 已出现三次（W847 思考段分段、W895-C2 的 tail 重挂），
 * 且**只在实时路径上出现** —— 靠人看截图发现太亏。这里用**同一段文本**分别跑两条
 * 真实路径（实时 = 真 SSE 逐帧；重放 = 真 /messages 历史），断言 DOM 相同。
 *
 * 对抗条件：注册一个**会移动节点**的增强遍（把 pre 包进 .code-wrap 再搬进 <details>）。
 * 这正是 W895-C2 的 csv-table 的真实形态（json-tree 已移除）。旧实现按节点引用记账，第二拍就把
 * 内容从新父节点里摘走（留下空壳）；边界哨兵下无害 —— 本用例就是那个不变量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, HTML, resetHarness } from "./lib/w795-dom.js";

const LIVE = "session-1";
let lastES: { fire(n: string, p: Record<string, unknown>): void } | null = null;
class FakeES {
  onmessage: ((e: unknown) => void) | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() { lastES = this as unknown as { fire(n: string, p: Record<string, unknown>): void }; }
  addEventListener(n: string, f: (e: unknown) => void): void { (this.listeners[n] ??= []).push(f); }
  close(): void {}
  fire(name: string, payload: Record<string, unknown>): void {
    for (const f of this.listeners[name] ?? []) f({ data: JSON.stringify(payload) });
  }
}

/** 实时文本（会同时作为重放的历史正文，保证两边同一段文本）。 */
const TEXT = [
  "先一段说明文字。",
  "",
  "```json",
  '{"name":"a","items":[1,2,{"deep":true}]}',
  "```",
  "",
  "结尾文字。",
  "",
].join("\n");

/** 把 TEXT 切成逐帧 delta（用于实时路径）。 */
function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/**
 * 会移动节点的增强遍：pre -> .code-wrap -> <details>（W895-C2 的真实形态）。
 * 类型用最宽松的写法：根 tsconfig 没有 DOM lib（见 AGENT.md §7），前端 DOM 测试一律经
 * w795-dom 夹具访问，这里只用夹具的 ElLike 形状，不引入 DOM 类型名。
 */
interface LooseEl {
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  parentNode: LooseEl | null;
  className: string;
  insertBefore(n: LooseEl, ref: LooseEl): LooseEl;
  appendChild(n: LooseEl): LooseEl;
  querySelectorAll(sel: string): ArrayLike<LooseEl>;
}
const MOVER = {
  id: "test.mover",
  enhance(c: unknown): void {
    const root = c as unknown as LooseEl;
    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.getAttribute("data-moved") === "1") continue;
      pre.setAttribute("data-moved", "1");
      const wrap = doc.createElement("div") as unknown as LooseEl;
      wrap.className = "code-wrap";
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const details = doc.createElement("details") as unknown as LooseEl;
      details.className = "moved-raw";
      wrap.parentNode?.insertBefore(details, wrap);
      details.appendChild(wrap);
    }
  },
};

async function boot(replayRows: unknown[]): Promise<{ V: any; chat: any; restore: any; enhance: any }> {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", async (url: unknown) => {
    if (String(url).indexOf("/messages") !== -1) {
      return { ok: true, status: 200, json: async () => ({ messages: replayRows }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, questions: [] }) };
  });
  const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as any;
  V.initViewCtx();
  const enhance = (await import(/* @vite-ignore */ at("ui/enhance/registry.ts"))) as any;
  const chat = (await import(/* @vite-ignore */ at("chat.ts"))) as any;
  const restore = (await import(/* @vite-ignore */ at("ui/restore.ts"))) as any;
  chat.connectSse();
  return { V, chat, restore, enhance };
}

/** 移除增强遍留下的包装，只比较「渲染器自己的输出」结构。 */
function unwrap(html: string): string {
  return html
    .replace(/<details class="moved-raw">/g, "")
    .replace(/<\/details>/g, "")
    .replace(/<div class="code-wrap">/g, "")
    .replace(/<\/div>/g, "")
    .replace(/ data-moved="1"/g, "");
}

beforeEach(() => { resetHarness(); lastES = null; });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe("W895-R 实时 vs 重放一致性", () => {
  it("逐帧实时（每帧都移动节点）与一次性重放产出相同正文 DOM", async () => {
    // ── 实时：真 SSE 逐帧 ─────────────────────────────────────────
    const live = await boot([]);
    const off = live.enhance.registerEnhancer(MOVER);
    const pane = live.V.ensurePane(LIVE, "session", "live");
    lastES!.fire("status", { phase: "start", statusline: {}, session: LIVE });
    for (const d of chunks(TEXT, 12)) lastES!.fire("text", { delta: d, session: LIVE });
    lastES!.fire("done", { text: TEXT, session: LIVE });
    await flush();
    const liveContent = pane.el.querySelector(".msg.assistant .content") as any;
    expect(liveContent).not.toBeNull();
    const liveHtml = unwrap(liveContent.innerHTML);
    const liveText = liveContent.textContent ?? "";
    off();

    // ── 重放：真 /messages 历史（同一段文本） ─────────────────────
    const replay = await boot([{ role: "assistant", content: TEXT }]);
    replay.enhance.registerEnhancer(MOVER);
    const pane2 = replay.V.ensurePane(LIVE, "session", "live");
    await replay.restore.restoreSessionHistory(pane2);
    await flush();
    const replayContent = pane2.el.querySelector(".msg.assistant .content") as any;
    expect(replayContent).not.toBeNull();
    const replayHtml = unwrap(replayContent.innerHTML);
    const replayText = replayContent.textContent ?? "";

    expect(liveText).toBe(replayText);
    expect(liveHtml).toBe(replayHtml);
  });

  it("中间帧必须**累积**内容（旧实现会把早期内容从新父节点摘走）", async () => {
    const live = await boot([]);
    const off = live.enhance.registerEnhancer(MOVER);
    const pane = live.V.ensurePane(LIVE, "session", "live");
    lastES!.fire("status", { phase: "start", statusline: {} });
    const marks: string[] = [];
    for (const d of chunks(TEXT, 12)) {
      lastES!.fire("text", { delta: d, session: LIVE });
      await flush();
      const c = pane.el.querySelector(".msg.assistant .content") as any;
      marks.push(c?.textContent ?? "");
    }
    off();
    // 不变量：**说明文字**（围栏外、每拍都在）绝不可丢；且末拍必须完整。
    // 不比对「半开围栏」的中间拍 —— 未闭合的 ``` 本来就会被 marked 渲染成不同结果，
    // 那是 markdown 语义，不是本 bug。（旧实现是在**任何**代码块附近都会丢整段。）
    const bad: string[] = [];
    for (let i = 0; i < marks.length; i += 1) {
      if (!(marks[i] ?? "").includes("先一段说明文字。")) bad.push("tick " + i + " 丢了前置说明文字");
    }
    expect(bad).toEqual([]);
    const final = marks[marks.length - 1] ?? "";
    expect(final).toContain("先一段说明文字。");
    expect(final).toContain("结尾文字。");
  });
});
