// @vitest-environment jsdom
/**
 * W786 · 设置页「归档会话管理」：纯逻辑 + 真实 DOM（jsdom）。
 *
 * 本机没有浏览器（CSS 视觉无法验证），所以这里能验的全部验掉：
 *   ① 纯派生逻辑（过滤 archived / 按工作区分组 / 排序 / 计数 / 空态 / 确认文案）
 *      —— 直接跑生产模块 apps/web/src/ui/archive/rows.ts；
 *   ② 真实 DOM 行为（渲染分组行、恢复 / 删除按钮、二次确认、竞态守卫、错误与空态）
 *      —— 动态加载生产模块 archive/panel.ts，fetch 打桩，派发真实 click 事件。
 *
 * W792 强化（本文件的桩不再是「一张响应喂所有请求」）：
 *   · 桩按**真实端点的形状**分流：`GET /api/sessions?archived=1` 才回归档行（每行带
 *     `archived:true`）；缺省 `GET /api/sessions` 回未归档行且**连 archived 键都没有**
 *     （2026-09-16 对运行中的 3777 实测的响应形状）—— 面板若回头改拿缺省列表，本文件
 *     立刻变红；
 *   · 桩按真实语义改动「服务端」状态（unarchive 移出归档、batch-delete 真的删掉，
 *     并可指定某些 id 回 `failed[]`）—— 面板「以服务端为准重列」才有意义；
 *   · 新增 `failed[]` 非空 ⇒ 提示可见 + 行回原位的用例。
 *
 * 仍未覆盖：CSS 布局/观感（jsdom 不加载样式表）—— 见报告「未验证」一节。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DomEl {
  id: string;
  textContent: string | null;
  className: string;
  dataset: Record<string, string>;
  open: boolean;
  disabled: boolean;
  type: string;
  value: string;
  classList: { add(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  appendChild(n: DomEl): DomEl;
  append(...n: DomEl[]): void;
  replaceChildren(...n: DomEl[]): void;
  remove(): void;
  focus(): void;
  addEventListener(t: string, fn: (e?: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  querySelector(sel: string): DomEl | null;
  querySelectorAll(sel: string): Iterable<DomEl>;
}
interface Dom {
  createElement(tag: string): DomEl;
  getElementById(id: string): DomEl | null;
  body: DomEl;
}
interface RowsModule {
  archivedRows(sessions: unknown): Array<Record<string, unknown>>;
  groupArchived(rows: unknown): Array<{ workspace: string; rows: Array<Record<string, unknown>> }>;
  rowLabel(s: Record<string, unknown>): string;
  workspaceOf(s: Record<string, unknown>): string;
  tailOf(id: unknown): string;
  archiveCountText(n: number): string;
  isEmptyArchive(rows: unknown): boolean;
  archiveEmptyText(): string;
  restoreConfirmText(label: string): string;
  archiveDeleteConfirmText(label: string): string;
}
interface PanelModule {
  loadArchiveSection(container: DomEl, countEl: DomEl | null): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const uiUrl = (p: string): string => pathToFileURL(join(HERE, "..", "apps/web/src/ui", p)).href;
const rows = (await import(/* @vite-ignore */ uiUrl("archive/rows.ts"))) as RowsModule;
const panel = (await import(/* @vite-ignore */ uiUrl("archive/panel.ts"))) as PanelModule;

const doc = (globalThis as unknown as { document: Dom }).document;
const Ev = (globalThis as unknown as { Event: new (t: string) => unknown }).Event;
const click = (n: DomEl | null): void => void n?.dispatchEvent(new Ev("click"));
const text = (n: DomEl | null): string => n?.textContent ?? "";
const wait = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 三个已归档（两个工作区）+ 一个在用 + 一个缺 archived 位 + 一个归档 worker。 */
const SESSIONS: Array<Record<string, unknown>> = [
  { id: "ws-a/s1", title: "甲", workspace: "ws-a", archived: true, modified: 300 },
  { id: "ws-b/s2", title: "乙", workspace: "ws-b", archived: true, modified: 100 },
  { id: "ws-a/s3", title: "", workspace: "ws-a", archived: true, modified: 200 },
  { id: "ws-a/live", title: "在用", workspace: "ws-a", archived: false, modified: 999 },
  { id: "root/s5", title: "字段缺失", modified: 50 },
  { id: "ws-a/w1", title: "W1·worker", workspace: "ws-a", kind: "worker", archived: true, modified: 10 },
];

