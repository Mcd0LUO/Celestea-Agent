// @vitest-environment jsdom
/**
 * W847 续作 · ①图片入口收进发送框内联图标 / ②手机端取消键可见性
 *
 * 本机没有可用 headless 浏览器（tests/ 全是 jsdom + CSS 规则文本断言，无布局引擎），
 * 因此本文件钉的是：
 *   · DOM 结构真源（真实 index.html + 真实 ui/inputbar.ts 模块行为）；
 *   · CSS 规则真源（flex/overflow/min-width/绝对定位等布局**必要条件**）。
 * 真实可见性（②取消键是否真的回到屏内）只能靠用户手机复验 —— 见报告。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ClassListLike {
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
  hidden: boolean;
  disabled: boolean;
  /** W1513：按钮去掉可见文字后，语义改由 title / aria-label 承载，故进夹具类型。 */
  title: string;
  classList: ClassListLike;
  style: Record<string, unknown>;
  children: ArrayLike<ElLike>;
  childElementCount: number;
  parentElement: ElLike | null;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  closest(sel: string): ElLike | null;
}
interface DocLike {
  body: ElLike & { innerHTML: string };
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
const indexHtml = (): string => readFileSync(join(WEB, "index.html"), "utf8");

const doc = (globalThis as unknown as { document: DocLike }).document;

/** 取某选择器最后一条规则体（后写的规则才是生效的那条）。 */
function rule(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const all = [...cssText.matchAll(new RegExp(esc + "\\s*\\{([^}]*)\\}", "g"))];
  expect(all.length, "找不到规则：" + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? "";
}

/** 取某个 @media (max-width: Npx) 块的完整正文（大括号配对）。 */
function mediaBlock(cssText: string, px: number): string {
  const m = new RegExp("@media\\s*\\(max-width:\\s*" + px + "px\\)\\s*\\{").exec(cssText);
  expect(m, "找不到 @media max-width:" + px + "px").not.toBeNull();
  let i = (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length;
  let depth = 1;
  const start = i;
  while (i < cssText.length && depth > 0) {
    const ch = cssText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return cssText.slice(start, i - 1);
}

function clsOf(el: ElLike): string {
  const raw: unknown = el.className;
  if (typeof raw === "string") return raw;
  const base = (raw as { baseVal?: unknown } | null)?.baseVal;
  return typeof base === "string" ? base : "";
}

/** 真实 index.html 的 <body> 内容（与运行时同构，非自造夹具）。 */
function realBody(): string {
  const html = indexHtml();
  return html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
}

function stubNet(): void {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, capabilities: { multimodal: true }, model: "glm-5.3-flash" }),
  }));
}

beforeEach(() => {
  doc.body.innerHTML = realBody();
  vi.resetModules();
  stubNet();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W847 · ② 右端集群 .sl-end（DOM 结构真源）", () => {
  it("#btnMode / #slGrant / #slHint 都在 .sl-end 内；.sl-spacer 已移除", () => {
    doc.body.innerHTML = realBody();
    expect((doc.getElementById("btnMode") as ElLike).closest(".sl-end")).not.toBeNull();
    expect((doc.getElementById("slGrant") as ElLike).closest(".sl-end")).not.toBeNull();
    expect((doc.getElementById("slHint") as ElLike).closest(".sl-end")).not.toBeNull();
    expect(indexHtml()).not.toContain('class="sl-spacer"');
  });

  it("W1512：终止键**不再**挂在 statusline —— 它已并入输入栏的 #btnSend（两态）", () => {
    // 这正是用户报障的修法：statusline 右端在窄屏会被模型名/用量/车道键挤出视口，
    // 于是「终止」看不见。并入输入栏后它恒在可见位置，且不再与 statusline 抢宽度。
    doc.body.innerHTML = realBody();
    expect(doc.getElementById("slStop"), "statusline 上不应再有独立终止键").toBeNull();
    const send = doc.getElementById("btnSend") as ElLike;
    expect(send, "#btnSend 必须存在（发送/终止两态）").not.toBeNull();
    expect(send.closest(".input-side"), "两态按钮在输入栏内").not.toBeNull();
    expect(send.closest("#statusline"), "两态按钮不再属于 statusline").toBeNull();
  });
});

