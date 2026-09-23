// @vitest-environment jsdom
/**
 * W790 · 前端批 B / item 3：聚焦会话条并入 statusline（+ 会话树可见状态点）。
 *
 * 本机**没有浏览器**（jsdom 不套样式表、无排版），所以分两口径断言：
 *   · CSS/结构真源：读 styles/*.css 与 index.html 的**原文**，钉住「并入既有行、
 *     不新增行高」的几何前提（行 min-height 16px、会话条可收缩、chip ≤15px）；
 *   · 行为：加载**真实模块**（pathToFileURL 动态 import，不是复刻逻辑），驱动真实
 *     DOM 事件 —— 会话条上的入口真的把视图切到另一个运行中的会话。
 *
 * 仍未覆盖：真实浏览器的观感与像素级几何（见报告「诚实边界」）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ClassList {
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
  contains(c: string): boolean;
}
interface ElLike {
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  innerHTML: string;
  hidden: boolean;
  value: string;
  style: Record<string, unknown>;
  classList: ClassList;
  dataset: Record<string, string | undefined>;
  childElementCount: number;
  children: ArrayLike<ElLike>;
  parentElement: ElLike | null;
  previousElementSibling: ElLike | null;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  contains(n: unknown): boolean;
  closest(sel: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface DocLike {
  body: ElLike;
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
const src = (rel: string): string => readFileSync(join(WEB, "src", rel), "utf8");

/** 取某选择器**最后一条**规则体（后写的规则才是生效的那条）。 */
function rule(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...cssText.matchAll(new RegExp(esc + "\\s*\\{([^}]*)\\}", "g"))];
  expect(all.length, "找不到规则：" + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? "";
}

const doc = (globalThis as unknown as { document: DocLike }).document;

/** 与 index.html 同构的最小骨架（W790：会话条已在 statusline 的次行里）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages" tabindex="-1"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-badge" id="slGrantBadge"></span>' +
  '<span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div><span class="sl-sep">·</span>' +
  '<span class="sl-tps" id="slTps">— tok/s</span><span class="sl-sep">·</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-sep">·</span>' +
  '<span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea><div class="input-side">' +
  '<button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnCancel" class="btn btn-soft hidden">取消</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const el = (tag: string): ElLike => doc.createElement(tag);


// ============================================================================
// item 3 · 聚焦会话条并入 statusline
// ============================================================================

describe("W790 · item 3 结构：会话条在 statusline 的既有行内（真实 index.html）", () => {
  // W1462：用户要求「会话名 · 空闲 · tok/s · 第 N 轮 放到消息框胶囊外的底部平铺，灰色不显眼」
  // ⇒ 会话条随整条低频信息移出 #statusline（胶囊），住进胶囊下方的贴底信息行 #statusbar。
  it("index.html 里 #sessionBar 挂在贴底信息行 #statusbar（不再是 #messages 上方独立一行，也不再在胶囊里）", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    doc.body.innerHTML = body;
    const bar = doc.getElementById("sessionBar");
    expect(bar, "index.html 必须仍有 #sessionBar").not.toBeNull();
    expect(bar?.closest("#statusbar"), "会话条必须挂在贴底信息行里").not.toBeNull();
    expect(bar?.closest(".chat-shell"), "会话条必须在胶囊**之外**（W1462：信息出框）").toBeNull();
  });

  it("几何前提：该行 min-height 16px、会话条可收缩、chip ≤15px（并入不新增行高）", () => {
    const sl = css("statusline.css");
    expect(rule(sl, ".sl-row")).toContain("min-height: 16px");
    const bar = rule(css("views.css"), ".session-bar");
    expect(bar).toContain("flex: 0 1 auto"); // 空间不足时先压会话条（不是把右端挤出界）
    expect(bar).toContain("min-width: 0");
    expect(bar).toContain("overflow: hidden");
    expect(bar).toContain("padding: 0"); // 原来独占一行时的 5px 14px 内边距已去掉
    const chip = rule(css("views.css"), ".sess-bar-chip");
    expect(chip).toContain("line-height: 13px"); // 13 + 上下边框各 1 = 15 ≤ 16：不撑高
    expect(chip).toContain("padding: 0 8px");
    expect(rule(css("views.css"), ".sess-bar-others")).toContain("white-space: nowrap");
  });

  it("并入后不再有横向滚动条（滚动条会撑高这个 16px 的行）", () => {
    const resp = rule(css("responsive.css"), "#sessionBar");
    expect(resp).toContain("overflow: hidden");
    expect(resp).not.toContain("overflow-x: auto");
  });
});

describe("W790 · item 3 行为：一键切换到任一运行中会话（W514 语义保留）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, questions: [] }),
      text: async () => "",
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it("会话条写在既有行内：显示聚焦会话名/运行态，并为**其它**运行中会话各给一个入口，点一下切过去", async () => {
    const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): unknown;
      ensurePane(id: string, kind?: string, title?: string): { el: ElLike; streaming: boolean };
      activatePane(id: string, kind?: string, title?: string): unknown;
      setPaneStreaming(p: unknown, on: boolean): void;
      activeSessionId(): string;
      paneOf(id: string): { el: ElLike } | undefined;
    };
    ctx.initViewCtx();
    const a = ctx.ensurePane("ws/s1", "session", "甲会话");
    const b = ctx.ensurePane("ws/s2", "worker", "乙会话");
    ctx.activatePane("ws/s1", "session", "甲会话");
    ctx.setPaneStreaming(a, true); // 聚焦会话运行中（本地轮次）
    ctx.setPaneStreaming(b, true); // 另一个会话也在跑 → 应出现在「其它运行中」入口里

    const sb = (await import(/* @vite-ignore */ at("ui/sessionbar.ts"))) as {
      initSessionBar(): void;
      updateSessionBar(): void;
    };
    sb.initSessionBar();
    sb.updateSessionBar();

    const bar = doc.getElementById("sessionBar") as ElLike;
    expect(bar.querySelector(".sess-bar-name")?.textContent).toBe("甲会话");
    // W846：聚焦会话「运行中」的**文字**由 #statusText 单点表达（避免同一状态出现两次）；
    // 会话条只留状态点（.busy → ::before 绿点 + 呼吸，W790 语义不变）。
    const state = bar.querySelector(".sess-bar-state") as ElLike;
    expect(state.textContent).toBe("");
    expect(state.classList.contains("busy")).toBe(true);
    expect(bar.querySelector(".sess-bar-kind")?.classList.contains("hidden")).toBe(true);

    const chips = Array.from(bar.querySelectorAll(".sess-bar-chip"));
    expect(chips.map((c) => c.textContent)).toEqual(["乙会话"]); // 只列「其它」运行中会话
    expect(chips[0]?.title).toContain("切换到");

    chips[0]?.click(); // 一键切换
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.activeSessionId()).toBe("ws/s2");
    expect(ctx.paneOf("ws/s2")?.el.hidden).toBe(false);
    expect(ctx.paneOf("ws/s1")?.el.hidden).toBe(true);
  });

  it("没有其它会话在跑时不给入口（不占位、不写死按钮）", async () => {
    const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): unknown;
      ensurePane(id: string, kind?: string, title?: string): { el: ElLike; streaming: boolean };
      activatePane(id: string, kind?: string, title?: string): unknown;
      setPaneStreaming(p: unknown, on: boolean): void;
    };
    ctx.initViewCtx();
    const a = ctx.ensurePane("ws/s1", "session", "甲会话");
    ctx.activatePane("ws/s1", "session", "甲会话");
    ctx.setPaneStreaming(a, true);
    const sb = (await import(/* @vite-ignore */ at("ui/sessionbar.ts"))) as {
      initSessionBar(): void;
      updateSessionBar(): void;
    };
    sb.initSessionBar();
    sb.updateSessionBar();
    expect(Array.from(bar0().querySelectorAll(".sess-bar-chip"))).toHaveLength(0);
    expect(bar0().textContent).toContain("甲会话");
  });

  function bar0(): ElLike {
    return doc.getElementById("sessionBar") as ElLike;
  }
});