let calls: Array<{ url: string; method: string; body: string }>;
let status = 200;
let payload: unknown = { ok: true };
/** 「服务端」当前的会话集合（忠实仿真 3777 的两条列表端点 + 两个动作端点）。 */
let live: Array<Record<string, unknown>> = [];
/** 让 batch-delete 对这几个 id 回 failed[]（模拟删除被拒：HTTP 仍 200 + ok:true）。 */
let failIds: string[] = [];

/** 缺省列表的行：**连 archived 键都没有**（与 3777 实测一致）。 */
function stripArchived(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (k !== "archived") out[k] = v;
  return out;
}
function idOf(url: string, suffix: string): string {
  const head = "/api/sessions/";
  return decodeURIComponent(url.slice(head.length, url.length - suffix.length));
}

beforeEach(() => {
  calls = [];
  status = 200;
  payload = { ok: true };
  live = SESSIONS.map((s) => ({ ...s }));
  failIds = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({
      url: u,
      method,
      body: init?.body === undefined ? "" : String(init.body),
    });
    if (status >= 400) return { ok: false, status, json: async () => payload };

    // GET /api/sessions[?archived=1] —— 归档端点/缺省列表的真实形状
    if (method === "GET" && u.startsWith("/api/sessions")) {
      const wantArchived = u.includes("archived=1");
      const rows = live
        .filter((s) => (s.archived === true) === wantArchived)
        .map((s) => (wantArchived ? { ...s, archived: true } : stripArchived(s)));
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: rows }) };
    }
    // POST /api/sessions/{id}/unarchive —— 真的移出归档
    if (method === "POST" && u.endsWith("/unarchive")) {
      const id = idOf(u, "/unarchive");
      live = live.map((s) => (s.id === id ? { ...s, archived: false } : s));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    // POST /api/sessions/batch-delete —— 真的删掉；指定 id 回 failed[]（**HTTP 仍 200**）
    if (method === "POST" && u.endsWith("/batch-delete")) {
      const ids = ((JSON.parse(String(init?.body ?? "{}")) as { ids?: string[] }).ids ?? []).slice();
      const failed = ids
        .filter((id) => failIds.includes(id))
        .map((id) => ({ id, error: "unknown session '" + id + "'" }));
      const gone = ids.filter((id) => !failIds.includes(id));
      live = live.filter((s) => !gone.includes(String(s.id)));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted: gone.length, failed }),
      };
    }
    return { ok: true, status: 200, json: async () => payload };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

interface Harness { container: DomEl; count: DomEl }
function mount(): Harness {
  const container = doc.createElement("div");
  const count = doc.createElement("div");
  const hint = doc.createElement("div");
  hint.id = "settingsArchiveHint";
  doc.body.append(container, count, hint);
  return { container, count };
}
const rowFor = (h: Harness, id: string): DomEl | null =>
  h.container.querySelector('.arc-row[data-id="' + id + '"]');
const okBtn = (): DomEl | null => doc.body.querySelector(".modal-card-actions .btn-accent");
const cancelBtn = (): DomEl | null => doc.body.querySelector(".modal-card-actions .btn-soft");

