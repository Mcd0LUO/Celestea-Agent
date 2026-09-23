// @vitest-environment jsdom
/**
 * W1470b · 面板上的「上一代 worker」（端点可见性的 UI 一半）。
 *
 * 后端把重启前的持久化行作为 `inherited: true` 的 worker 行发出来之后，用户能不能**看见**
 * 是前端的事。本文件跑真实生产模块（不是复刻逻辑）：
 *
 *   ① 侧栏谱系 Worker 组：上一代行有徽标、状态位显示**注册表状态**（不是由本页运行态
 *      推导的 idle —— 没有活实例的行永远是「不忙」的，写 idle 等于说谎），本代行不受影响；
 *   ② 会话页快捷条：同一个标记，chip 上加徽标；
 *   ③ 轮询签名：只有 status / inherited 变化也必须重建（否则 P2 收口 RUNNING→DONE 后
 *      面板停在旧状态）；
 *   ④ 轮询的局部更新（updateBusyDots）不得把上一代行的状态抹成 idle —— 这一条是**真机
 *      CDP 实测抓到的真 bug**，jsdom 只在渲染后立刻取值是抓不到的；
 *   ⑤ 样式门禁：徽标圆角走 --r-*、颜色走 token、不出现 dashed/dotted。
 *
 * 几何/可见性（非零矩形、真的画在屏幕上）由真机 CDP 用例负责（报告「真机证据」一节），
 * jsdom 没有布局，本文件只断言结构与文案。
 *
 * 为什么用 pathToFileURL + 计算说明符：根 tsconfig 不含 apps/web（它由自己的 tsconfig 管，
 * 带 DOM lib 与 bundler 解析）。静态 import 会把 apps/web 的源码拉进根 program，用 node16
 * 规则重报一堆「缺扩展名 / 没有 document」的假错 —— 本仓既有 DOM 用例（w866 等）同理。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;
const css = (rel: string): string => readFileSync(join(WEB, "src", "styles", rel), "utf8");
const HOST = "sample-ws/s1";
const GHOST = "worker:sample-ws_s1-session-0";
const OWN = "worker:sample-ws_s1-session-1";

/** 与 index.html 同构的最小骨架（导入期 need() 的节点必须先存在）。 */
const SKELETON =
  '<div id="app"><div id="layout"><aside id="sidebar"><div id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages"></div></main>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusTime"></span></footer></div></div>';

