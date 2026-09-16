// @vitest-environment jsdom
/**
 * W789 · 前端修复批 A（p0）：新建会话回车提交 / 运行态几何不变量 / 权限面板可滚动。
 *
 * 本机**没有浏览器**（只有 chrome-headless-shell 的一次性实测，见报告），所以这里
 * 用 jsdom 加载**真实模块**（不是复刻逻辑）驱动真实 DOM 事件，能断言的都断言：
 *   · CSS 真源：左对齐的共享公式、运行态不换行、输入栏按钮横排、面板滚动层；
 *   · 结构不变量：运行态（setBusy/setInputMode）只切 class，DOM 结构逐节点不变
 *     —— 几何恒定的**必要条件**（jsdom 无排版，像素级几何由 headless Blink 实测）；
 *   · 权限面板：唯一滚动层 + 内联 max-height 真的被写上 + positionPanel 绝不清空
 *     max-height（清空会让内部滚动容器的 scrollTop 被夹回 0 = 用户报的「滚不动」）
 *     + 面板内部自己的滚动不触发重新落位。
 *
 * 仍未覆盖：真实浏览器的滚轮/观感（见报告「诚实边界」一节）。
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
interface StyleLike {
  maxHeight: string;
  top: string;
  left: string;
  [k: string]: unknown;
}
interface ElLike {
  tagName: string;
  id: string;
  className: string;
  innerHTML: string;
  textContent: string | null;
  value: string;
  disabled: boolean;
  isConnected: boolean;
  style: StyleLike;
  classList: ClassList;
  childElementCount: number;
  children: ArrayLike<ElLike>;
  parentElement: ElLike | null;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  contains(n: unknown): boolean;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  getBoundingClientRect(): { top: number; right: number; bottom: number; left: number; width: number; height: number };
}
interface DocLike {
  body: ElLike;
  documentElement: ElLike;
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  dispatchEvent(e: unknown): boolean;
}

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");

/** 取某选择器**最后一条**规则体（后写的规则才是生效的那条）。 */
function rule(cssText: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...cssText.matchAll(new RegExp(esc + "\\s*\\{([^}]*)\\}", "g"))];
  expect(all.length, "找不到规则：" + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? "";
}

const doc = (globalThis as unknown as { document: DocLike }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;
const KB = (globalThis as unknown as { KeyboardEvent: new (t: string, i?: Record<string, unknown>) => unknown }).KeyboardEvent;

/** 与 index.html 同构的最小骨架（statusline 第 1 行 + 输入栏 + 会话条 + 状态栏）。 */
const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle><circle class="sl-ring-prog"></circle></svg></span>' +
  '<span class="sl-ctx" id="slCtx">—/—</span><span class="sl-sep">·</span>' +
  '<button class="sl-model" id="slModel">—</button><span class="sl-sep">·</span>' +
  '<button class="sl-effort" id="slEffort">—</button><span class="sl-sep">·</span>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-badge" id="slGrantBadge"></span><span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="slStop" class="sl-stop hidden"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"></rect></svg></button>' +
  '<span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">— tok/s</span><span class="sl-sep">·</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-sep">·</span><span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnCancel" class="btn btn-soft hidden">取消</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

/** className 取值：SVG 元素的 className 是 SVGAnimatedString（不是字符串）。 */
function clsOf(el: ElLike): string {
  const raw: unknown = el.className;
  if (typeof raw === "string") return raw;
  const base = (raw as { baseVal?: unknown } | null)?.baseVal;
  return typeof base === "string" ? base : "";
}

/** 运行态**只切 class** 时会被换掉的 class（状态标记，不是结构）：
 *  .hidden（按钮显隐）/ .interject / .readonly（ui/inputbar.setInputMode 写在 #inputbar 上）。 */
const STATE_CLASSES = new Set(["hidden", "interject", "readonly"]);

/** DOM 结构签名（忽略状态 class）——用于断言「只切 class，不改结构」。 */
function skeleton(el: ElLike | null): string {
  if (!el) return "";
  const cls = clsOf(el)
    .split(/\s+/)
    .filter((c) => c !== "" && !STATE_CLASSES.has(c))
    .sort()
    .join(".");
  const kids = Array.from(el.children ?? []).map((k) => skeleton(k));
  return "<" + el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "") + ">" + kids.join("");
}