describe("W790 · item 3 会话树：可见状态点（绿点）+ 提示不再写原生 title", () => {
  it("运行态点：空闲=静态灰点、运行中=--c-live 绿点 + 光晕（可见，不靠 title）", () => {
    const views = css("views.css");
    expect(rule(views, ".sess-dot")).toContain("var(--c-text-3)");
    const busy = rule(views, ".sess-dot.busy");
    expect(busy).toContain("background: var(--c-live)");
    expect(busy).toContain("box-shadow: 0 0 0 2px var(--c-live-dim)");
    expect(busy).toContain("animation: pulse"); // 运行中 = 活动
    expect(css("tokens.css")).toContain("--c-live:");
    expect(css("tokens.css")).toContain("--c-live-dim:");
    // statusline 会话条的运行态点用同一语义色（两处状态点语义一致）
    expect(rule(views, ".sess-bar-state.busy::before")).toContain("var(--c-live)");
  });

  it("指定迁移的 4 处原生 title 已收敛到注册缝（setHint），rail 不再自建卡片定时器", () => {
    const render = src("ui/sessiontree/render.ts");
    expect(render).not.toContain("dot.title =");
    expect(render).not.toContain("leaf.title =");
    expect(render).toContain("setHint(dot,");
    expect(render).toContain("setHint(leaf,");
    const live = src("ui/sessiontree/live.ts");
    expect(live).not.toContain("d.title =");
    expect(live).toContain("setHint(d,");
    const rail = src("ui/rail.ts");
    expect(rail).not.toContain(".title = ");
    expect(rail).not.toContain("PREVIEW_MS");
    expect(rail).toContain("registerHintPlugin(railHintPlugin())");
    expect(rail).toContain("hoverHint(hit.el)");
  });
});
