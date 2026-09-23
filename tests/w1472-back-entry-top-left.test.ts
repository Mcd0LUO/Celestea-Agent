// @vitest-environment jsdom
/**
 * W1472 · 「返回父会话」入口搬到**左上角**（worker 快捷条处）。
 *
 * 用户看了 W1471 的截图之后说：「不应该一样放在左上角吗」—— 他指的位置是会话页左上角的
 * worker 快捷条（#wsStrip / .ws-strip，截图里 "BACKGROUND TASKS [n]" 下面竖排的 chip）。
 * 他是**从那条 chip 点进 worker** 的，回程理应回到那个入口所在的位置。
 *
 * 本文件跑真实生产模块（不是复刻逻辑）：
 *
 *   ① 聚焦 worker 时快捷条换形态：#wsStrip[data-mode=focus]，一条 chip 同时回答
 *      「我在哪」（worker 自己的 wid/短名/状态）与「怎么回去」（← 返回 <父会话>）；
 *   ② 聚焦 worker 时**不再列别的会话的 worker**（旧兜底会把全部 worker 摊开）；
 *   ③ 三态诚实降级（与 ui/worker-lineage.ts 同一真源）：ok 可点 / gone 父已不在 ⇒
 *      如实说明不可点 / unlinked 无父字段 ⇒ 既有口径 / 行未知 ⇒ **什么都不画**；
 *   ④ 继承行（上一代 worker）父会话仍在 → 入口照常可用，且带「上一代」徽标；
 *   ⑤ 点它**真的回到父会话**（聚焦容器换成父 + 会话条文本变化）；
 *   ⑥ 两处入口**互斥**：≥1025px 只显示左上角那份，≤1024px 只显示贴底那份；
 *   ⑦ 样式门禁：圆角只走 --r-* 令牌（胶囊 999px 除外）、无 dashed/dotted、颜色全走 token。
 *
 * 几何/可见性（非零矩形、真的画在屏幕上）由真机 CDP 用例负责（报告「真机证据」一节），
 * jsdom 没有布局，本文件只断言结构、文案与行为。
 *
 * 为什么用 pathToFileURL + 计算说明符：根 tsconfig 不含 apps/web（见 w1470b 用例同法）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
const HOST = "sample-ws/s1";
const OTHER_HOST = "sample-ws/s9";
const OWN = "worker:sample-ws_s1-session-0";
const GHOST = "worker:sample-ws_s1-session-1";
const ORPHAN = "worker:sample-ws_s1-session-2";
const ALIEN = "worker:sample-ws_s9-session-0";

/** 与 index.html 同构的最小骨架（#wsStrip 挂在 #main，导入期 need() 的节点就位）。 */
const SKELETON =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div>' +
  '<footer id="statusbar"><div id="sessionBar" class="session-bar"></div></footer>' +
  '</main></div></div>';

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
  title: string;
  type: string;
  hidden: boolean;
  dataset: Record<string, string | undefined>;
  classList: ClassListLike;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  closest(sel: string): ElLike | null;
  addEventListener(name: string, fn: () => void): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface DocLike {
  body: ElLike;
  getElementById(id: string): ElLike | null;
  createElement(tag: string): ElLike;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
const doc = (globalThis as unknown as { document: DocLike }).document;

/** 只声明用到的形状（不 import apps/web 的类型，见文件头）。 */
interface Row {
  id?: string;
  kind?: string;
  title?: string;
  wid?: string;
  status?: string;
  inherited?: boolean;
  parentSessionId?: string | null;
  parent?: string | null;
  parent_session?: string | null;
  workspace?: string | null;
}
interface LineageModule {
  lineageOf(pane: { id: string; kind: string } | null): { id: string; title: string; state: string } | null;
  resetWorkerLineage(): void;
  noteSessionList(rows: Row[]): void;
}
interface ViewModule {
  initViewCtx(): unknown;
  activatePane(id: string, kind?: string, title?: string): { id: string; kind: string };
  activePane(): { id: string; kind: string } | null;
}
interface BarModule { initSessionBar(): void; updateSessionBar(): void }
/** updateWorkerStrip 的实参可为 null（= 沿用上一份列表），与生产签名一致。 */
interface StripModule { initWorkerStrip(): ElLike | null; updateWorkerStrip(rows: Row[] | null): void; resetWorkerStrip(): void }
interface I18nModule { t(key: string, params?: Record<string, string | number>): string }

let lineage: LineageModule;
let V: ViewModule;
let bar: BarModule;
let strip: StripModule;
let i18n: I18nModule;
const load = async <T>(rel: string): Promise<T> => (await import(at(rel))) as T;
const t = (key: string, params?: Record<string, string | number>): string => i18n.t(key, params);

/** 本页发出的请求（证明「点它真的打开了父会话」而不是只改了文案）。 */
const net: { urls: string[] } = { urls: [] };

beforeAll(async () => {
  doc.body.innerHTML = SKELETON;
  vi.stubGlobal("fetch", async (url: unknown) => {
    net.urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, messages: [], sessions: [], questions: [] }) };
  });
  i18n = await load<I18nModule>("i18n/index.ts");
  V = await load<ViewModule>("ui/viewctx.ts");
  lineage = await load<LineageModule>("ui/worker-lineage.ts");
  strip = await load<StripModule>("ui/worker-strip.ts");
  bar = await load<BarModule>("ui/sessionbar.ts");
  V.initViewCtx();
  bar.initSessionBar();
});