describe("W789 · CSS 真源（标签左对齐 / 运行态不换行 / 按钮横排 / 面板滚动层）", () => {
  it("7) 两列表单标签改左对齐，且 --field-label-w 几何与顶对齐逐字保留", () => {
    const comp = css("components.css");
    const label = rule(comp, ".prov-field-label");
    expect(label).toContain("text-align: left");
    expect(label).not.toContain("text-align: right");
    expect(label).toContain("padding-top: 7px"); // 顶对齐：与控件首行齐平
    expect(rule(comp, ".prov-field")).toContain("grid-template-columns: var(--field-label-w, 148px) minmax(0, 1fr)");
    expect(rule(comp, ".prov-field")).toContain("align-items: start");
    expect(comp).not.toContain("text-align: right"); // 同一文件里不再有右对齐标签
    // 设置页同一视觉族的标签（提供商「高级」小网格）同步左对齐
    expect(rule(css("settings.css"), ".prov-adv-label")).toContain("text-align: left");
  });

  it("8) statusline 第 1 行 nowrap（运行态新增停止按钮/提示不得换行），提示可压缩省略", () => {
    const sl = css("statusline.css");
    expect(rule(sl, ".sl-row-main")).toContain("flex-wrap: nowrap");
    expect(rule(sl, ".sl-row-main")).not.toContain("flex-wrap: wrap");
    expect(rule(sl, ".sl-hint")).toContain("text-overflow: ellipsis");
    expect(rule(sl, ".sl-hint")).toContain("min-width: 0");
    // 小屏同样 nowrap，且提示不再抢整行（flex-basis:100%）
    const resp = css("responsive.css");
    expect(rule(resp, ".sl-row-main")).toContain("flex-wrap: nowrap");
    expect(rule(resp, ".sl-hint")).not.toContain("100%");
  });

  it("8) 输入栏按钮列改横排（空闲 1 个按钮与运行 3 个按钮高度相同）", () => {
    expect(rule(css("layout.css"), ".input-side")).toContain("flex-direction: row");
    expect(rule(css("layout.css"), ".input-side")).not.toContain("flex-direction: column");
  });

  it("2) 面板高度只由外层 max-height 约束，内部滚动层是 .sl-popup-body", () => {
    const grants = css("grants.css");
    expect(rule(grants, ".sl-popup.grant-popup")).toContain("overflow: hidden");
    const body = rule(grants, ".sl-popup.grant-popup .sl-popup-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0"); // flex 收缩的前提，缺了它就滚不动
    expect(body).toContain("max-height: none"); // 内层不再自带上限，交给外层夹
    // 回归护栏：positionPanel 绝不能再清空内联 max-height（那是唯一的可滚动高度来源）
    const pos = readFileSync(join(WEB, "src", "ui", "grants", "panel", "position.ts"), "utf8");
    expect(pos).not.toContain("style.maxHeight = ''");
    expect(pos).toContain("panelNaturalHeight");
  });
});

describe("W789 · 新建会话弹窗回车提交（7）", () => {
  let posts: { url: string; body: string }[];

  beforeEach(() => {
    posts = [];
    doc.body.innerHTML = HTML;
    vi.stubGlobal("fetch", async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST" && u === "/api/sessions") {
        posts.push({ url: u, body: String(init?.body ?? "") });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, id: "ws/new", sessions: [], prompts: [], available: { models: [] } }) };
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it("isSubmitEnter 只认「单行文本输入框 + 纯 Enter」", async () => {
    const Mod = (await import(/* @vite-ignore */ at("ui/sessiontree/newsession.ts"))) as {
      isSubmitEnter(e: { key: string; shiftKey: boolean; target: unknown }): boolean;
    };
    const el = (tag: string, type?: string) => ({ tagName: tag, type }) as unknown;
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("INPUT", "text") })).toBe(true);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("INPUT", "search") })).toBe(true);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("INPUT") })).toBe(true); // type 缺省 = text
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: true, target: el("INPUT", "text") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "a", shiftKey: false, target: el("INPUT", "text") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("SELECT") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("BUTTON") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("TEXTAREA") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: el("INPUT", "checkbox") })).toBe(false);
    expect(Mod.isSubmitEnter({ key: "Enter", shiftKey: false, target: null })).toBe(false);
  });

  it("标题输入框里回车 = 创建（一次请求）；Shift+Enter / 下拉里的 Enter 都不提交", async () => {
    const dlg = (await import(/* @vite-ignore */ at("ui/sessiontree/newsession.ts"))) as {
      newSessionDialog(host: { loadSessions(): Promise<void> }): void;
    };
    dlg.newSessionDialog({ loadSessions: async () => {} });
    const title = doc.querySelector(".modal-card .prov-field input") as ElLike;
    const sel = doc.querySelector(".modal-card .prov-field select") as ElLike;
    const card = doc.querySelector(".modal-card") as ElLike;
    const key = (target: ElLike, init: Record<string, unknown>): void => {
      target.dispatchEvent(new KB("keydown", { ...init, bubbles: true }));
    };
    // 标题为空时回车不提交（复用同一份校验）
    key(title, { key: "Enter" });
    expect(posts).toHaveLength(0);
    title.value = "回车标题";
    key(title, { key: "Enter", shiftKey: true });
    expect(posts).toHaveLength(0);
    key(sel, { key: "Enter" });
    expect(posts).toHaveLength(0);
    key(card, { key: "Enter" }); // 事件从非输入控件冒泡上来：同样不提交
    expect(posts).toHaveLength(0);
    key(title, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({ workspace: null, title: "回车标题" });
  });
});

