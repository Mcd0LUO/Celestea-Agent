// @vitest-environment jsdom
/**
 * W790 · 前端批 B / item 4：悬浮提示内置插件化（注册缝 + 内置 150ms 卡片）。
 *
 * 断言口径（全部加载**真实模块**，不是复刻逻辑）：
 *   · 注册缝形状：具名提供者、register → dispose、同 id 覆盖、优先级裁决；
 *   · **真插件化**（不是硬编码）：注销内置提供者 → 提示退回原生 title；
 *   · 引擎：150ms 停留、唯一宿主卡片（.hint-card[role=tooltip]）、离开/Esc/按下即撤、
 *     子元素自带 title 时让位（不双弹）；
 *   · rail 的富预览卡 = priority 10 的提供者，压过内置文本卡（真实 rail 长条验证）。
 *
 * 仍未覆盖：真实浏览器的观感（卡片像素落位在 jsdom 里没有排版，见报告）。
 */
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


const doc = (globalThis as unknown as { document: DocLike }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;
const KB = (globalThis as unknown as { KeyboardEvent: new (t: string, i?: Record<string, unknown>) => unknown }).KeyboardEvent;

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
// item 4 · 悬浮提示：注册缝 + 内置插件
// ============================================================================

interface HintMod {
  initHints(): void;
  setHint(target: ElLike, text: string | null): void;
  hoverHint(target: ElLike | null): void;
  hideHint(): void;
  hintCardEl(): ElLike | null;
  registerHintPlugin(p: { id: string; priority?: number; claim(t: ElLike, s: string): unknown }): () => void;
  hintPlugins(): readonly { id: string; priority?: number }[];
  HINT_ATTR: string;
  HINT_DELAY_MS: number;
  TEXT_HINT_ID: string;
}

describe("W790 · item 4 注册缝：具名提供者 + 可注销 + 优先级（对齐 DSH register → dispose）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
  });
  afterEach(() => {
    doc.body.replaceChildren();
  });

  it("内置默认实现是**普通提供者**：注销它就退回原生 title（证明不是硬编码）", async () => {
    const registry = (await import(/* @vite-ignore */ at("ui/hint/registry.ts"))) as {
      registerHintPlugin(p: { id: string; priority?: number; claim(t: ElLike, s: string): unknown }): () => void;
      hintPlugins(): readonly { id: string }[];
    };
    const card = (await import(/* @vite-ignore */ at("ui/hint/card.ts"))) as {
      setHint(t: ElLike, s: string | null): void;
      HINT_ATTR: string;
      HINT_DELAY_MS: number;
    };
    const builtin = (await import(/* @vite-ignore */ at("ui/hint/builtin.ts"))) as {
      TEXT_HINT_ID: string;
      textCardPlugin(): { id: string; priority?: number; claim(t: ElLike, s: string): unknown };
    };
    expect(card.HINT_DELAY_MS, "沿用 rail 已验证的停留阈值").toBe(150);

    const dispose = registry.registerHintPlugin(builtin.textCardPlugin());
    expect(registry.hintPlugins().map((p) => p.id)).toEqual([builtin.TEXT_HINT_ID]);
    const a = el("div");
    card.setHint(a, "运行中");
    expect(a.getAttribute(card.HINT_ATTR)).toBe("运行中");
    expect(a.title, "有提供者认领时不得再留原生 title（否则 1s 后双弹）").toBe("");

    dispose(); // 注销内置插件 = 卸掉唯一提供者
    expect(registry.hintPlugins()).toHaveLength(0);
    const b = el("div");
    card.setHint(b, "空闲");
    expect(b.title, "无提供者认领 → 原生 title 兜底").toBe("空闲");

    // 同 id 重复注册 = 重新挂载（不叠加）
    registry.registerHintPlugin(builtin.textCardPlugin());
    registry.registerHintPlugin(builtin.textCardPlugin());
    expect(registry.hintPlugins().filter((p) => p.id === builtin.TEXT_HINT_ID)).toHaveLength(1);
  });

  it("无提供者认领 → 原生 title 兜底（退化路径真的存在）", async () => {
    const registry = (await import(/* @vite-ignore */ at("ui/hint/registry.ts"))) as {
      resolveHint(t: ElLike, s: string): unknown;
    };
    const card = (await import(/* @vite-ignore */ at("ui/hint/card.ts"))) as {
      setHint(t: ElLike, s: string | null): void;
      HINT_ATTR: string;
    };
    const b = el("div");
    card.setHint(b, "空闲"); // 注册表里没有任何提供者
    expect(registry.resolveHint(b, "空闲")).toBeNull();
    expect(b.title).toBe("空闲");
    card.setHint(b, null); // 撤提示：两个属性都要清掉
    expect(b.title).toBe("");
    expect(b.getAttribute(card.HINT_ATTR)).toBeNull();
  });
});