beforeEach(() => {
  net.urls = [];
  lineage.resetWorkerLineage();
  strip.resetWorkerStrip();
  doc.getElementById("sessionBar")?.replaceChildren();
  bar.initSessionBar();
  // 上一轮 initWorkerStrip 留下的宿主会让 getElementById 命中陈旧节点（同 id 重复）⇒ 先清干净。
  for (const stale of Array.from(doc.querySelectorAll("#wsStrip"))) stale.remove();
});

/** 一条本代 worker 行（父会话字段与后端 W1470b 后的形状一致）。 */
function ownRow(): Row {
  return { id: OWN, kind: "worker", title: "W1472·搬到左上角", wid: "W1472", status: "RUNNING", parentSessionId: HOST, workspace: "engine" };
}
/** 宿主（leader）会话行。 */
function hostRow(): Row {
  return { id: HOST, kind: "session", title: "leader", workspace: "sample-ws" };
}
/** 别的会话派出的 worker 行（旧兜底会把它一起摊开 —— 必须不再出现）。 */
function alienRow(): Row {
  return { id: ALIEN, kind: "worker", title: "W301·别人家的", wid: "W301", status: "DONE", parentSessionId: OTHER_HOST, workspace: "engine" };
}
/** 一条上一代 worker 行。 */
function ghostRow(): Row {
  return { id: GHOST, kind: "worker", title: "W1470·上一代", wid: "W1470", status: "DONE", inherited: true, parentSessionId: HOST, workspace: "engine" };
}

/** 对账一次列表（走生产入口：worker-strip → worker-lineage），再刷会话条。 */
function settle(rows: Row[]): void {
  strip.initWorkerStrip();
  strip.updateWorkerStrip(rows);
  bar.updateSessionBar();
}

/** 聚焦某个容器（真实 activatePane）。 */
function focus(id: string, kind: string, title: string): void {
  V.activatePane(id, kind, title);
}

const boxEl = (): ElLike => doc.getElementById("wsStrip") as ElLike;
const stripBack = (): ElLike | null => boxEl().querySelector(".ws-strip-back");
const stripNote = (): ElLike | null => boxEl().querySelector(".ws-strip-unlinked");
const focusChip = (): ElLike | null => boxEl().querySelector(".ws-strip-focus");
const chipIds = (): string[] => Array.from(boxEl().querySelectorAll(".ws-strip-row")).map((r) => r.dataset["id"] ?? "");
const barEl = (): ElLike => doc.getElementById("sessionBar") as ElLike;
const barText = (): string => (barEl().textContent ?? "").replace(/\s+/g, " ").trim();

/** 页面上**所有**「回程入口」候选（与真机探针同一口径：button/a/[role=button]）。 */
function backCandidates(): ElLike[] {
  const all = Array.from(doc.querySelectorAll("button,a,[role=button]"));
  return all.filter((n) => /返回|回到|back to|back|parent|leader|主会话/i.test(n.textContent ?? ""));
}

