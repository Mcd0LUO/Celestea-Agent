// @vitest-environment jsdom
/**
 * W786 · 设置页「归档会话」pane 的接线 + 表单两列对齐（jsdom + CSS 源码断言）。
 *
 * 本机没有浏览器：CSS 观感无法验证，所以这里验的是**可机械断言的部分**——
 *   ① 真实 index.html 的 #app 全壳 + 真实 config.ts：点「归档会话」导航后，
 *      该 pane 渲染归档行、计数正确，且**不再**复刻侧栏会话树（.ws-tree 缺席）；
 *   ② 两列网格的几何**只有一个真源**（components.css 的 .cfg-field/.prov-field
 *      共用 --field-label-w），settings.css 里的分叉定义已删；
 *   ③ 真实 newsession.ts：弹窗每一行都是「首子节点 = 标签」的两列行（标题行已补齐），
 *      这是「标签与控件对齐」在 DOM 结构上的不变量。
 *
 * 与 tests/question-card-dom.test.ts 同一套路：根 tsconfig 不含 DOM lib，
 * 因此不用全局 `document`，而是把它按最小接口取用（真实运行时仍是 jsdom）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ShimEl {
  className: string;
  textContent: string | null;
  innerHTML: string;
  firstElementChild: ShimEl | null;
  getAttribute(name: string): string | null;
  querySelector(sel: string): ShimEl | null;
  querySelectorAll(sel: string): Iterable<ShimEl>;
  dispatchEvent(e: unknown): boolean;
  replaceChildren(): void;
}
interface ShimDom {
  body: ShimEl;
  getElementById(id: string): ShimEl | null;
  querySelector(sel: string): ShimEl | null;
}
interface ConfigModule {
  initSettingsPage(): void;
}
interface NewsessionModule {
  newSessionDialog(host: { loadSessions(): Promise<void> }, presetWs?: string): void;
}

const doc = (globalThis as unknown as { document: ShimDom }).document;
const Ev = (globalThis as unknown as { Event: new (t: string) => unknown }).Event;
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "apps/web");
const uiUrl = (p: string): string => pathToFileURL(join(WEB, "src/ui", p)).href;
const readCss = (p: string): string => readFileSync(join(WEB, "src/styles", p), "utf8");
const all = (root: ShimEl | null, sel: string): ShimEl[] => (root ? [...root.querySelectorAll(sel)] : []);
const ids = (root: ShimEl | null, sel: string): Array<string | null> =>
  all(root, sel).map((n) => n.getAttribute("data-id"));

/** 真实 index.html 的 body 片段（#app 全壳）—— 被加载模块在导入期会 need() 各种锚点。 */
function appMarkup(): string {
  const raw = readFileSync(join(WEB, "index.html"), "utf8");
  return raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

const SESSIONS = [
  { id: "ws-a/s1", title: "甲", workspace: "ws-a", archived: true, modified: 300 },
  { id: "ws-b/s2", title: "乙", workspace: "ws-b", archived: true, modified: 200 },
  { id: "ws-a/live", title: "在用", workspace: "ws-a", archived: false, modified: 999 },
];
const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  doc.body.innerHTML = appMarkup();
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, available: { models: [] }, sessions: SESSIONS }),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe("W786 设置页「归档会话」pane", () => {
  it("点导航后渲染归档行与计数，且不复刻侧栏会话树", async () => {
    const cfg = (await import(/* @vite-ignore */ uiUrl("config.ts"))) as ConfigModule;
    cfg.initSettingsPage();
    const nav = doc.querySelector('.settings-nav-item[data-page="archive"]');
    expect(nav?.textContent).toBe("归档会话");
    nav?.dispatchEvent(new Ev("click"));
    await wait();

    const box = doc.getElementById("settingsArchive");
    expect(ids(box, ".arc-row")).toEqual(["ws-a/s1", "ws-b/s2"]);
    expect(doc.getElementById("settingsArchiveCount")?.textContent).toBe("2");
    expect(box?.textContent ?? "").not.toContain("在用"); // 未归档不出现
    // 侧栏那套会话管理不再出现在这里
    expect(box?.querySelector(".ws-tree")).toBeNull();
    expect(box?.querySelector(".ws-search-input")).toBeNull();
    expect(box?.querySelector(".sess-batchbar")).toBeNull();
  });
});

describe("W786 表单两列对齐", () => {
  it("几何只有一处真源：--field-label-w，settings.css 里的分叉已删", () => {
    const comp = readCss("components.css");
    expect(comp).toMatch(
      /\.cfg-field,\s*\n\.prov-field\s*\{[^}]*grid-template-columns: var\(--field-label-w, 148px\) minmax\(0, 1fr\)/,
    );
    expect(comp).toMatch(/\.cfg-field \.cfg-label,\s*\n\.prov-field-label\s*\{/);
    expect(readCss("tokens.css")).toContain("--field-label-w: 148px;");

    const settings = readCss("settings.css");
    expect(settings).not.toMatch(/\.prov-field\s*\{[^}]*grid-template-columns/);
    expect(settings).not.toMatch(/\.cfg-field\s*\{[^}]*grid-template-columns/);
    expect(settings).toMatch(/\.arc-ws-head/); // 归档样式落在既有 css 文件，非内联
  });

  it("新建会话弹窗：每一行都是「首子节点 = 标签」的两列行（标题行已补齐）", async () => {
    const ns = (await import(/* @vite-ignore */ uiUrl("sessiontree/newsession.ts"))) as NewsessionModule;
    ns.newSessionDialog({ loadSessions: async () => undefined });
    const card = doc.querySelector(".modal-card");
    const rows = all(card, ".prov-field");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.firstElementChild?.className).toContain("prov-field-label");
    const labels = rows.map((r) => r.querySelector(".prov-field-label")?.textContent);
    expect(labels[0]).toBe("标题");
    expect(rows[0]?.querySelector("input")).not.toBeNull();
    expect(labels).toContain("工作区");
    expect(labels).toContain("模型");
  });
});
