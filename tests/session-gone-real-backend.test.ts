// @vitest-environment jsdom
/**
 * W792 · 删除/归档**当前聚焦（且服务端 active）会话**之后的收尾 —— 对真实 3777 的端到端回归。
 *
 * 背景：W794 起后端允许直接删活动会话（删前 abort 在飞回合），删/归档后 `active_session`
 * 变为 null。前端因此必须自己收干净，且**不得**替用户自动切到「最近会话」：
 *   · `S.selSession` / store 的 activeSession（树高亮的真源）指向已消失的会话 → 清空；
 *   · 视图容器 `.sess-pane[data-session=<id>]`（草稿/滚动位/工具卡）→ 丢弃；
 *   · 会话树残留的 `.active/.sel`（设置页还有一棵树副本）→ 抹掉；
 *   · 主视图表现：焦点回到**无语义的 LOCAL 空态**（选择理由见报告）。
 *
 * 本文件**零造假数据**：数据面全走真 HTTP（唯一 fetch 包装器只把相对路径补成绝对 URL 并记账）；
 * 服务不可达时整文件跳过。用例会短暂把服务端 active 会话设为自己建的临时会话，
 * `afterAll` 里**拨回**测试开始时的那个（用户要求为 CelesteaTeamAPI/中转哥-…），
 * 并真删自己建的会话、清掉 `.celestea-trash` 里自己的条目。
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { E2E_OPT_IN, reachable, requireOptIn } from "./lib/real-backend-gate.js";

// ---- 最小 DOM 接口（根 tsconfig 不含 DOM lib；真实运行时仍是 jsdom） ----------------
interface ClassList {
  add(c: string): void;
  remove(c: string): void;
  contains(c: string): boolean;
}
interface El {
  id: string;
  className: string;
  textContent: string | null;
  hidden: boolean;
  value: string;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  appendChild(n: El): El;
  append(...n: El[]): void;
  remove(): void;
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
const all = (root: El | null, sel: string): El[] => (root ? Array.from(root.querySelectorAll(sel)) : []);
const wait = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 真实服务接线 ----------------------------------------------------------------
const BASE = process.env["CELESTEA_E2E_BASE"] ?? "http://127.0.0.1:3777";
const WS = "CelesteaTeamAPI";
const TRASH = join("/src", WS, ".celestea-trash");
const STAMP = String(Date.now()).slice(-7);
/** 用户要求的收尾状态（测试开始时的 active 若不是它，就拨回测试开始时的那个）。 */
const WANT_ACTIVE = "CelesteaTeamAPI/中转哥-1789192958.416000000";

const seen: Array<{ method: string; path: string }> = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
  const raw =
    typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  const abs = /^https?:/.test(raw) ? raw : BASE + raw;
  seen.push({
    method: String(init?.method ?? "GET").toUpperCase(),
    path: abs.startsWith(BASE) ? abs.slice(BASE.length) : abs,
  });
  return await realFetch(abs, init); // ← 真 HTTP：只补 base 与记账，不造响应
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
const enc = (id: string): string => encodeURIComponent(id);

// ---- 生产模块（pathToFileURL 动态 import：跑的是真源码，不是复刻） ------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

interface Row {
  id?: string;
  title?: string;
  workspace?: string | null;
  active?: boolean;
  archived?: boolean;
  kind?: string;
}
interface Pane {
  id: string;
  el: El;
}
interface ViewModule {
  initViewCtx(): Pane;
  activeSessionId(): string;
  activePane(): Pane | null;
  paneOf(id: string): Pane | undefined;
}
interface TreeHost {
  newSession(presetWs?: string): void;
  newWorkspace(): void;
  loadTreeInto(container: El, countEl: El | null): Promise<void>;
  loadSessions(): Promise<void>;
}
interface ActionsModule {
  deleteSession(host: TreeHost, container: El, id: string, label: string): Promise<void>;
  archiveSession(host: TreeHost, container: El, id: string, label: string): Promise<void>;
}
interface StoreModule {
  setActiveSession(v: string | null): void;
  getActiveSession(): string | null;
}
interface RestoreModule {
  openSession(id: string, meta?: { kind?: string; title?: string }): Pane;
}
interface RenderModule {
  renderLeaf(host: TreeHost, container: El, s: Row): El;
}
interface ApiModule {
  api: {
    sessions(opts?: { archived?: boolean }): Promise<{ sessions?: Row[]; active_session?: string | null }>;
    createSession(r: unknown): Promise<{ ok?: boolean; id?: string }>;
    activateSession(id: string): Promise<{ ok?: boolean }>;
    batchDeleteSessions(ids: string[]): Promise<Record<string, unknown>>;
  };
}