describe("W786 归档会话管理的纯逻辑", () => {
  it("只留 archived === true 的行，按最近活跃降序，字段缺失/未归档一律排除", () => {
    const got = rows.archivedRows(SESSIONS);
    expect(got.map((s) => s.id)).toEqual(["ws-a/s1", "ws-a/s3", "ws-b/s2", "ws-a/w1"]);
    expect(rows.archivedRows(undefined)).toEqual([]);
    expect(rows.archivedRows(null)).toEqual([]);
  });

  it("按工作区分组：组名升序，组内沿用最近活跃序", () => {
    const groups = rows.groupArchived(rows.archivedRows(SESSIONS));
    expect(groups.map((g) => g.workspace)).toEqual(["ws-a", "ws-b"]);
    expect(groups[0]?.rows.map((s) => s.id)).toEqual(["ws-a/s1", "ws-a/s3", "ws-a/w1"]);
    expect(groups[1]?.rows.map((s) => s.id)).toEqual(["ws-b/s2"]);
  });

  it("空工作区归入 root，标题缺失回退 id 末段", () => {
    expect(rows.workspaceOf({ id: "x", workspace: "   " })).toBe("root");
    expect(rows.workspaceOf({ id: "x", workspace: "ws-a" })).toBe("ws-a");
    expect(rows.rowLabel({ id: "ws-a/s3", title: "  " })).toBe("s3");
    expect(rows.rowLabel({ id: "ws-a/s3", title: "甲" })).toBe("甲");
    expect(rows.tailOf("ws-a/s3")).toBe("s3");
    expect(rows.tailOf("plain")).toBe("plain");
  });

  it("计数 / 空态 / 确认文案", () => {
    expect(rows.archiveCountText(3)).toBe("3");
    expect(rows.archiveCountText(0)).toBe("—");
    expect(rows.archiveEmptyText()).toBe("暂无归档会话");
    expect(rows.isEmptyArchive([])).toBe(true);
    expect(rows.isEmptyArchive(rows.archivedRows(SESSIONS))).toBe(false);
    expect(rows.restoreConfirmText("甲")).toContain("甲");
    expect(rows.archiveDeleteConfirmText("乙")).toContain("乙");
  });
});

