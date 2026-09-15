// @vitest-environment jsdom
/**
 * W792 · 归档会话管理 + 删除/归档的乐观交互 —— **对真实运行服务**的端到端回归。
 *
 * 与 W786 的 tests/settings-archive-pane.test.ts 的关键区别：本文件**不造假数据**。
 * 每一次断言的数据都来自真实 HTTP（缺省 http://127.0.0.1:3777，可用 CELESTEA_E2E_BASE
 * 覆盖）。这里唯一的 fetch 包装器只做两件事：把相对路径补成绝对 URL（node 的 fetch 不
 * 解析相对 URL）、把「方法 + 路径」记账 —— 它**不构造任何响应**，一律转发给真服务，
 * 数据面因此 100% 真实。服务不可达时整个文件跳过（并打印提示），绝不用桩数据假装通过。
 *
 * 覆盖的缺陷（用户实测上报的 item 1 前端半边）：
 *   ① 归档面板用缺省列表取数 ⇒ 恒为空（实测缺省响应体里连 archived 键都没有）；
 *   ② POST /api/sessions/batch-delete **永远 200**，删除失败只装在
 *      {ok:true,deleted:0,failed:[{id,error}]} 里 —— 前端不看响应体就「点了删除，
 *      界面既没报错也没变化」（静默失败）。
 *   ③ 交互口径（用户裁决）：确认后**立即**生效（乐观移除、无「…中」占位），失败才回滚。
 *
 * 自建会话一律以 w792- 开头（工作区 CelesteaTeamAPI），收尾时连回收目录条目一并清理。
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// ---- 最小 DOM 接口（根 tsconfig 不含 DOM lib；真实运行时仍是 jsdom） ----------------
interface ClassList {
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
  contains(c: string): boolean;
}
interface El {
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  disabled: boolean;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  children: ArrayLike<El>;
  appendChild(n: El): El;
  append(...n: El[]): void;
  replaceChildren(...n: El[]): void;
  remove(): void;
  focus(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Doc {
  body: El & { innerHTML: string };
  createElement(t: string): El;
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}

const doc = (globalThis as unknown as { document: Doc }).document;
const Ev = (globalThis as unknown as { Event: new (t: string) => unknown }).Event;
const click = (n: El | null | undefined): void => void n?.dispatchEvent(new Ev("click"));
const text = (n: El | null | undefined): string => n?.textContent ?? "";
// Array.from（不是展开运算符）：根 tsconfig 只有 lib:ES2023、无 DOM lib，ArrayLike 不可迭代。
const all = (root: El | null, sel: string): El[] =>
  root ? Array.from(root.querySelectorAll(sel)) : [];
const ids = (root: El | null, sel: string): Array<string | undefined> =>
  all(root, sel).map((n) => n.dataset["id"]);
const wait = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 真实服务接线 ----------------------------------------------------------------
const BASE = process.env["CELESTEA_E2E_BASE"] ?? "http://127.0.0.1:3777";
const WS = "CelesteaTeamAPI";
const TRASH = join("/src", WS, ".celestea-trash");
const STAMP = String(Date.now()).slice(-7);

/** 已发出的请求（方法 + 路径）：证明归档面板走的是哪个端点。 */
const seen: Array<{ method: string; path: string }> = [];
/**
 * 请求**离开发出前**的探针（本地服务毫秒级返回，光靠 setTimeout 无法证明
 * 「行先没了、请求后发」）。用法：设一个取值函数，等操作结束后断言它记下的快照。
 */
let atRequest: (() => string) | null = null;
let observedAtRequest = "";
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
  const raw =
    typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  const abs = /^https?:/.test(raw) ? raw : BASE + raw;
  const path = abs.startsWith(BASE) ? abs.slice(BASE.length) : abs;
  seen.push({ method: String(init?.method ?? "GET").toUpperCase(), path });
  if (String(init?.method ?? "GET").toUpperCase() === "POST" && atRequest) {
    observedAtRequest = atRequest();
    atRequest = null;
  }
  return await realFetch(abs, init); // ← 真 HTTP：本包装器只补 base 与记账，不造响应
});

interface Res {
  status: number;
  body: Record<string, unknown> | null;
}
async function req(path: string, init?: { method?: string; body?: string }): Promise<Res> {
  const r = await fetch(path, init);
  let body: Record<string, unknown> | null = null;
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}
const post = (p: string, b: unknown): Promise<Res> => req(p, { method: "POST", body: JSON.stringify(b) });