describe("W790 · item 4 引擎：唯一宿主 + 150ms 停留 + 撤卡", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    doc.body.replaceChildren();
  });

  // W871：宿主从 #main 改成 document.body（全站定位基准）+ 卡片 position:fixed。
  //   旧实现挂在 #main 下用「锚点 rect − 宿主 rect」算相对坐标，会话树在侧栏
  //   （#main 之外）时该差值为负、卡片被夹到边缘 ⇒ 用户报的提示错位。见
  //   tests/w871-shell-anchor-dom.test.ts 的几何断言。
  it("停留 150ms 才弹卡（早于此不弹）；卡片是 body 下唯一的 .hint-card[role=tooltip]", async () => {
    const hint = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as HintMod;
    hint.initHints();
    const t = el("span");
    doc.getElementById("main")?.appendChild(t);
    hint.setHint(t, "运行中");

    hint.hoverHint(t);
    vi.advanceTimersByTime(149);
    expect(hint.hintCardEl(), "149ms 不该弹").toBeNull();
    vi.advanceTimersByTime(1);
    const card = hint.hintCardEl();
    expect(card).not.toBeNull();
    expect(card?.className).toContain("hint-card");
    expect(card?.getAttribute("role")).toBe("tooltip");
    expect(card?.textContent).toContain("运行中");
    expect(card?.parentElement?.tagName).toBe("BODY");
    expect(Array.from(doc.querySelectorAll(".hint-card"))).toHaveLength(1);

    // 移到别的目标：旧卡立即撤、新目标重新计 150ms
    const t2 = el("span");
    doc.getElementById("main")?.appendChild(t2);
    hint.setHint(t2, "空闲");
    hint.hoverHint(t2);
    expect(hint.hintCardEl()).toBeNull();
    vi.advanceTimersByTime(150);
    expect(hint.hintCardEl()?.textContent).toContain("空闲");
  });

  it("指针离开 / Esc / 指针按下 都撤卡；约定超时（未到 150ms 就离开）不弹", async () => {
    const hint = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as HintMod;
    hint.initHints();
    const t = el("span");
    doc.getElementById("main")?.appendChild(t);
    hint.setHint(t, "运行中");

    hint.hoverHint(t);
    hint.hoverHint(null); // 未到 150ms 就离开
    vi.advanceTimersByTime(300);
    expect(hint.hintCardEl()).toBeNull();

    hint.hoverHint(t);
    vi.advanceTimersByTime(150);
    expect(hint.hintCardEl()).not.toBeNull();
    doc.dispatchEvent(new KB("keydown", { key: "Escape" }));
    expect(hint.hintCardEl()).toBeNull();

    hint.hoverHint(t);
    vi.advanceTimersByTime(150);
    expect(hint.hintCardEl()).not.toBeNull();
    doc.dispatchEvent(new Ev("pointerdown"));
    expect(hint.hintCardEl()).toBeNull();
  });

  it("子元素自带原生 title 时让位（不双弹），祖先的提示卡不抢", async () => {
    const hint = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as HintMod;
    hint.initHints();
    const row = el("div");
    const kebab = el("button");
    kebab.title = "会话操作"; // 自己的原生提示
    row.appendChild(kebab);
    doc.getElementById("main")?.appendChild(row);
    hint.setHint(row, "甲会话（点击打开）");

    kebab.dispatchEvent(new Ev("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(hint.hintCardEl(), "子元素有自己的 title → 让位").toBeNull();

    row.dispatchEvent(new Ev("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(150);
    expect(hint.hintCardEl()?.textContent).toContain("甲会话（点击打开）");
  });
});

describe("W790 · item 4 rail 富卡片 = priority 10 的提供者（压过内置文本卡）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    doc.body.replaceChildren();
  });

  it("真实的 rail 长条：提示卡由 rail 提供者构建（.railv3-card），内置文本卡不抢", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const hint = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as HintMod;
    hint.initHints(); // 内置文本卡（priority 0）
    const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      initViewCtx(): unknown;
      ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
      activatePane(id: string, kind?: string, title?: string): unknown;
    };
    ctx.initViewCtx();
    const pane = ctx.ensurePane("ws/s1", "session", "甲会话");
    ctx.activatePane("ws/s1", "session", "甲会话");
    const col = el("div");
    const content = el("div");
    content.className = "content";
    content.textContent = "第一轮提问";
    col.appendChild(content);
    pane.el.appendChild(col);
    const rail = (await import(/* @vite-ignore */ at("ui/rail.ts"))) as {
      RAIL_HINT_ID: string;
      initRail(): void;
      railAdd(p: unknown, c: unknown, role: string): void;
    };
    rail.initRail(); // 注册 rail 提供者（priority 10）
    expect(hint.hintPlugins().map((p) => p.id)).toEqual([rail.RAIL_HINT_ID, hint.TEXT_HINT_ID]);

    rail.railAdd(pane, col, "user");
    const bar = doc.querySelector("#main .railv3-item") as ElLike | null;
    expect(bar, "rail 长条必须已建出来").not.toBeNull();
    expect(bar?.getAttribute(hint.HINT_ATTR), "长条提示走注册缝（不再写原生 title）").toBeTruthy();
    expect(bar?.title).toBe("");

    hint.hoverHint(bar); // rail 的悬停意图（条带 pointer-events:none，由 rail 自算命中后直驱）
    vi.advanceTimersByTime(150);
    const card = hint.hintCardEl();
    expect(card).not.toBeNull();
    expect(card?.className, "rail 提供者构建富卡片").toContain("railv3-card");
    expect(card?.textContent).toContain("第一轮提问"); // 内容取自消息 DOM
  });
});