describe("W786 归档会话管理的 DOM 行为", () => {
  it("只渲染已归档行、按工作区分组、计数与空态", async () => {
    const h = mount();
    await panel.loadArchiveSection(h.container, h.count);
    expect(h.count.textContent).toBe("4");
    expect([...h.container.querySelectorAll(".arc-ws-name")].map(text)).toEqual(["ws-a", "ws-b"]);
    expect([...h.container.querySelectorAll(".arc-row")].map((r) => r.dataset.id)).toEqual([
      "ws-a/s1", "ws-a/s3", "ws-a/w1", "ws-b/s2",
    ]);
    // 未归档 / archived 位缺失 ⇒ 不出现
    expect(text(h.container)).not.toContain("在用");
    expect(text(h.container)).not.toContain("字段缺失");
    // 侧栏专属功能不在这里
    expect(h.container.querySelector(".ws-search-input")).toBeNull();
    expect(text(h.container.querySelector(".arc-row") ?? null)).toContain("甲");

    live = [{ id: "s", title: "无归档", archived: false }]; // 「服务端」只剩未归档会话
    await panel.loadArchiveSection(h.container, h.count);
    expect(h.count.textContent).toBe("—");
    expect(text(h.container)).toContain(rows.archiveEmptyText());
  });

  it("恢复：确认后 POST unarchive 并按服务端重列（确认框默认落在取消）", async () => {
    const h = mount();
    await panel.loadArchiveSection(h.container, h.count);
    click(rowFor(h, "ws-a/s1")?.querySelector(".btn-mini") ?? null);
    await wait(5);
    expect(calls).toHaveLength(1); // 只有首次列表请求，尚未发动作请求

    click(cancelBtn());
    await wait(5);
    expect(calls).toHaveLength(1); // 取消 ⇒ 不发请求，也不刷新

    click(rowFor(h, "ws-a/s1")?.querySelector(".btn-mini") ?? null);
    await wait(5);
    click(okBtn());
    await wait(30);
    expect(calls.map((c) => c.method + " " + c.url)).toEqual([
      "GET /api/sessions?archived=1", // W792：取数走归档端点（缺省列表里没有归档行）
      "POST /api/sessions/ws-a%2Fs1/unarchive",
      "GET /api/sessions?archived=1",
    ]);
    expect(text(doc.getElementById("settingsArchiveHint"))).toBe("已恢复会话：甲");
    // 以服务端为准重列：恢复掉的那行不再出现
    expect(rowFor(h, "ws-a/s1")).toBeNull();
    expect([...h.container.querySelectorAll(".arc-row")].length).toBe(3);
  });

  it("删除：二次确认（危险按钮）后 POST batch-delete，载荷为 ids 数组", async () => {
    const h = mount();
    await panel.loadArchiveSection(h.container, h.count);
    click(rowFor(h, "ws-b/s2")?.querySelector(".btn-mini.danger") ?? null);
    await wait(5);
    expect(text(doc.body.querySelector(".modal-card"))).toContain("乙");
    click(doc.body.querySelector(".modal-card-actions .btn-danger"));
    await wait(30);
    const del = calls.find((c) => c.url.includes("batch-delete"));
    expect(del?.method).toBe("POST");
    expect(JSON.parse(del?.body ?? "{}")).toEqual({ ids: ["ws-b/s2"] });
    expect(text(doc.getElementById("settingsArchiveHint"))).toBe("已删除会话：乙");
    expect(rowFor(h, "ws-b/s2"), "删成功就该从归档列表消失").toBeNull();
    // 取数只走归档端点：整个用例里没有一次「缺省列表」请求
    expect(calls.filter((c) => c.method === "GET").every((c) => c.url.includes("archived=1"))).toBe(true);
  });

  it("删除被拒（failed[] 非空，HTTP 仍 200）：提示失败并把行插回原位", async () => {
    const h = mount();
    await panel.loadArchiveSection(h.container, h.count);
    const row = rowFor(h, "ws-b/s2");
    expect(row).not.toBeNull();
    failIds = ["ws-b/s2"]; // 「服务端」拒绝删这一条（batch-delete 依旧返回 200）
    click(row?.querySelector(".btn-mini.danger") ?? null);
    await wait(5);
    click(doc.body.querySelector(".modal-card-actions .btn-danger"));
    await wait(60);
    const hint = text(doc.getElementById("settingsArchiveHint"));
    expect(hint, "失败必须可见，不得静默吞掉").toContain("删除失败");
    expect(hint).toContain("已不存在");
    expect(rowFor(h, "ws-b/s2"), "失败要把行插回原位").not.toBeNull();
    expect([...h.container.querySelectorAll(".arc-row")].length).toBe(4);
  });

  it("竞态守卫：晚到的旧结果被丢弃，不覆盖新列表", async () => {
    const releases: Array<() => void> = [];
    let n = 0;
    const archived = SESSIONS.filter((x) => x.archived === true).map((x) => ({ ...x, archived: true }));
    vi.stubGlobal("fetch", async () => {
      n += 1;
      const mine = n;
      await new Promise<void>((res) => releases.push(() => res()));
      return {
        ok: true,
        status: 200,
        json: async () => (mine === 1 ? { ok: true, sessions: [] } : { ok: true, sessions: archived }),
      };
    });
    const h = mount();
    const stale = panel.loadArchiveSection(h.container, h.count);
    const fresh = panel.loadArchiveSection(h.container, h.count);
    releases[1]?.(); // 新请求先回
    await fresh;
    releases[0]?.(); // 旧请求晚到
    await stale;
    expect([...h.container.querySelectorAll(".arc-row")].length).toBe(4);
  });

  it("列表不可用：优雅降级文案 + 计数位 `—`", async () => {
    status = 500;
    payload = { ok: false, error: "boom" };
    const h = mount();
    await panel.loadArchiveSection(h.container, h.count);
    expect(h.count.textContent).toBe("—");
    expect(text(h.container)).toContain("归档会话暂不可用");
  });
});