// ---- 生产模块（pathToFileURL 动态 import：跑的是真源码，不是复刻） ------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

interface Row {
  id?: string;
  title?: string;
  workspace?: string | null;
  archived?: boolean;
  modified?: number;
}
interface FailedItem {
  id?: string;
  error?: string;
}
interface ApiModule {
  api: {
    sessions(opts?: { archived?: boolean }): Promise<{ sessions?: Row[] }>;
    createSession(r: unknown): Promise<{ ok?: boolean; id?: string }>;
    archiveSession(id: string): Promise<{ ok?: boolean }>;
    unarchiveSession(id: string): Promise<{ ok?: boolean }>;
    batchDeleteSessions(ids: string[]): Promise<Record<string, unknown>>;
  };
}
interface RowsModule {
  archivedRows(sessions: readonly Row[] | undefined | null): Row[];
  archiveEmptyText(): string;
}
interface PanelModule {
  loadArchiveSection(container: El, countEl: El | null, opts?: { quiet?: boolean }): Promise<void>;
}
interface TreeHost {
  newSession(presetWs?: string): void;
  newWorkspace(): void;
  loadTreeInto(container: El, countEl: El | null): Promise<void>;
  loadSessions(): Promise<void>;
}
interface ActionsModule {
  deleteSession(host: TreeHost, container: El, id: string, label: string): Promise<void>;
  batchDelete(host: TreeHost, container: El): Promise<void>;
  archiveSession(host: TreeHost, container: El, id: string, label: string): Promise<void>;
}
interface StoreModule {
  selected: Set<string>;
  setBatchMode(v: boolean): void;
}

// 有的模块在**导入期**就 need() 页面锚点（ui/statusbar.ts 等），所以先立好 #app 骨架再导入。
mountDom();

const { api } = (await import(/* @vite-ignore */ at("api.ts"))) as ApiModule;
const rows = (await import(/* @vite-ignore */ at("ui/archive/rows.ts"))) as RowsModule;
const panel = (await import(/* @vite-ignore */ at("ui/archive/panel.ts"))) as PanelModule;
const actions = (await import(/* @vite-ignore */ at("ui/sessiontree/actions.ts"))) as ActionsModule;
const store = (await import(/* @vite-ignore */ at("ui/sessiontree/store.ts"))) as StoreModule;

