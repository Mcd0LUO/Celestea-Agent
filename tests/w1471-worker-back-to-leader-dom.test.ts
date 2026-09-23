// @vitest-environment jsdom
/**
 * W1471 · 从 worker 会话返回 leader（父会话）的入口。
 *
 * 用户报障原话：「这个返回主 leader 的按钮在哪呢？？？」—— 从会话页左上角的 worker
 * 快捷条点进 worker 之后，页面上**没有任何回程入口**（真机 CDP 实测：匹配
 * /返回|回到|back|parent|leader|host|主会话/ 的 button/a/[role=button] 数量 = 0）。
 * 本文件跑真实生产模块（不是复刻逻辑）：
 *
 *   ① 有父：聚焦 worker 时 #sessionBar 出现**可点**的回程入口（文案走 t()）；
 *   ② 无父：没有可点的死按钮，只有沿用既有口径的说明（shell.worker.unlinked）；
 *   ③ 父已不在列表：同样不画死按钮，改成「父会话已不在」；
 *   ④ 行未知（列表还没对账到这个 worker）：**什么都不画**（不知道就说不知道）；
 *   ⑤ 普通会话：本入口一个都不出现（不新增无关 chrome）；
 *   ⑥ 点它真的回到父会话（聚焦容器 id + 会话条文本 + 真实发起了父会话的历史请求）；
 *   ⑦ 继承行（上一代 worker）与父会话仍在 → 入口照常可用；
 *   ⑧ 全站**唯一**一个回程入口（单点，不是两个各画一半）。
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
const OTHER = "sample-ws/s2";
const OWN = "worker:sample-ws_s1-session-0";
const GHOST = "worker:sample-ws_s1-session-1";
const ORPHAN = "worker:sample-ws_s1-session-2";

/** 与 index.html 同构的最小骨架（#sessionBar 是入口的宿主，必须在导入期就位）。 */
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
interface StripModule { initWorkerStrip(): ElLike | null; updateWorkerStrip(rows: Row[]): void; resetWorkerStrip(): void }
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
});

