// @vitest-environment jsdom
/**
 * W846 · 移动端输入栏几何不变量 + 运行态文案收敛
 *
 * 缺陷 1：运行态曾把 #btnMode / #btnCancel 从 .hidden 变可见 → .input-side 变宽，
 *   把 flex 的 #input 挤窄（headless Blink 实测 390px：宽 226→102，附件入口可见时）。
 *   修法：运行态控制移出 .input-side（#btnMode → statusline 第 1 行；取消由本就存在、
 *   共用同一回调的 #slStop 单点承担），.input-side 两态恒为 [图片][发送]。
 * 缺陷 2：运行态「运行中」文字同时出现在会话条 .sess-bar-state 与 statusbar
 *   #statusText（占位符还带前缀）→ 收敛为 #statusText 单点表达，会话条只留 W790
 *   的状态点（.busy → ::before 绿点 + 呼吸）。
 *
 * jsdom 无排版：本文件钉的是「结构 / CSS 真源的**必要条件**」（真实模块 +
 *   真实 index.html / styles 原文）。像素级几何由 headless Blink 实测（见报告）。
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
  innerHTML: string;
  value: string;
  title: string;
  placeholder: string;
  hidden: boolean;
  classList: ClassList;
  style: Record<string, unknown>;
  childElementCount: number;
  children: ArrayLike<ElLike>;
  parentElement: ElLike | null;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
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
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
/** 取某选择器**最后一条**规则体（后写的规则才是生效的那条）。 */
function rule(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const all = [...cssText.matchAll(new RegExp(esc + "\\s*\\{([^}]*)\\}", "g"))];
  expect(all.length, "找不到规则：" + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? "";
}

const doc = (globalThis as unknown as { document: DocLike }).document;

/** 与 index.html 同构的最小骨架（W846：#btnMode 在 statusline 第 1 行）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-badge" id="slGrantBadge"></span>' +
  '<span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="btnMode" class="sl-mode-btn hidden" type="button">插话</button>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">— tok/s</span><span class="sl-sep">·</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-sep">·</span>' +
  '<span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText">连接中…</span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><div class="input-box"><textarea id="input" rows="2"></textarea></div>' +
  '<div class="input-side"><button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const sideIds = (): string[] => {
  const side = doc.querySelector("#inputbar .input-side") as ElLike;
  return Array.from(side.children).map((c) => c.id);
};

beforeEach(() => {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W846 · 结构真源（真实 index.html）", () => {
  it("运行态控制全在 statusline 第 1 行；.input-side 恒为 [发送]；#btnCancel 已移除", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    doc.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const mode = doc.getElementById("btnMode");
    const stop = doc.getElementById("slStop");
    expect(mode, "index.html 必须仍有 #btnMode").not.toBeNull();
    expect(mode?.closest("#statusline"), "#btnMode 必须落在 statusline 里").not.toBeNull();
    expect(mode?.closest(".input-side"), "#btnMode 不得再在输入栏里（会抢 #input 宽度）").toBeNull();
    expect(stop?.closest("#statusline")).not.toBeNull();
    expect(stop?.closest(".input-side")).toBeNull();
    expect(doc.getElementById("btnCancel"), "取消入口已收敛到 #slStop").toBeNull();
  });
});

describe("W846 · CSS 真源", () => {
  it(".input-side 不再引用运行态按钮；车道键不撑高 statusline 行", () => {
    const layout = css("layout.css");
    expect(rule(layout, ".input-side")).toContain("flex-direction: row");
    expect(layout).not.toContain("#btnCancel");
    const mode = rule(css("statusline.css"), ".sl-mode-btn");
    expect(mode).toContain("flex: 0 0 auto");
    expect(mode).toContain("height: 16px");
    // ≤1024 触控档：#btnMode 抬到 --tap-min（与 .sl-stop 同高，行高不变）
    const resp = css("responsive.css");
    expect(resp).toMatch(/#btnMode\s*\{/);
    expect(resp).not.toContain("#btnCancel");
    expect(rule(resp, ".sl-row-main")).toContain("min-height: var(--tap-min)");
  });

  it("会话条状态点保留（W790），但「运行中」文字已从会话条/占位符移除", () => {
    expect(rule(css("views.css"), ".sess-bar-state.busy::before")).toContain("var(--c-live)");
    const src = readFileSync(join(WEB, "src", "ui", "sessionbar.ts"), "utf8");
    expect(src).not.toContain("'运行中'");
    expect(src).not.toContain('"运行中"');
    const bar = readFileSync(join(WEB, "src", "ui", "inputbar.ts"), "utf8");
    expect(bar).not.toContain("运行中 · Enter");
  });
});

describe("W846 · 发送前后结构不变量（真实模块）", () => {
  it("setBusy/setInputMode 不给 .input-side 增删节点；运行态控制都在 statusline", async () => {
    const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as {
      initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
      setBusy(busy: boolean): void;
      setInputMode(mode: string): void;
    };
    bar.initInputBar({ send: () => {}, cancel: () => {} });
    const before = sideIds();
    // W847：#btnAttach 已收进 .input-box（内联图标、出流），.input-side 恒为 [发送]。
    expect(before).toEqual(["btnSend"]);
    expect(
      (doc.querySelector("#inputbar .input-box") as ElLike).querySelector("#btnAttach"),
    ).not.toBeNull();
    bar.setBusy(true);
    bar.setInputMode("interject");
    expect(sideIds()).toEqual(before); // 结构逐节点不变 ⇒ #input 宽度不因子节点变化
    expect((doc.getElementById("btnMode") as ElLike).classList.contains("hidden")).toBe(false);
    expect((doc.getElementById("btnMode") as ElLike).closest(".input-side")).toBeNull();
    expect((doc.getElementById("slStop") as ElLike).classList.contains("hidden")).toBe(false);
    bar.setBusy(false);
    bar.setInputMode("idle");
    expect(sideIds()).toEqual(before);
  });
});

describe("W846 · 运行态文案只出现一次（真实模块）", () => {
  it("单个运行中会话：状态区「运行中」只由 #statusText 表达", async () => {
    const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): unknown;
      ensurePane(id: string, kind?: string, title?: string): unknown;
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
    const st = (await import(/* @vite-ignore */ at("ui/statusbar.ts"))) as { setStatus(t: string, c?: string): void };
    st.setStatus("运行中…", "busy");

    const state = doc.querySelector("#sessionBar .sess-bar-state") as ElLike;
    expect(state.textContent, "会话条只留状态点，不再重复「运行中」").toBe("");
    expect(state.classList.contains("busy"), "W790 状态点仍在").toBe(true);
    expect((doc.getElementById("statusText") as ElLike).textContent).toBe("运行中…");

    const region = (doc.getElementById("statusline") as ElLike).textContent ?? "";
    const footer = (doc.getElementById("statusbar") as ElLike).textContent ?? "";
    expect((region + footer).split("运行中").length - 1, "整个状态区只出现一次").toBe(1);

    const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as { setInputMode(m: string): void };
    bar.setInputMode("interject");
    expect((doc.getElementById("input") as ElLike).placeholder).not.toContain("运行中");
  });

  it("多会话运行：会话条保留聚焦会话 + 其它运行中入口（W514/W790 语义不破）", async () => {
    const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): unknown;
      ensurePane(id: string, kind?: string, title?: string): ElLike;
      activatePane(id: string, kind?: string, title?: string): unknown;
      setPaneStreaming(p: unknown, on: boolean): void;
      activeSessionId(): string;
      paneOf(id: string): { el: ElLike } | undefined;
    };
    ctx.initViewCtx();
    const a = ctx.ensurePane("ws/s1", "session", "甲会话");
    const b = ctx.ensurePane("ws/s2", "worker", "乙会话");
    ctx.activatePane("ws/s1", "session", "甲会话");
    ctx.setPaneStreaming(a, true);
    ctx.setPaneStreaming(b, true);
    const sb = (await import(/* @vite-ignore */ at("ui/sessionbar.ts"))) as {
      initSessionBar(): void;
      updateSessionBar(): void;
    };
    sb.initSessionBar();
    sb.updateSessionBar();
    const bar = doc.getElementById("sessionBar") as ElLike;
    expect(bar.querySelector(".sess-bar-name")?.textContent).toBe("甲会话");
    expect((bar.querySelector(".sess-bar-state") as ElLike).textContent).toBe("");
    const chips = Array.from(bar.querySelectorAll(".sess-bar-chip"));
    expect(chips.map((c) => c.textContent)).toEqual(["乙会话"]);
    expect(chips[0]?.title).toContain("切换到");
    chips[0]?.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.activeSessionId()).toBe("ws/s2");
    expect(ctx.paneOf("ws/s2")?.el.hidden).toBe(false);
  });
});