/** 真实 index.html 的 #app 全壳（真锚点：#messages / #sessionTree / #sideFoot / #input …）。 */
function mountDom(): void {
  const raw = readFileSync(join(WEB, "index.html"), "utf8");
  doc.body.innerHTML = raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

// 有的模块在**导入期**就 need() 页面锚点，所以先立好骨架再导入。
mountDom();

const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as ViewModule;
const actions = (await import(/* @vite-ignore */ at("ui/sessiontree/actions.ts"))) as ActionsModule;
const store = (await import(/* @vite-ignore */ at("ui/sessiontree/store.ts"))) as StoreModule;
const restore = (await import(/* @vite-ignore */ at("ui/restore.ts"))) as RestoreModule;
const render = (await import(/* @vite-ignore */ at("ui/sessiontree/render.ts"))) as RenderModule;
const { api } = (await import(/* @vite-ignore */ at("api.ts"))) as ApiModule;
const { S } = (await import(/* @vite-ignore */ at("state.ts"))) as { S: { selSession: string | null } };

/** 视图容器宿主（真实初始化路径：在 #messages 里建 LOCAL 容器）。 */
view.initViewCtx();

/** 桩 host：只记账，不碰网络、不返回数据（不构成造假数据）。 */
const host = (): TreeHost => ({
  newSession: () => undefined,
  newWorkspace: () => undefined,
  loadTreeInto: async () => undefined,
  loadSessions: async () => undefined,
});
const confirmDanger = (): El | null => doc.body.querySelector(".modal-card-actions .btn-danger");
const confirmOk = (): El | null => doc.body.querySelector(".modal-card-actions .btn-accent");

// ---- 可达性探测（W862 显式选入：未选入零 HTTP + 可见跳过；门禁真源见 lib/real-backend-gate） ----
requireOptIn("W792");
let capturedActive = "";
const LIVE = await reachable(async () => {
  const h = await req("/api/sessions");
  capturedActive = String(h.body?.["active_session"] ?? "");
  return h.status === 200;
}, "W792", BASE);

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
const activeOnServer = async (): Promise<string | null> =>
  (await req("/api/sessions")).body?.["active_session"] as string | null;

/** 让服务端把该会话设为 active（真机端点），并确认真成了。 */
async function makeActive(id: string): Promise<void> {
  const r = await post("/api/sessions/" + enc(id) + "/activate", {});
  expect(r.status, "激活失败：" + JSON.stringify(r.body)).toBe(200);
  expect(await activeOnServer()).toBe(id);
}

/**
 * 把前端置于「正在看该会话」的真实状态：真开容器 + store/S 镜像 + 两棵树各渲染一行
 * （用**真实** renderLeaf，行上的 .active/.sel 与生产完全一致）。
 */
function focusSession(id: string, title: string): { treeA: El; leafA: El; leafB: El } {
  restore.openSession(id, { kind: "session", title });
  store.setActiveSession(id);
  S.selSession = id;
  const treeA = doc.createElement("div");
  const treeB = doc.createElement("div");
  doc.body.appendChild(treeA);
  doc.body.appendChild(treeB);
  const row: Row = { id, title, workspace: WS, kind: "session" };
  // 必须真的挂进容器：renderLeaf 只负责造行，挂载是调用方的事（与生产同一分工）
  const leafA = render.renderLeaf(host(), treeA, row);
  treeA.appendChild(leafA);
  const leafB = render.renderLeaf(host(), treeB, row);
  treeB.appendChild(leafB);
  expect(leafA.className).toContain("active");
  expect(leafA.className).toContain("sel");
  expect(view.activeSessionId()).toBe(id);
  expect(doc.querySelector('.sess-pane[data-session="' + id + '"]')).not.toBeNull();
  return { treeA, leafA, leafB };
}

/** 会话消失后，三处状态 + 主视图都必须收干净，且**没有**自动切到任何别的会话。 */
function expectCleaned(id: string, leafB: El): void {
  expect(S.selSession, "S.selSession 不许还指着已消失的会话").toBeNull();
  expect(store.getActiveSession(), "store 的 active 不许还指着它").toBeNull();
  expect(view.activeSessionId(), "焦点必须回到无语义的 LOCAL（不自动切会话）").toBe("");
  expect(view.paneOf(id), "视图容器必须被丢弃").toBeUndefined();
  expect(doc.querySelector('.sess-pane[data-session="' + id + '"]')).toBeNull();
  expect(leafB.classList.contains("active"), "另一棵树副本的高亮也要清").toBe(false);
  expect(leafB.classList.contains("sel")).toBe(false);
  // 主视图表现（本轮选择）：可见的中立空态，而不是把已删会话的内容留在屏幕上假装还在
  const pane = view.activePane();
  expect(pane?.id).toBe("");
  const hint = pane?.el.querySelector(".empty-hint");
  expect(hint, "主视图应显示空态").not.toBeNull();
  expect(hint?.classList.contains("hidden")).toBe(false);
}

// 兜底门禁：只有显式选入才收集执行；未选入时整文件 VISIBLE skip（不是静默消失）。
const live = describe.skipIf(!E2E_OPT_IN);

live("W792 · 真实服务：删掉「正在看的活动会话」之后的收尾", () => {
  it("删除活动会话：active_session 归 null，前端不留选中/高亮/视图态，也不自动切会话", async () => {
    const title = "w792-e2e-delactive-" + STAMP;
    const id = await createSession("delactive");
    await makeActive(id);
    const { treeA, leafB } = focusSession(id, title);

    const done = actions.deleteSession(host(), treeA, id, title);
    await wait(20);
    click(confirmDanger());
    await done;
    await wait(300);

    // 服务端：真的删掉了，且活动会话归 null（W794 行为）
    const def = await req("/api/sessions");
    expect(def.body?.["active_session"], "删掉活动会话后 active_session 必须为 null").toBeNull();
    expect(((def.body?.["sessions"] ?? []) as Row[]).map((r) => r.id)).not.toContain(id);
    expect(await listedIds("/api/sessions?archived=1")).not.toContain(id);
    // 前端：三处状态 + 主视图
    expectCleaned(id, leafB);
    expect(text(doc.getElementById("sideFoot"))).toContain("已删除会话");
  });
});

live("W792 · 真实服务：归档「正在看的活动会话」之后的收尾", () => {
  it("归档活动会话：会话进归档列表、active_session 归 null，前端同样收干净", async () => {
    const title = "w792-e2e-arcactive-" + STAMP;
    const id = await createSession("arcactive");
    await makeActive(id);
    const { treeA, leafB } = focusSession(id, title);

    const done = actions.archiveSession(host(), treeA, id, title);
    await wait(20);
    click(confirmOk()); // 归档确认框不是危险样式
    await done;
    await wait(300);

    // 服务端：会话真的进归档（还在，只是离开当前集合），且活动会话归 null
    expect(await listedIds("/api/sessions?archived=1")).toContain(id);
    expect(await listedIds("/api/sessions")).not.toContain(id);
    expect(await activeOnServer(), "归档掉活动会话后 active_session 必须为 null").toBeNull();
    // 前端：与删除同款的收尾
    expectCleaned(id, leafB);
    expect(text(doc.getElementById("sideFoot"))).toContain("已归档会话");
  });
});

/** 把 active_session 拨回 target：重试 3 次；失败抛出（不是只断言），让清理继续跑再统一上报。 */
async function restoreActiveWithRetry(target: string): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const r = await post("/api/sessions/" + enc(target) + "/activate", {});
      if (r.status === 200 && (await activeOnServer()) === target) {
        console.log("[W792] 活动会话已拨回：" + target);
        return;
      }
      last = "status=" + r.status + " body=" + JSON.stringify(r.body);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await wait(300);
  }
  throw new Error("active_session 拨回失败（重试 3 次）：target=" + target + " last=" + last);
}