describe("W847 · ② CSS 必要条件（代码断言，无真实渲染）", () => {
  it(".sl-end flex:0 0 auto + margin-left:auto；.sl-ctx 可压缩；.sl-row-main 有裁剪", () => {
    const sl = css("statusline.css");
    const end = rule(sl, ".sl-end");
    expect(end).toContain("flex: 0 0 auto");
    expect(end).toContain("margin-left: auto");
    const ctx = rule(sl, ".sl-ctx");
    expect(ctx, ".sl-ctx 必须可压缩").toContain("min-width: 0");
    expect(ctx).toContain("overflow: hidden");
    expect(ctx).toContain("text-overflow: ellipsis");
    expect(rule(sl, ".sl-row-main")).toContain("overflow: hidden");
  });

  it("≤640 车道键只留内联图标（~32px、文字视觉隐藏）", () => {
    const mobile = mediaBlock(css("responsive.css"), 640);
    expect(mobile, "≤640 必须给 #btnMode 收窄").toMatch(/#btnMode\s*\{[^}]*min-width:\s*32px/);
    expect(mobile).toMatch(/#btnMode\s+\.sl-mode-icon\s*\{[^}]*display:\s*block/);
    expect(mobile).toMatch(/#btnMode\s+\.sl-mode-label\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/);
    // 桌面仍显示文字图标（逐像素不变）：基态 .sl-mode-icon 必须隐藏
    expect(rule(css("statusline.css"), ".sl-mode-icon")).toContain("display: none");
    // 真实 index.html 里图标与文字标签都在（JS 只改 label 文本）
    expect(indexHtml()).toContain("sl-mode-icon");
    expect(indexHtml()).toContain("sl-mode-label");
  });
});

describe("W847 · ① 图片入口内联（DOM 结构真源）", () => {
  it("index.html：.input-box 包住 #input，.input-side 只有 #btnSend；#btnAttach 由 JS 注入", () => {
    doc.body.innerHTML = realBody();
    const box = doc.querySelector(".input-box") as ElLike;
    expect(box).not.toBeNull();
    expect(box.querySelector("#input")).not.toBeNull();
    const side = doc.querySelector(".input-side") as ElLike;
    expect(Array.from(side.children).map((c) => c.id)).toEqual(["btnSend"]);
    expect(indexHtml()).not.toContain('id="btnAttach"'); // 仍由 JS 注入（能力位语义不变）
  });

  it("CSS：.input-box 定位上下文 + #btnAttach.attach-inline 绝对定位（出流）", () => {
    const layout = css("layout.css");
    expect(rule(layout, ".input-box")).toContain("position: relative");
    expect(rule(layout, ".input-box")).toContain("flex: 1 1 auto");
    const btn = rule(layout, "#btnAttach.attach-inline");
    expect(btn).toContain("position: absolute");
    expect(btn).toContain("width: 28px");
    // ≤1024 触控档命中区 ≥ --tap-min
    const tablet = mediaBlock(css("responsive.css"), 1024);
    expect(tablet).toMatch(/#btnAttach\.attach-inline\s*\{[^}]*width:\s*var\(--tap-min\)/);
  });
});

describe("W847 · ① 真实模块行为（jsdom）", () => {
  it("#btnAttach 注入 .input-box（不在 .input-side），带内联回形针 SVG 与无障碍名；取消键语义不变", async () => {
    doc.body.innerHTML = realBody();
    const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): void;
    };
    view.initViewCtx();
    const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as {
      initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
      setBusy(busy: boolean): void;
      setSubmitMode(m: "steer" | "queue"): void;
    };
    bar.initInputBar({ send: () => {}, cancel: () => {} });

    const side = doc.querySelector("#inputbar .input-side") as ElLike;
    expect(Array.from(side.children).map((c) => c.id), ".input-side 恒为 [发送]").toEqual(["btnSend"]);

    const btn = doc.getElementById("btnAttach") as ElLike;
    expect(btn).not.toBeNull();
    expect(clsOf(btn.parentElement as ElLike)).toContain("input-box"); // 在框内（出流）
    expect(btn.closest(".input-side")).toBeNull();
    expect(btn.querySelector("svg"), "内联 SVG 回形针").not.toBeNull();
    expect((btn.getAttribute("aria-label") || "").length).toBeGreaterThan(0);

    // W1512：终止并入 #btnSend 的运行态 —— 语义不变（运行中才是终止），
    // 但形态从「另一个隐藏键」变成「同一控件的另一个状态」，因此**恒可见**。
    // W1513：按钮只剩图标，语义改由 title / aria-label 承载（不再有可见文字）。
    const send = doc.getElementById("btnSend") as ElLike;
    bar.setBusy(true);
    expect(send.classList.contains("running"), "运行中 → 终止态").toBe(true);
    expect(send.classList.contains("hidden"), "终止态不再靠 hidden 切换（恒可见）").toBe(false);
    expect(send.title || "", "运行态语义 = 终止").toContain("终止");
    expect(send.getAttribute("aria-label") || "", "无障碍名同步为终止").toContain("终止");
    bar.setBusy(false);
    expect(send.classList.contains("running"), "空闲 → 发送态").toBe(false);
    expect(send.title || "", "空闲态语义 = 发送").toContain("发送");

    // 车道键文案落在 label（图标按钮仍保留文本无障碍名）
    bar.setSubmitMode("queue");
    expect((doc.querySelector("#btnMode .sl-mode-label") as ElLike).textContent).toBe("排队");
    expect((doc.getElementById("btnMode") as ElLike).textContent).toContain("排队");
  });
});