/** jsdom 节点的结构形状（根 tsconfig 无 DOM lib，与 w866 等既有 DOM 用例同法）。 */
interface ClassListLike {
  contains(c: string): boolean;
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
}
interface ElLike {
  className: string;
  innerHTML: string;
  textContent: string | null;
  title: string;
  dataset: Record<string, string | undefined>;
  classList: ClassListLike;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface DocLike {
  body: ElLike;
  getElementById(id: string): ElLike | null;
  createElement(tag: string): ElLike;
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
  state?: string;
  model?: string | null;
  events?: number;
  inherited?: boolean;
  parentSessionId?: string | null;
  workspace?: string | null;
}
interface WorkersModule { renderWorkerGroup(host: ElLike, workers: Row[], open: boolean): void }
interface StripModule {
  initWorkerStrip(): ElLike | null;
  updateWorkerStrip(rows: Row[]): void;
  resetWorkerStrip(): void;
}
interface UtilModule { workerSigOf(rows: Row[]): string }
interface LiveModule { updateBusyDots(container: ElLike): void }
interface I18nModule { t(key: string, params?: Record<string, string | number>): string }

let tree: WorkersModule;
let strip: StripModule;
let util: UtilModule;
let live: LiveModule;
let i18n: I18nModule;
const load = async <T>(rel: string): Promise<T> => (await import(at(rel))) as T;

beforeAll(async () => {
  doc.body.innerHTML = SKELETON;
  i18n = await load<I18nModule>("i18n/index.ts");
  tree = await load<WorkersModule>("ui/sessiontree/workers.ts");
  strip = await load<StripModule>("ui/worker-strip.ts");
  util = await load<UtilModule>("ui/sessiontree/util.ts");
  live = await load<LiveModule>("ui/sessiontree/live.ts");
});

const t = (key: string): string => i18n.t(key);

/** 一条上一代 worker 行（后端 `inherited: true` 的投影）。 */
function ghostRow(): Row {
  return {
    id: GHOST,
    kind: "worker",
    title: "W701·ghost",
    wid: "W701",
    status: "RUNNING",
    state: "idle",
    model: "test-model",
    inherited: true,
    parentSessionId: HOST,
    workspace: "engine",
  };
}

/** 一条本代 worker 行（同一会话派出的，没有 inherited 键）。 */
function ownRow(): Row {
  return {
    id: OWN,
    kind: "worker",
    title: "W702·live",
    wid: "W702",
    status: "RUNNING",
    state: "idle",
    model: "test-model",
    parentSessionId: HOST,
    workspace: "engine",
  };
}

function treeHost(): ElLike {
  const host = doc.createElement("div");
  doc.getElementById("sessionTree")?.appendChild(host);
  return host;
}

beforeEach(() => {
  doc.getElementById("sessionTree")?.replaceChildren();
  strip.resetWorkerStrip();
});

describe("W1470b ①：侧栏 Worker 组把上一代与本代分开", () => {
  it("上一代行带徽标、状态位写注册表状态；本代行不受影响", () => {
    const host = treeHost();
    tree.renderWorkerGroup(host, [ghostRow(), ownRow()], true);
    const rows = Array.from(host.querySelectorAll(".ws-worker-row"));
    expect(rows).toHaveLength(2);
    const ghost = rows.find((r) => r.dataset["id"] === GHOST);
    const own = rows.find((r) => r.dataset["id"] === OWN);
    expect(ghost?.classList.contains("inherited")).toBe(true);
    expect(ghost?.querySelector(".ws-worker-badge")?.textContent).toBe(t("shell.worker.inherited"));
    expect(ghost?.querySelector(".ws-worker-state")?.textContent).toBe("RUNNING");
    expect(ghost?.title).toContain(t("shell.worker.inheritedHint"));
    expect(own?.classList.contains("inherited")).toBe(false);
    expect(own?.querySelector(".ws-worker-badge")).toBeNull();
    expect(own?.querySelector(".ws-worker-state")?.textContent).toBe(t("shell.tree.idle"));
  });

  it("上一代行是 DONE/FAILED 时同样如实写出（不是 idle）", () => {
    const host = treeHost();
    tree.renderWorkerGroup(host, [{ ...ghostRow(), status: "FAILED" }], true);
    expect(host.querySelector(".ws-worker-state.inherited")?.textContent).toBe("FAILED");
  });

  it("轮询的局部更新不得把上一代行的状态抹成 idle（真机抓到的回归）", () => {
    const host = treeHost();
    tree.renderWorkerGroup(host, [ghostRow(), ownRow()], true);
    // 5s 轮询走的就是这条局部更新路径：它按「本页是否 busy」重写状态位，
    // 而上一代行永远不 busy —— 不特判就会把 RUNNING 抹成 idle。
    live.updateBusyDots(host);
    expect(host.querySelector(".ws-worker-row.inherited .ws-worker-state")?.textContent).toBe("RUNNING");
    const own = Array.from(host.querySelectorAll(".ws-worker-row")).find((r) => !r.classList.contains("inherited"));
    expect(own?.querySelector(".ws-worker-state")?.textContent).toBe(t("shell.tree.idle"));
  });
});

describe("W1470b ②：会话页快捷条同样标记上一代", () => {
  it("inherited chip 带徽标，本代 chip 不带", () => {
    expect(strip.initWorkerStrip()).not.toBeNull();
    strip.updateWorkerStrip([ghostRow(), ownRow()]);
    const rows = Array.from(doc.querySelectorAll(".ws-strip-row"));
    expect(rows).toHaveLength(2);
    const ghost = rows.find((r) => r.dataset["id"] === GHOST);
    const own = rows.find((r) => r.dataset["id"] === OWN);
    expect(ghost?.classList.contains("inherited")).toBe(true);
    expect(ghost?.querySelector(".ws-strip-badge")?.textContent).toBe(t("shell.worker.inherited"));
    expect(ghost?.querySelector(".ws-strip-meta")?.textContent).toBe("RUNNING");
    expect(own?.classList.contains("inherited")).toBe(false);
    expect(own?.querySelector(".ws-strip-badge")).toBeNull();
  });
});

describe("W1470b ③：轮询签名对 status / inherited 敏感", () => {
  it("只有状态变化也要重建（P2 收口后不能停在旧状态）", () => {
    const base = util.workerSigOf([ghostRow()]);
    expect(util.workerSigOf([{ ...ghostRow(), status: "DONE" }])).not.toBe(base);
    expect(util.workerSigOf([{ ...ghostRow(), inherited: undefined }])).not.toBe(base);
    expect(util.workerSigOf([ghostRow()])).toBe(base);
  });
});

describe("W1470b ④：样式门禁（token 圆角 / 无虚线 / 颜色走 token）", () => {
  it("徽标规则只用 --r-* 圆角、无 dashed/dotted、颜色全部走 token", () => {
    for (const [file, selector] of [["views.css", ".ws-worker-badge"], ["workerstrip.css", ".ws-strip-badge"]] as const) {
      const text = css(file);
      const at2 = text.indexOf(selector + " {");
      expect(at2, file + " 必须有 " + selector + " 规则").toBeGreaterThan(-1);
      const body = text.slice(at2, text.indexOf("}", at2));
      expect(body).toContain("border-radius: var(--r-");
      expect(body).not.toMatch(/border-radius:\s*\d/);
      expect(body).not.toMatch(/\b(dashed|dotted)\b/);
      expect(body).toMatch(/color: var\(--c-/);
      expect(body).toMatch(/background: var\(--c-/);
    }
  });
});