describe("W789 · 运行态 composer 结构不变量（8）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
  });

  it("setBusy/setInputMode 只切 class：statusline/inputbar 的 DOM 结构逐节点不变", async () => {
    const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as {
      initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
      setBusy(busy: boolean): void;
      setInputMode(mode: string): void;
    };
    bar.initInputBar({ send: () => {}, cancel: () => {} });
    const sl = doc.getElementById("statusline") as ElLike;
    const ib = doc.getElementById("inputbar") as ElLike;
    const before = { sl: skeleton(sl), ib: skeleton(ib), slKids: sl.childElementCount, ibKids: ib.childElementCount };
    const hiddenBefore = ["btnCancel", "slStop", "btnMode"].map((id) => doc.getElementById(id)?.classList.contains("hidden"));
    expect(hiddenBefore).toEqual([true, true, true]); // 空闲：三个按钮都隐藏了

    bar.setBusy(true);
    bar.setInputMode("interject");

    const hiddenAfter = ["btnCancel", "slStop", "btnMode"].map((id) => doc.getElementById(id)?.classList.contains("hidden"));
    expect(hiddenAfter).toEqual([false, false, false]); // 运行：三个按钮出现
    // 出现按钮 ≠ 改动结构：DOM 骨架与子节点数完全一致（几何恒定的必要条件）
    expect(skeleton(sl)).toBe(before.sl);
    expect(skeleton(ib)).toBe(before.ib);
    expect(sl.childElementCount).toBe(before.slKids);
    expect(ib.childElementCount).toBe(before.ibKids);
    // 第 1 行仍只有一个：运行态绝不新增 .sl-row（换行/加行都会改高 composer）
    expect(Array.from(sl.children).filter((c) => clsOf(c).includes("sl-row-main")).length).toBe(1);
    // 按钮仍在同一个 .input-side 里（横排由 CSS 保证同一行高）；
    // W805 在行首新增图片入口 #btnAttach（能力位就绪前保持 .hidden）。
    const side = ib.querySelector(".input-side") as ElLike;
    expect(["btnAttach", "btnMode", "btnCancel", "btnSend"]).toEqual(
      Array.from(side.children).map((c) => c.id),
    );
    bar.setBusy(false);
    bar.setInputMode("idle");
  });
});