describe("W1472 ①：聚焦 worker → 左上角快捷条换形态（我在哪 + 怎么回去）", () => {
  it("出现 .ws-strip-focus，左边是 worker 自己、右边是「← 返回 <父会话>」", () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    const chip = focusChip();
    expect(chip, "聚焦 worker 时快捷条必须换成聚焦形态").not.toBeNull();
    expect(boxEl().dataset["mode"]).toBe("focus");
    // 「我在哪」：worker 自己的标识三元组都在。
    // W1473：聚焦形态把标识**分层**（身份层 .ws-strip-id + 事实层 .ws-strip-facts，
    // 两层各自独占一行）—— 因为这条只有正文列左侧留白的宽度（1440px 实测 181px），
    // 一条 inline-flex 时标题会被压到 36px（需要 66px）而显示成「calc-1…」。
    // 断言因此按**语义**取（wid / 短名 / 状态各就位），不绑死容器层级。
    const chipEl = chip!;
    expect(chipEl.querySelector(".ws-strip-wid")?.textContent).toBe("W1472");
    expect(chipEl.querySelector(".ws-strip-title")?.textContent).toBe("搬到左上角");
    expect(chipEl.querySelector(".ws-strip-meta")?.textContent).toBe("RUNNING");
    // 状态点（与 chip 同族）：它承载「运行中」这一位信息，不能随换形态丢掉
    expect(chipEl.querySelector(".sess-dot")).not.toBeNull();
    // W1473 的分层不变量：身份层与事实层是**两个兄弟行盒**（标题才不会被 wid 挤扁）。
    expect(chipEl.querySelector(".ws-strip-id")).not.toBeNull();
    expect(chipEl.querySelector(".ws-strip-facts")).not.toBeNull();
    // 「怎么回去」：可点按钮，文案与目标都是父会话
    const back = stripBack();
    expect(back?.textContent).toBe(t("shell.sessbar.backToParent", { name: "leader" }));
    expect(back?.dataset["parent"]).toBe(HOST);
    expect(back?.type).toBe("button");
    expect(back?.title).toContain(t("shell.worker.parentHint"));
    expect(back?.title).toContain(HOST);
    expect(stripNote()).toBeNull();
  });

  it("聚焦 worker 时**不再**列别的会话的 worker（旧兜底会把全部摊开）", () => {
    settle([hostRow(), ownRow(), alienRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    const ids = chipIds();
    // 聚焦形态**只有一条** chip（就是 worker 自己），别的会话的 worker 一个都不摊开
    expect(ids).toEqual([OWN]);
    expect(ids).not.toContain(ALIEN);
  });

  it("回到父会话后快捷条恢复列表形态（本会话的 worker 照旧列出来）", () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(focusChip()).not.toBeNull();
    focus(HOST, "session", "leader");
    strip.updateWorkerStrip(null);
    expect(focusChip()).toBeNull();
    expect(boxEl().dataset["mode"]).toBe("list");
    expect(chipIds()).toEqual([OWN]);
    expect(stripBack()).toBeNull();
  });

  it("普通会话页不新增任何回程 chrome（与 W1471 同口径）", () => {
    settle([hostRow(), ownRow()]);
    focus(HOST, "session", "leader");
    strip.updateWorkerStrip(null);
    expect(stripBack()).toBeNull();
    expect(stripNote()).toBeNull();
    expect(focusChip()).toBeNull();
  });
});