/** 真实 index.html 的 #app 全壳（真锚点：#settingsArchive / #settingsArchiveCount / #sideFoot）。 */
function mountDom(): void {
  const raw = readFileSync(join(WEB, "index.html"), "utf8");
  doc.body.innerHTML = raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

/** 桩 host：只记账，不碰网络、不返回数据（不构成造假数据）。 */
const hostCalls: string[] = [];
function host(): TreeHost {
  return {
    newSession: () => hostCalls.push("newSession"),
    newWorkspace: () => hostCalls.push("newWorkspace"),
    loadTreeInto: async () => void hostCalls.push("loadTreeInto"),
    loadSessions: async () => void hostCalls.push("loadSessions"),
  };
}

/** 最小会话树骨架（与 render.ts 同构：details.ws-details > summary > .ws-count，行 = .sess-leaf[data-id]）。 */
interface TreeBox {
  container: El;
  leaf(id: string): El | null;
  wsCount(): string;
}
function buildTree(leafIds: string[]): TreeBox {
  const container = doc.createElement("div");
  const details = doc.createElement("details");
  details.className = "ws-details";
  const sum = doc.createElement("summary");
  const count = doc.createElement("span");
  count.className = "ws-count";
  count.textContent = String(leafIds.length);
  sum.appendChild(count);
  details.appendChild(sum);
  for (const id of leafIds) {
    const leaf = doc.createElement("div");
    leaf.className = "sess-leaf";
    leaf.dataset["id"] = id;
    details.appendChild(leaf);
  }
  container.appendChild(details);
  doc.body.appendChild(container);
  return {
    container,
    leaf: (id: string) => all(container, ".sess-leaf").find((n) => n.dataset["id"] === id) ?? null,
    wsCount: () => text(count),
  };
}

/** 确认为**危险**动作的弹窗按钮（删除）；其余确认框用 .btn-accent。 */
const confirmDanger = (): El | null => doc.body.querySelector(".modal-card-actions .btn-danger");
const confirmOk = (): El | null => doc.body.querySelector(".modal-card-actions .btn-accent");

// ---- 可达性探测（不可达 ⇒ 整体跳过，绝不伪造） --------------------------------------
let LIVE = false;
try {
  const h = await req("/api/health");
  LIVE = h.status === 200;
} catch {
  LIVE = false;
}
if (!LIVE) console.warn("[W792] 真实服务不可达，端到端用例整体跳过：" + BASE);

/** 本轮创建的会话 id（收尾清理用）。 */
const created: string[] = [];
async function createSession(suffix: string): Promise<string> {
  const r = await api.createSession({ workspace: WS, title: "w792-e2e-" + suffix + "-" + STAMP });
  const id = String(r.id ?? "");
  expect(id, "建会话失败：" + JSON.stringify(r)).not.toBe("");
  created.push(id);
  return id;
}
const listedIds = async (path: string): Promise<string[]> =>
  (((await req(path)).body?.["sessions"] ?? []) as Row[]).map((r) => String(r.id ?? ""));

const live = LIVE ? describe : describe.skip;

/** 面板用例共用的那条归档会话。 */
let panelId = "";

afterAll(async () => {
  if (!LIVE) return;
  // 我建的会话若还在（缺省或归档列表里）⇒ 真删掉；随后清掉回收目录里我的条目。
  try {
    const alive = new Set([
      ...(await listedIds("/api/sessions")),
      ...(await listedIds("/api/sessions?archived=1")),
    ]);
    const left = created.filter((id) => alive.has(id));
    if (left.length > 0) await post("/api/sessions/batch-delete", { ids: left });
  } catch {
    /* 清理尽力而为：失败不影响验收结论 */
  }
  try {
    for (const name of readdirSync(TRASH)) {
      if (/^w792-/.test(name)) rmSync(join(TRASH, name), { recursive: true, force: true });
    }
  } catch {
    /* 回收目录可能不存在 */
  }
  vi.unstubAllGlobals();
});

live("W792 · 真实服务：归档面板（item 1 前端半边）", () => {

  it("真实响应形状：缺省列表不含归档行、连 archived 键都没有；?archived=1 才有", async () => {
    panelId = await createSession("panel");
    await api.archiveSession(panelId);

    const def = await req("/api/sessions");
    const defRows = (def.body?.["sessions"] ?? []) as Row[];
    expect(def.status).toBe(200);
    expect(defRows.some((r) => r.id === panelId), "缺省列表不该出现归档会话").toBe(false);
    // 缺省响应体冻结：**连 archived 键都没有**（这正是「拿缺省列表筛 archived」恒空的原因）
    expect(defRows.every((r) => !("archived" in r))).toBe(true);

    const arch = await req("/api/sessions?archived=1");
    expect(arch.status).toBe(200);
    const archRow = ((arch.body?.["sessions"] ?? []) as Row[]).find((r) => r.id === panelId);
    expect(archRow?.archived, "归档列表里每行必须带 archived:true").toBe(true);

    // 根因对照：修前的取数路径（缺省列表 + archivedRows 过滤）恒为空，
    // 而修后的取数路径（?archived=1 + 同一过滤器）拿得到这一行。
    expect(rows.archivedRows(defRows)).toEqual([]);
    expect(
      rows.archivedRows((await api.sessions({ archived: true })).sessions).map((r) => r.id),
    ).toContain(panelId);
  });

  it("归档面板：用 ?archived=1 取数并列出真实归档会话（修前这里恒为空）", async () => {
    mountDom();
    const box = doc.getElementById("settingsArchive");
    const count = doc.getElementById("settingsArchiveCount");
    expect(box).not.toBeNull();

    seen.length = 0;
    await panel.loadArchiveSection(box as El, count);
    // 取数端点：必须是归档列表（缺省列表里没有这一行，见上一条用例）
    expect(seen.map((c) => c.method + " " + c.path)).toContain("GET /api/sessions?archived=1");
    // 真的列出来了
    expect(ids(box, ".arc-row")).toContain(panelId);
    expect(text(box)).not.toContain(rows.archiveEmptyText());
    expect(text(count)).toBe(String(all(box, ".arc-row").length));
    const row = all(box, ".arc-row").find((r) => r.dataset["id"] === panelId);
    expect(text(row)).toContain("w792-e2e-panel-" + STAMP); // 行文案 = 标题
    // 反证：它确实不在缺省列表里 —— 若面板回头改拿缺省列表，上面的断言必然失败
    expect(await listedIds("/api/sessions")).not.toContain(panelId);
    expect(await listedIds("/api/sessions?archived=1")).toContain(panelId);
  });

  it("归档面板删除：确认后立即消失（无加载占位），服务端也真的删掉了", async () => {
    mountDom();
    const box = doc.getElementById("settingsArchive") as El;
    const hint = doc.getElementById("settingsArchiveHint");
    const count = doc.getElementById("settingsArchiveCount");
    await panel.loadArchiveSection(box, count);
    const row = all(box, ".arc-row").find((r) => r.dataset["id"] === panelId);
    expect(row, "面板里应有该归档会话").toBeTruthy();

    click(all(row as El, ".btn-mini.danger")[0] ?? null); // 「删除」
    await wait(20);
    expect(text(doc.body.querySelector(".modal-card"))).toContain("w792-e2e-panel-" + STAMP);
    const beforeCount = Number(text(count)); // 面板计数（别的 worker 也在动归档，别写死数字）
    observedAtRequest = "";
    atRequest = () =>
      (ids(box, ".arc-row").includes(panelId) ? "行仍在" : "行已移除") + "/计数 " + text(count);
    click(confirmDanger());
    await Promise.resolve();
    expect(text(count), "不该出现「…」加载占位").not.toBe("…");

    await wait(200);
    expect(observedAtRequest).toBe("行已移除/计数 " + String(beforeCount - 1));
    expect(text(hint)).toContain("已删除会话");
    expect(await listedIds("/api/sessions?archived=1")).not.toContain(panelId);
    expect(await listedIds("/api/sessions")).not.toContain(panelId);
    expect(ids(doc.getElementById("settingsArchive"), ".arc-row")).not.toContain(panelId);
  });

  it("恢复路径：归档 → 面板「恢复」→ 回到缺省列表、不再出现在归档列表", async () => {
    const id = await createSession("restore");
    await api.archiveSession(id);
    expect(await listedIds("/api/sessions?archived=1")).toContain(id);

    mountDom();
    const box = doc.getElementById("settingsArchive") as El;
    await panel.loadArchiveSection(box, doc.getElementById("settingsArchiveCount"));
    const row = all(box, ".arc-row").find((r) => r.dataset["id"] === id);
    expect(row, "归档后应能在面板里看到它").toBeTruthy();

    click(all(row as El, ".btn-mini")[0] ?? null); // 「恢复」（每行第一个按钮）
    await wait(20);
    click(confirmOk());
    await wait(200);

    expect(await listedIds("/api/sessions?archived=1")).not.toContain(id);
    expect(await listedIds("/api/sessions")).toContain(id);
    expect(text(doc.getElementById("settingsArchiveHint"))).toContain("已恢复会话");
  });

});

/** 会话树里的删除/归档动作：确认即生效（乐观）+ 失败可见 + 回滚。 */
live("W792 · 真实服务：会话树的删除/归档动作", () => {
  it("会话树归档：行立即消失，归档面板随之多出这一行（成功不重载整棵树）", async () => {
    const id = await createSession("fromtree");
    mountDom();
    const box = doc.getElementById("settingsArchive") as El;
    await panel.loadArchiveSection(box, doc.getElementById("settingsArchiveCount"));
    expect(ids(box, ".arc-row")).not.toContain(id);

    const tree = buildTree([id]);
    hostCalls.length = 0;
    const done = actions.archiveSession(host(), tree.container, id, "w792-e2e-fromtree-" + STAMP);
    await wait(20);
    click(confirmOk()); // 归档确认框不是危险样式
    await wait(5);
    expect(tree.leaf(id), "确认后应立即从树里消失（乐观更新）").toBeNull();
    await done;
    await wait(300); // refreshArchivePane() 是即发即忘的静默刷新
    expect(ids(doc.getElementById("settingsArchive"), ".arc-row")).toContain(id);
    expect(hostCalls, "成功路径不做整树重载").not.toContain("loadTreeInto");
  });

  it("删除失败必须可见：行先消失、失败后插回原位并说明原因（端点仍返回 200）", async () => {
    const ghost = WS + "/w792-ghost-" + STAMP;
    // 先钉住真实响应形状：HTTP 200 + ok:true + failed[] —— 前端 catch 永远不触发
    const raw = await post("/api/sessions/batch-delete", { ids: [ghost] });
    expect(raw.status).toBe(200);
    expect(raw.body?.["ok"]).toBe(true);
    const failed = (raw.body?.["failed"] ?? []) as FailedItem[];
    expect(failed.length).toBe(1);
    expect(String(failed[0]?.id)).toContain("w792-ghost-" + STAMP);

    mountDom();
    const foot = doc.getElementById("sideFoot") as El;
    foot.textContent = "";
    const tree = buildTree([ghost]);
    const done = actions.deleteSession(host(), tree.container, ghost, "w792-ghost-" + STAMP);
    await wait(20);
    observedAtRequest = "";
    atRequest = () => (tree.leaf(ghost) ? "行仍在" : "行已移除") + "/计数 " + tree.wsCount();
    click(confirmDanger());
    await Promise.resolve();
    expect(text(foot), "不该出现「删除中…」类占位").not.toContain("删除中");

    await done;
    await wait(200);
    // 修前：这里没有任何提示（静默失败）、行也不回来；修后：失败可见 + 行回原位
    expect(text(foot), "删除失败必须呈现给用户，不得静默吞掉").toContain("删除失败");
    expect(text(foot)).toContain("已不存在");
    // 乐观更新：请求离开客户端时，行已经不在 DOM 里、分组计数也已减去
    expect(observedAtRequest).toBe("行已移除/计数 0");
    expect(tree.leaf(ghost), "失败必须把行插回原位").not.toBeNull();
    expect(tree.wsCount()).toBe("1");
  });

  it("批量删除部分失败：失败项回原位并保持勾选，成功项保持消失", async () => {
    const real = await createSession("batchgone");
    const ghost = WS + "/w792-batch-ghost-" + STAMP;
    mountDom();
    const foot = doc.getElementById("sideFoot") as El;
    foot.textContent = "";
    const tree = buildTree([real, ghost]);
    store.setBatchMode(true);
    store.selected.clear();
    store.selected.add(real);
    store.selected.add(ghost);

    const done = actions.batchDelete(host(), tree.container);
    await wait(20);
    observedAtRequest = "";
    atRequest = () =>
      (tree.leaf(real) ? "真行在" : "真行没了") + "/" + (tree.leaf(ghost) ? "幽灵在" : "幽灵没了");
    click(confirmDanger());
    await Promise.resolve();
    expect(text(foot)).not.toContain("删除中");

    await done;
    await wait(200);
    expect(text(foot)).toContain("删除失败");
    expect(text(foot)).toContain("已成功 1 个");
    expect(observedAtRequest).toBe("真行没了/幽灵没了"); // 乐观：请求发出前两行都先没了
    expect(tree.leaf(ghost), "失败项回原位").not.toBeNull();
    expect(tree.leaf(real), "成功项保持消失").toBeNull();
    expect(store.selected.has(ghost), "失败项应保持勾选，便于修正后重试").toBe(true);
    expect(store.selected.has(real)).toBe(false);
    expect(await listedIds("/api/sessions")).not.toContain(real);
  });

  it("删除成功：非活动会话立即消失、服务端真的没了，且不重载整棵树", async () => {
    const id = await createSession("gone");
    mountDom();
    const foot = doc.getElementById("sideFoot") as El;
    foot.textContent = "";
    const tree = buildTree([id]);
    hostCalls.length = 0;

    const done = actions.deleteSession(host(), tree.container, id, "w792-e2e-gone-" + STAMP);
    await wait(20);
    observedAtRequest = "";
    atRequest = () => (tree.leaf(id) ? "行仍在" : "行已移除") + "/计数 " + tree.wsCount();
    click(confirmDanger());
    await Promise.resolve();
    expect(text(foot)).not.toContain("删除中");

    await done;
    await wait(200);
    expect(text(foot)).toContain("已删除会话");
    expect(text(foot)).not.toContain("删除失败");
    expect(observedAtRequest).toBe("行已移除/计数 0");
    expect(hostCalls, "成功路径不做整树重载").not.toContain("loadTreeInto");
    expect(await listedIds("/api/sessions")).not.toContain(id);
    expect(await listedIds("/api/sessions?archived=1")).not.toContain(id);
  });
});