describe("W789 · 权限面板：唯一滚动层 + 内联上限 + 自身滚动不重排（2）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
  });

  it("openPanel 产出「标题 + 单一 .sl-popup-body」，且内联 max-height 真的被写上", async () => {
    const state = (await import(/* @vite-ignore */ at("ui/grants/state.ts"))) as {
      setShieldButton(el: unknown): void;
      setPanelEl(el: unknown): void;
      setData(d: unknown, s: string): void;
      getPanelEl(): ElLike | null;
    };
    const body = (await import(/* @vite-ignore */ at("ui/grants/panel/body.ts"))) as {
      openPanel(host: Record<string, unknown>): Promise<void>;
      closePanel(): void;
    };
    state.setShieldButton(doc.getElementById("slGrant"));
    const host = {
      focusedSession: () => "ws/s1",
      refresh: async () => {
        state.setData(
          {
            ok: true,
            effective: { read_roots: ["/tmp/ws"], net_hosts: ["example.com"] },
            unsandboxed_available: true,
            warnings: ["示例：站点清单在本部署下不生效"],
          },
          "ws/s1",
        );
      },
      renderPanel: () => {},
      startGrant: async () => {},
      revoke: async () => {},
    };
    await body.openPanel(host);
    const popup = doc.querySelector("#statusline .sl-popup.grant-popup") as ElLike;
    expect(popup).not.toBeNull();
    expect(popup.getAttribute("role")).toBe("dialog");
    expect(popup.querySelector(".sl-popup-title")?.textContent).toBe("本会话权限");
    expect(Array.from(popup.querySelectorAll(".sl-popup-body")).length).toBe(1); // 唯一滚动层
    const scroller = popup.querySelector(".sl-popup-body") as ElLike;
    expect(Array.from(scroller.children).length).toBeGreaterThan(3); // 真的渲染出了内容
    // 「可滚动的那一层被真正约束」：外层内联 max-height 非空 + 内容多于可视（内容溢出时）
    expect(popup.style.maxHeight).not.toBe("");
    expect(popup.style.maxHeight.endsWith("px")).toBe(true);
    body.closePanel();
    expect(doc.querySelector("#statusline .sl-popup")).toBeNull();
  });

  it("positionPanel 绝不清空 max-height（清空 = 内部 scrollTop 被夹回 0 = 面板滚不动）", async () => {
    const state = (await import(/* @vite-ignore */ at("ui/grants/state.ts"))) as {
      setShieldButton(el: unknown): void;
      setPanelEl(el: unknown): void;
    };
    const position = (await import(/* @vite-ignore */ at("ui/grants/panel/position.ts"))) as {
      positionPanel(): void;
    };
    doc.getElementById("statusline")?.appendChild(doc.createElement("div"));
    const popup = doc.createElement("div");
    popup.className = "sl-popup grant-popup";
    const scroller = doc.createElement("div");
    scroller.className = "sl-popup-body";
    popup.appendChild(scroller);
    (doc.getElementById("statusline") as ElLike).appendChild(popup);
    state.setShieldButton(doc.getElementById("slGrant"));
    state.setPanelEl(popup);
    popup.style.maxHeight = "500px";

    const writes: string[] = [];
    const real = popup.style as unknown as Record<string, unknown>;
    const spy = new Proxy(real, {
      set: (t, prop, value) => {
        if (prop === "maxHeight") writes.push(String(value));
        t[prop as string] = value;
        return true;
      },
      get: (t, prop) => t[prop as string],
    });
    Object.defineProperty(popup, "style", { configurable: true, get: () => spy });

    position.positionPanel();

    expect(writes).not.toContain(""); // 关键：不再有「清空 max-height 去量自然高度」
    expect(writes[writes.length - 1]).toBe("120px"); // jsdom 零排版 → 取面板高度下限
    expect(popup.style.maxHeight).toBe("120px");
  });

  it("面板内部自己的滚动不触发重新落位；页面级滚动仍然重排（跟随盾牌）", async () => {
    const state = (await import(/* @vite-ignore */ at("ui/grants/state.ts"))) as {
      setShieldButton(el: unknown): void;
      setPanelEl(el: unknown): void;
    };
    const position = (await import(/* @vite-ignore */ at("ui/grants/panel/position.ts"))) as {
      attachPosition(): void;
      detachPositionNow(): void;
    };
    const popup = doc.createElement("div");
    popup.className = "sl-popup grant-popup";
    const scroller = doc.createElement("div");
    scroller.className = "sl-popup-body";
    const row = doc.createElement("div");
    scroller.appendChild(row);
    popup.appendChild(scroller);
    (doc.getElementById("statusline") as ElLike).appendChild(popup);
    state.setShieldButton(doc.getElementById("slGrant"));
    state.setPanelEl(popup);

    const tops: string[] = [];
    const real = popup.style as unknown as Record<string, unknown>;
    const spy = new Proxy(real, {
      set: (t, prop, value) => {
        if (prop === "top") tops.push(String(value));
        t[prop as string] = value;
        return true;
      },
      get: (t, prop) => t[prop as string],
    });
    Object.defineProperty(popup, "style", { configurable: true, get: () => spy });

    position.attachPosition();
    // 内部滚动（滚轮滚 .sl-popup-body）→ 不重排：重排会打断用户正在进行的滚动
    row.dispatchEvent(new Ev("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    expect(tops).toEqual([]);
    // 页面级滚动 → 仍然重新落位（面板跟随盾牌）
    doc.dispatchEvent(new Ev("scroll"));
    await new Promise((r) => setTimeout(r, 40));
    expect(tops.length).toBeGreaterThan(0);
    position.detachPositionNow();
  });
});

describe("W789 · 会话条运行态（8③：chip 不撑高上方行）", () => {
  it("会话条的「其它运行中会话」入口在既有行内，且行内不换行（结构口径）", () => {
    const views = css("views.css");
    // W790（item 3）：会话条已并入 statusline 的既有行 .sl-row-sub —— 它不再是
    // 独占一行的条，而是那一行里的一个**可收缩**项（空间不足先压它，右端 tok/s /
    // 缓存 / 步数不被挤走）。因此这里由 flex: 0 0 auto 改为 flex: 0 1 auto，
    // 并补 min-width: 0 / overflow: hidden；W789 原本要守的「行内不换行」不变。
    expect(rule(views, ".session-bar")).toContain("flex: 0 1 auto");
    expect(rule(views, ".session-bar")).toContain("min-width: 0");
    expect(rule(views, ".session-bar")).toContain("overflow: hidden");
    expect(rule(views, ".sess-bar-others")).toContain("overflow: hidden");
    expect(rule(views, ".sess-bar-others")).toContain("white-space: nowrap");
  });
});