describe("W1472 ②：三态诚实降级（ok / gone / unlinked / 行未知）", () => {
  it("无父字段：只有不可点的说明，沿用 shell.worker.unlinked 既有口径", () => {
    settle([hostRow(), { ...ownRow(), parentSessionId: null }]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(stripBack()).toBeNull();
    expect(stripNote()?.textContent).toBe(t("shell.worker.unlinked"));
    expect(stripNote()?.title).toBe(t("shell.worker.unlinked"));
  });

  it("父会话已不在列表：说明「父会话已不在」，仍不画死按钮", () => {
    settle([{ ...ownRow(), parentSessionId: "sample-ws/gone" }]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(stripBack()).toBeNull();
    expect(stripNote()?.textContent).toBe(t("shell.sessbar.parentGone"));
    expect(stripNote()?.title).toBe(t("shell.sessbar.parentGoneHint", { id: "sample-ws/gone" }));
  });

  it("行未知（列表还没对账到它）：快捷条什么都不画，绝不猜成「没有父会话」", () => {
    // 列表里**有别的会话的 worker**：一旦退回「归属判定不出来时列全部」的旧兜底，
    // 那条就会冒出来 —— 这正是本用例要挡住的（比「空列表下恰好没画」强得多）。
    settle([hostRow(), alienRow()]);
    focus(ORPHAN, "worker", "W1472·孤儿");
    strip.updateWorkerStrip(null);
    expect(boxEl().classList.contains("hidden")).toBe(true);
    expect(boxEl().dataset["mode"]).toBe("unknown");
    expect(chipIds()).toEqual([]);
    expect(stripBack()).toBeNull();
    expect(stripNote()).toBeNull();
    expect(focusChip()).toBeNull();
  });

  it("本来画着聚焦形态、随后该行从列表消失 → 整条收起（不留上一帧的陈旧内容）", () => {
    // 真实路径：进 worker 页时行还在（入口可点）→ 列表重载后该行不再返回。
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(focusChip(), "先决条件：此刻画着聚焦形态").not.toBeNull();
    expect(stripBack()).not.toBeNull();
    // 该行从列表消失（夹具只改浏览器这一份响应；见报告真机 S5）。
    strip.updateWorkerStrip([hostRow()]);
    expect(boxEl().classList.contains("hidden")).toBe(true);
    expect(boxEl().dataset["mode"]).toBe("unknown");
    expect(chipIds()).toEqual([]);
    expect(stripBack()).toBeNull();
    expect(stripNote()).toBeNull();
    expect(focusChip()).toBeNull();
  });

  it("父 id 指向自己（坏数据）：按无父处理，不自指成环", () => {
    settle([{ ...ownRow(), parentSessionId: OWN }]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(stripBack()).toBeNull();
    expect(stripNote()?.textContent).toBe(t("shell.worker.unlinked"));
  });

  it("三种父字段写法（parentSessionId / parent / parent_session）都认", () => {
    for (const key of ["parentSessionId", "parent", "parent_session"] as const) {
      lineage.resetWorkerLineage();
      const row: Row = { ...ownRow(), parentSessionId: null, parent: null, parent_session: null };
      row[key] = HOST;
      lineage.noteSessionList([hostRow(), row]);
      expect(lineage.lineageOf({ id: OWN, kind: "worker" }), key).toEqual({ id: HOST, title: "leader", state: "ok" });
    }
  });
});

describe("W1472 ③：继承行 + 点击真的回到父会话", () => {
  it("继承行（上一代 worker）父会话仍在 → 入口照常可用，且带「上一代」徽标", () => {
    settle([hostRow(), ghostRow()]);
    focus(GHOST, "worker", "W1470·上一代");
    strip.updateWorkerStrip(null);
    expect(stripBack()?.dataset["parent"]).toBe(HOST);
    expect(stripBack()?.textContent).toBe(t("shell.sessbar.backToParent", { name: "leader" }));
    expect(focusChip()?.querySelector(".ws-strip-badge")?.textContent).toBe(t("shell.worker.inherited"));
  });

  it("点击 → 聚焦容器换成父会话、WORKER 标记消失、真的拉取父会话历史", async () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    stripBack()?.click();
    expect(V.activePane()?.id).toBe(HOST);
    expect(V.activePane()?.kind).toBe("session");
    strip.updateWorkerStrip(null);
    bar.updateSessionBar();
    expect(stripBack()).toBeNull();
    expect(barText()).toContain("leader");
    expect(doc.querySelector(".sess-bar-kind")?.classList.contains("hidden")).toBe(true);
    await vi.waitFor(() => expect(net.urls.some((u) => u.includes(encodeURIComponent(HOST)))).toBe(true));
  });
});

describe("W1472 ④：两处入口互斥 + 样式门禁", () => {
  it("worker 页上两处回程候选各就各位：左上角 .ws-strip-back（主）+ 贴底 .sess-bar-back（窄屏兜底）", () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    bar.updateSessionBar();
    const hits = backCandidates();
    // DOM 里两份都在（各自负责一个断点），**可见性互斥**由 CSS 保证（下一条用例断言规则）。
    // 注意：本文件只断言结构 —— jsdom 不做布局，也就无法回答「谁真的画在屏幕上」。
    expect(hits.map((n) => n.className).sort()).toEqual(["sess-bar-back", "ws-strip-back"]);
    expect(hits.find((n) => n.className === "ws-strip-back")?.dataset["parent"]).toBe(HOST);
    expect(hits.find((n) => n.className === "sess-bar-back")?.dataset["parent"]).toBe(HOST);
  });

  it("CSS 互斥：≥1025px 只显示左上角那份，≤1024px 只显示贴底那份", () => {
    const stripCss = css("workerstrip.css");
    const viewsCss = css("views.css");
    // 左上角：窄屏整条隐藏（既有几何契约不变）
    const narrowAt = stripCss.indexOf("@media (max-width: 1024px)");
    expect(narrowAt).toBeGreaterThan(-1);
    const narrow = stripCss.slice(narrowAt);
    expect(narrow).toContain(".ws-strip { display: none; }");
    expect(narrow).toContain(".ws-strip-back, .ws-strip-unlinked { display: none; }");
    // 贴底：宽屏让位
    const wideAt = viewsCss.indexOf("@media (min-width: 1025px)");
    expect(wideAt).toBeGreaterThan(-1);
    expect(viewsCss.slice(wideAt)).toContain(".sess-bar-lineage { display: none; }");
    // 两个断点首尾相接：1024/1025，不留缝也不重叠
    expect(stripCss).not.toContain("@media (max-width: 1025px)");
    expect(viewsCss).not.toContain("@media (min-width: 1024px)");
  });

  it("样式：圆角只走 --r-*/999px、无 dashed/dotted、颜色全走 token", () => {
    const text = css("workerstrip.css");
    for (const selector of [".ws-strip-focus {", ".ws-strip-back {", ".ws-strip-unlinked {"] as const) {
      const i = text.indexOf(selector);
      expect(i, "workerstrip.css 必须有 " + selector + " 规则").toBeGreaterThan(-1);
      const body = text.slice(i, text.indexOf("}", i));
      for (const m of body.matchAll(/border-radius:\s*([^;]+);/g)) {
        const radius = (m[1] ?? "").trim();
        expect(radius === "999px" || radius.startsWith("var(--r-"), "写死圆角：" + radius).toBe(true);
      }
      expect(body).not.toMatch(/\b(dashed|dotted)\b/);
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    const back = text.slice(text.indexOf(".ws-strip-back {"), text.indexOf("}", text.indexOf(".ws-strip-back {")));
    expect(back).toContain("border-radius: var(--r-pill)");
    expect(back).toMatch(/color: var\(--c-/);
    expect(back).toMatch(/border: var\(--hairline\) solid var\(--c-/);
    // 聚焦形态本身是 chip 同族：沿用 .ws-strip-row 的底色/发丝线
    const row = text.slice(text.indexOf(".ws-strip-row {"), text.indexOf("}", text.indexOf(".ws-strip-row {")));
    expect(row).toContain("border-radius: var(--r-badge)");
    expect(row).toContain("background: var(--c-surface)");
  });

  it("聚焦形态是**不可点**的容器（不是第二个按钮 —— 动作只有一个）", () => {
    const text = css("workerstrip.css");
    const seg = text.slice(text.indexOf(".ws-strip-focus {"), text.indexOf("}", text.indexOf(".ws-strip-focus {")));
    expect(seg).toContain("cursor: default");
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1472·搬到左上角");
    strip.updateWorkerStrip(null);
    expect(focusChip()?.className).toContain("ws-strip-row");
    // 容器本身不是 button（渲染成 div）：页面上唯一的可点回程是里面的 .ws-strip-back
    const chips = Array.from(boxEl().querySelectorAll("button")).map((b) => b.className);
    expect(chips).toEqual(["ws-strip-back"]);
  });
});