/** 真删本套件建的临时会话，并复核两个列表都不再包含它们；删不干净就抛出。 */
async function deleteCreatedSessions(): Promise<void> {
  const alive = new Set([...(await listedIds("/api/sessions")), ...(await listedIds("/api/sessions?archived=1"))]);
  const left = created.filter((id) => alive.has(id));
  if (left.length > 0) await post("/api/sessions/batch-delete", { ids: left });
  const after = new Set([...(await listedIds("/api/sessions")), ...(await listedIds("/api/sessions?archived=1"))]);
  const stuck = created.filter((id) => after.has(id));
  if (stuck.length > 0) throw new Error("临时会话未删干净：" + stuck.join(", "));
}

function cleanTrash(): void {
  try {
    for (const name of readdirSync(TRASH)) {
      if (/^w792-/.test(name)) rmSync(join(TRASH, name), { recursive: true, force: true });
    }
  } catch {
    /* 回收目录可能不存在 */
  }
}

afterAll(async () => {
  if (!LIVE) return;
  const target = capturedActive !== "" ? capturedActive : WANT_ACTIVE;
  const problems: string[] = [];
  try {
    // 每步独立 catch：一步失败不许跳过后面的清理；最后统一上报（绝不绿色掩盖）。
    try { await restoreActiveWithRetry(target); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
    try { await deleteCreatedSessions(); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
    try { cleanTrash(); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  } finally {
    vi.unstubAllGlobals();
  }
  if (problems.length > 0) throw new Error("[W792] real-backend cleanup failed: " + problems.join(" | "));
});