/** 一条本代 worker 行（父会话字段与后端 W1470b 后的形状一致）。 */
function ownRow(): Row {
  return { id: OWN, kind: "worker", title: "W1471·补入口", wid: "W1471", status: "RUNNING", parentSessionId: HOST, workspace: "engine" };
}
/** 宿主（leader）会话行。 */
function hostRow(): Row {
  return { id: HOST, kind: "session", title: "leader", workspace: "sample-ws" };
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

const barEl = (): ElLike => doc.getElementById("sessionBar") as ElLike;
const backBtn = (): ElLike | null => barEl().querySelector(".sess-bar-back");
const unlinked = (): ElLike | null => barEl().querySelector(".sess-bar-unlinked");
const barText = (): string => (barEl().textContent ?? "").replace(/\s+/g, " ").trim();

/** 页面上**所有**「回程入口」候选（与真机探针同一口径：button/a/[role=button]）。 */
function backCandidates(): ElLike[] {
  const all = Array.from(doc.querySelectorAll("button,a,[role=button]"));
  return all.filter((n) => /返回|回到|back to|back|parent|leader|主会话/i.test(n.textContent ?? ""));
}

describe("W1471 ①：有父 —— worker 页出现可点的回程入口", () => {
  it("聚焦 worker 后会话条出现 .sess-bar-back，文案与目标都是父会话", () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1471·补入口");
    bar.updateSessionBar();
    const btn = backBtn();
    expect(btn, "聚焦 worker 时必须出现回程入口").not.toBeNull();
    expect(btn?.textContent).toBe(t("shell.sessbar.backToParent", { name: "leader" }));
    expect(btn?.dataset["parent"]).toBe(HOST);
    expect(btn?.type).toBe("button");
    expect(btn?.title).toContain(t("shell.worker.parentHint"));
    expect(btn?.title).toContain(HOST);
    expect(unlinked()).toBeNull();
    expect(barText()).toContain("W1471·补入口");
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

  it("父会话标题缺失时回落到 id 末段（不显示空白按钮）", () => {
    lineage.noteSessionList([{ id: HOST, kind: "session" }, ownRow()]);
    expect(lineage.lineageOf({ id: OWN, kind: "worker" })).toEqual({ id: HOST, title: "s1", state: "ok" });
  });
});

describe("W1471 ②③④：无父 / 父已不在 / 行未知 —— 都不画死按钮", () => {
  it("无父字段：只有不可点的说明，沿用 shell.worker.unlinked 既有口径", () => {
    settle([hostRow(), { ...ownRow(), parentSessionId: null }]);
    focus(OWN, "worker", "W1471·补入口");
    bar.updateSessionBar();
    expect(backBtn()).toBeNull();
    expect(unlinked()?.textContent).toBe(t("shell.worker.unlinked"));
    expect(unlinked()?.title).toBe(t("shell.worker.unlinked"));
  });

  it("父会话已不在列表：说明「父会话已不在」，仍不画死按钮", () => {
    settle([{ ...ownRow(), parentSessionId: "sample-ws/gone" }]);
    focus(OWN, "worker", "W1471·补入口");
    bar.updateSessionBar();
    expect(backBtn()).toBeNull();
    expect(unlinked()?.textContent).toBe(t("shell.sessbar.parentGone"));
    expect(unlinked()?.title).toBe(t("shell.sessbar.parentGoneHint", { id: "sample-ws/gone" }));
  });

  it("行未知（列表还没对账到它）：什么都不画，绝不猜成「没有父会话」", () => {
    lineage.noteSessionList([hostRow()]);
    expect(lineage.lineageOf({ id: ORPHAN, kind: "worker" })).toBeNull();
    settle([hostRow()]);
    focus(ORPHAN, "worker", "W1471·孤儿");
    bar.updateSessionBar();
    expect(backBtn()).toBeNull();
    expect(unlinked()).toBeNull();
  });

  it("父 id 指向自己（坏数据）：按无父处理，不自指成环", () => {
    lineage.noteSessionList([{ ...ownRow(), parentSessionId: OWN }]);
    expect(lineage.lineageOf({ id: OWN, kind: "worker" })?.state).toBe("unlinked");
  });
});

describe("W1471 ⑤：普通会话不新增任何 chrome", () => {
  it("聚焦 leader 会话时既没有回程按钮也没有说明", () => {
    settle([hostRow(), ownRow()]);
    focus(HOST, "session", "leader");
    bar.updateSessionBar();
    expect(backBtn()).toBeNull();
    expect(unlinked()).toBeNull();
    // WORKER 徽标收起（textContent 仍含隐藏节点，故断言 class 而不是文本）
    expect(doc.querySelector(".sess-bar-kind")?.classList.contains("hidden")).toBe(true);
    expect(barText()).toContain("leader");
    expect(barText()).not.toContain(t("shell.worker.unlinked"));
    expect(barText()).not.toContain(t("shell.sessbar.parentGone"));
  });

  it("未解析的 LOCAL 容器（kind 为空）同样不出现入口", () => {
    settle([hostRow(), ownRow()]);
    expect(lineage.lineageOf({ id: "", kind: "" })).toBeNull();
  });
});

describe("W1471 ⑥⑦：点它真的回到父会话；继承行照常可用", () => {
  it("点击 → 聚焦容器换成父会话、WORKER 标记消失、真的拉取父会话历史", async () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1471·补入口");
    bar.updateSessionBar();
    backBtn()?.click();
    // 聚焦容器与状态栏当帧就换（openSession 是同步切容器 + 后台恢复历史）
    expect(V.activePane()?.id).toBe(HOST);
    expect(V.activePane()?.kind).toBe("session");
    bar.updateSessionBar();
    expect(backBtn()).toBeNull();
    expect(barText()).toContain("leader");
    expect(doc.querySelector(".sess-bar-kind")?.classList.contains("hidden")).toBe(true);
    await vi.waitFor(() => expect(net.urls.some((u) => u.includes(encodeURIComponent(HOST)))).toBe(true));
  });

  it("继承行（上一代 worker）父会话仍在 → 入口照常可用", () => {
    settle([hostRow(), ghostRow()]);
    focus(GHOST, "worker", "W1470·上一代");
    bar.updateSessionBar();
    expect(backBtn()?.dataset["parent"]).toBe(HOST);
    expect(backBtn()?.textContent).toBe(t("shell.sessbar.backToParent", { name: "leader" }));
  });
});

describe("W1471 ⑧：全站唯一的回程入口 + 样式门禁", () => {
  it("worker 页上匹配 /返回|back|parent/ 的可点候选恰好 1 个（就是它）", () => {
    settle([hostRow(), ownRow()]);
    focus(OWN, "worker", "W1471·补入口");
    bar.updateSessionBar();
    const hits = backCandidates();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.className).toBe("sess-bar-back");
  });

  it("样式：圆角只走 --r-*/999px、无 dashed/dotted、颜色全走 token", () => {
    const text = css("views.css");
    for (const selector of [".sess-bar-back {", ".sess-bar-unlinked {"] as const) {
      const at2 = text.indexOf(selector);
      expect(at2, "views.css 必须有 " + selector + " 规则").toBeGreaterThan(-1);
      const body = text.slice(at2, text.indexOf("}", at2));
      // 圆角口径：胶囊 999px 或 --r-* token，不接受任何写死的其它 px
      for (const m of body.matchAll(/border-radius:\s*([^;]+);/g)) {
        const radius = (m[1] ?? "").trim();
        expect(radius === "999px" || radius.startsWith("var(--r-"), "写死圆角：" + radius).toBe(true);
      }
      expect(body).not.toMatch(/\b(dashed|dotted)\b/);
    }
    const back = text.slice(text.indexOf(".sess-bar-back {"), text.indexOf("}", text.indexOf(".sess-bar-back {")));
    expect(back).toContain("border-radius: 999px");
    expect(back).toMatch(/color: var\(--c-/);
    expect(back).toMatch(/background: var\(--c-/);
    // 空槽位不占位（普通会话页与 unlinked 之外的路径都不留一个空 · ）
    expect(text).toContain(".sess-bar-lineage:empty");
  });

  it("样式门禁：本入口不得用虚线或写死 px 圆角（负控制见报告 ML6）", () => {
    const text = css("views.css");
    const seg = text.slice(text.indexOf(".sess-bar-lineage {"), text.indexOf("/* ---- 运行态点"));
    expect(seg.length).toBeGreaterThan(100);
    expect(seg).not.toMatch(/\b(dashed|dotted)\b/);
    for (const m of seg.matchAll(/border-radius:\s*([^;]+);/g)) {
      const radius = (m[1] ?? "").trim();
      expect(radius === "999px" || radius.startsWith("var(--r-"), "写死圆角：" + radius).toBe(true);
    }
  });
});
