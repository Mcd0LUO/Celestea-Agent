/**
 * W795 前端乐观更新的**共用测试夹具**（jsdom）。
 *
 * 为什么要单独一个文件：W795 的断言横跨三组（占位文案 / 权限面板 / statusline 与
 * 其余乐观交互），而本仓 eslint 对 `tests/**` 有单文件 400 行、单函数 80 行的硬上限
 * （`eslint.config.js` 的 ARCH_EXCEPTIONS 之外没有例外）。夹具抽出来后，每个测试文件
 * 各管一组断言，规模自然落在上限内。
 *
 * 这里只放**机制**（DOM 骨架、事件派发、真实 fetch 路径的打桩服务端、面板查询助手），
 * 不放任何断言 —— 断言全部留在 `*.test.ts` 里。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextEncoder } from "node:util";
import { vi } from "vitest";

export interface ClassList {
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, on?: boolean): boolean;
  contains(c: string): boolean;
}
export interface ElLike {
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  innerHTML: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  title: string;
  type: string;
  style: Record<string, unknown>;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  parentElement: ElLike | null;
  isConnected: boolean;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  contains(n: unknown): boolean;
  closest(sel: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
export interface DocLike {
  body: ElLike;
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const WEB = join(ROOT, "apps", "web");
/** 前端模块的 file URL（跨仓加载范式：pathToFileURL 动态 import，不复刻逻辑）。 */
export const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

export const doc = (globalThis as unknown as { document: DocLike }).document;
export const Ev = (
  globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }
).Event;

export const el = (id: string): ElLike => doc.getElementById(id) as ElLike;
export const all = (sel: string): ElLike[] => Array.from(doc.querySelectorAll(sel));
/**
 * 派发一次点击；`bubbles` 默认 false（避免触发 document 上的「点外部收起」）。
 *
 * W896：目标为 null 时**直接抛错**，不再静默 no-op。
 * 原来的 `if (n) …` 让「元素还没画出来」伪装成「点了但没反应」——后续断言读到的是
 * 上一帧状态，表现为随机 flake（6 路争用下真实复现：撤销失败的回执永远不出现）。
 * 抛错会立刻把「元素缺失」这个真因暴露在栈上。需要「允许缺失」的调用方请显式判空。
 */
export const click = (n: ElLike | null | undefined, bubbles = false): void => {
  if (!n) throw new Error("click(): the target element is missing (was it rendered yet?)");
  n.dispatchEvent(new Ev("click", { bubbles }));
};
/** 某选择器的可见文本（根 tsconfig 的 lib 里没有 DOM，测试一律经夹具访问 document）。 */
export const textOf = (sel: string): string => doc.querySelector(sel)?.textContent ?? "";
/** 排空微任务 + 若干宏任务：用于观察「请求已发出但还没回来」的中间态。 */
export const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 与 index.html 同构的最小骨架（statusline + 状态栏 + 会话容器）。 */
export const HTML =
  '<div id="app"><div id="layout"><aside id="sidebar">' +
  '<span class="sec-note" id="sessionCount">…</span><div class="side-body" id="sessionTree"></div></aside>' +
  '<main id="main"><div id="messages" tabindex="-1"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"><svg viewBox="0 0 14 14"><circle class="sl-ring-track"></circle>' +
  '<circle class="sl-ring-prog"></circle></svg></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slPerm" class="sl-perm hidden"><span class="sl-perm-badge" id="slPermBadge"></span></button>' +
  '<button id="slGrant" class="sl-grant hidden"><span class="sl-grant-badge" id="slGrantBadge"></span>' +
  '<span class="sl-grant-dot" id="slGrantDot"></span></button>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><span class="sl-tps" id="slTps">— tok/s</span>' +
  '<span class="sl-cache" id="slCache">缓存 —</span><span class="sl-steps" id="slSteps">— 步</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<textarea id="input" rows="2"></textarea></main></div>' +
  // W858：设置页「权限预设」pane 的最小宿主（与 index.html 的容器 id/class 一致）
  '<div id="settingsPage" class="settings-page hidden"><div class="settings-content">' +
  '<section class="settings-pane" data-pane="permissions">' +
  '<div class="settings-pane-body" id="settingsPermissions"></div></section></div></div>';

/** 打桩服务端的可调旋钮（真实模块走真实 fetch 路径，这里只提供「服务端事实」与故障注入）。 */
export interface Stub {
  calls: { url: string; method: string; body: string }[];
  onRequest: ((url: string, method: string, body: string) => void) | null;
  /** 已经真正落库的授权（GET /grants 只认它）。 */
  granted: Set<string>;
  grantFailCaps: Set<string>;
  grantHangCaps: Set<string>;
  revokeFail: boolean;
  revokeHang: boolean;
}
export const stub: Stub = {
  calls: [],
  onRequest: null,
  granted: new Set<string>(),
  grantFailCaps: new Set<string>(),
  grantHangCaps: new Set<string>(),
  revokeFail: false,
  revokeHang: false,
};
export const health = { value: { ok: true, capabilities: { grants: true, session_mode_tools: true, context: true } } };
export const statusBySession: Record<string, unknown> = {};
export const configStub = { resp: {} as Record<string, unknown>, saveStatus: 200 };
export const modeStub = { status: 200, payload: {} as unknown };
/**
 * W870：会话级模型切换端点（`PUT /api/sessions/{id}/model`）的旋钮。
 * 有聚焦会话时 picker 走这条路径（不再是 `POST /api/config`），所以「写入失败 /
 * 409 挂起」的故障注入必须打在这里，W795 的回滚断言才有东西可回滚。
 */
export const sessionModelStub = { status: 200, covered: true };

/** W858：一个权限预设（线格式与 contracts/endpoints.json 的 preset 一致）。 */
export interface StubPreset {
  id: string;
  label: string;
  network: boolean;
  workspaceWritable: boolean;
  toolRootsWritable: boolean;
  writeRoots: string[];
  allPaths: boolean;
  unsandboxed: boolean;
  toolDeny: string[];
}

/** W858：内置三档（与服务端 store/permissions.ts 的常量同值）。 */
export const PERM_BUILTIN: StubPreset[] = [
  { id: 'read-only', label: 'Read only', network: false, workspaceWritable: false, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: ['write_file'] },
  { id: 'write-read', label: 'Write + read (workspace)', network: false, workspaceWritable: true, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: [] },
  { id: 'full-access', label: 'Full access', network: true, workspaceWritable: true, toolRootsWritable: true, writeRoots: [], allPaths: true, unsandboxed: true, toolDeny: [] },
];

/** W858：权限预设 / 会话档位端点的旋钮与故障注入。 */
export const permStub = {
  custom: [] as StubPreset[],
  max: 'full-access',
  sessionPreset: 'full-access',
  createStatus: 200,
  createError: "invalid preset: bad",
  updateStatus: 200,
  updateError: 'no custom preset',
  deleteStatus: 200,
  deleteError: 'no custom preset',
  putStatus: 200,
  putError: "unknown preset 'read-only'",
  tools: ['read_file', 'write_file', 'bash'] as string[],
};

export const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const sessionOf = (url: string): string => {
  const m = /session=([^&]*)/.exec(url);
  return m?.[1] === undefined ? "" : decodeURIComponent(m[1]);
};

/** 复位夹具 + 装好 fetch 打桩（各测试文件的 beforeEach 调一次）。 */
export function resetHarness(): void {
  stub.calls = [];
  stub.onRequest = null;
  stub.granted = new Set<string>();
  stub.grantFailCaps = new Set<string>();
  stub.grantHangCaps = new Set<string>();
  stub.revokeFail = false;
  stub.revokeHang = false;
  health.value = { ok: true, capabilities: { grants: true, session_mode_tools: true, context: true } };
  for (const k of Object.keys(statusBySession)) delete statusBySession[k];
  configStub.resp = { ok: true, model: "", reasoning_effort: null, available: { models: [] } };
  configStub.saveStatus = 200;
  modeStub.status = 200;
  modeStub.payload = { ok: true, session: "ws/s1", mode: "execution", effective: "next_turn" };
  sessionModelStub.status = 200;
  sessionModelStub.covered = true;
  permStub.custom = [];
  permStub.max = 'full-access';
  permStub.sessionPreset = 'full-access';
  permStub.createStatus = 200;
  permStub.createError = "invalid preset: bad";
  permStub.updateStatus = 200;
  permStub.updateError = 'no custom preset';
  permStub.deleteStatus = 200;
  permStub.deleteError = 'no custom preset';
  permStub.putStatus = 200;
  permStub.putError = "unknown preset 'read-only'";
  permStub.tools = ['read_file', 'write_file', 'bash'];
  doc.body.innerHTML = HTML;
  vi.resetModules(); // 模块级单例（statusline / grants 状态）每个用例重建
  vi.stubGlobal("TextEncoder", TextEncoder); // scopeHashOf 需要（jsdom 环境不保证有）
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? "" : String(init.body);
    stub.calls.push({ url: u, method, body });
    stub.onRequest?.(u, method, body);
    if (u.startsWith("/api/health")) return reply(200, health.value);
    if (u.includes("/grants/confirm-token")) return reply(200, { ok: true, token: "tok-1" });
    if (u.endsWith("/grants")) return grantsRoute(method, body);
    if (u.startsWith("/api/status")) return reply(200, statusBySession[sessionOf(u)] ?? { ok: true });
    if (u.startsWith("/api/config")) return configRoute(method, body);
    if (u.endsWith("/mode")) return reply(modeStub.status, modeStub.payload);
    // W870：会话级模型切换（PUT /api/sessions/{id}/model）——必须先于下面的
    // /api/sessions 兜底分支判定，否则会被当成会话列表 200 掉。
    if (u.endsWith("/model")) return sessionModelRoute(method, body);
    // W858：工具清单（档位编辑器的 toolDeny 多选）+ 权限预设 / 会话档位
    if (u.startsWith("/api/tools")) {
      return reply(200, { ok: true, tools: permStub.tools.map((name) => ({ name })) });
    }
    if (u.startsWith("/api/permissions/presets") || /\/permission$/.test(u)) {
      return permissionRoute(u, method, body);
    }
    if (u.startsWith("/api/sessions")) return reply(200, { ok: true, sessions: [] });
    return reply(404, { ok: false });
  });
}

function grantsRoute(method: string, body: string): unknown {
  if (method === "POST") {
    const cap = String((JSON.parse(body === "" ? "{}" : body) as { cap?: string }).cap ?? "");
    if (stub.grantHangCaps.has(cap)) return new Promise(() => {}); // 请求在飞：永不返回
    if (stub.grantFailCaps.has(cap)) return reply(500, { ok: false, error: "grant write failed" });
    stub.granted.add(cap);
    return reply(200, { ok: true, grant: { cap, expires_at: null }, effective: {} });
  }
  if (method === "DELETE") {
    if (stub.revokeHang) return new Promise(() => {});
    if (stub.revokeFail) return reply(500, { ok: false, error: "revoke failed" });
    const cap = (JSON.parse(body === "" ? "{}" : body) as { cap?: string }).cap;
    if (cap === undefined) stub.granted.clear();
    else stub.granted.delete(String(cap));
    return reply(200, { ok: true, revoked: [String(cap ?? "all")], effective: {} });
  }
  return reply(200, {
    ok: true,
    grants: Array.from(stub.granted, (cap) => ({ cap, scope: {}, expires_at: null })),
    effective: {},
    max_ttl_sec: {},
  });
}

/** W858：权限预设 CRUD + 会话档位（GET/PUT）的打桩实现。 */
function permissionRoute(url: string, method: string, body: string): unknown {
  const parsed = (): Record<string, unknown> => {
    try {
      return JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  if (url.startsWith('/api/permissions/presets')) {
    const id = decodeURIComponent(url.slice('/api/permissions/presets'.length).replace(/^\//, ''));
    if (method === 'POST') {
      if (permStub.createStatus !== 200) {
        return reply(permStub.createStatus, { ok: false, error: permStub.createError });
      }
      const preset = parsed()['preset'] as StubPreset;
      permStub.custom = [...permStub.custom, preset];
      return reply(200, { ok: true, preset });
    }
    if (method === 'PUT') {
      if (permStub.updateStatus !== 200) {
        return reply(permStub.updateStatus, { ok: false, error: permStub.updateError });
      }
      const preset = parsed()['preset'] as StubPreset;
      permStub.custom = permStub.custom.map((p) => (p.id === id ? preset : p));
      return reply(200, { ok: true, preset });
    }
    if (method === 'DELETE') {
      if (permStub.deleteStatus !== 200) {
        return reply(permStub.deleteStatus, { ok: false, error: permStub.deleteError });
      }
      permStub.custom = permStub.custom.filter((p) => p.id !== id);
      return reply(200, { ok: true, deleted: id });
    }
    return reply(200, { ok: true, builtin: PERM_BUILTIN, custom: permStub.custom, max: permStub.max });
  }
  const m = /^\/api\/sessions\/(.+)\/permission$/.exec(url);
  if (m) {
    if (method === 'PUT') {
      if (permStub.putStatus !== 200) {
        return reply(permStub.putStatus, { ok: false, error: permStub.putError });
      }
      const preset = String(parsed()['preset'] ?? '');
      permStub.sessionPreset = preset;
      return reply(200, { ok: true, preset, effective: {} });
    }
    return reply(200, {
      ok: true,
      session: decodeURIComponent(m[1] ?? ''),
      preset: permStub.sessionPreset,
      effective: {},
    });
  }
  return reply(404, { ok: false });
}

function configRoute(method: string, body: string): unknown {
  if (method === "POST") {
    if (configStub.saveStatus !== 200) return reply(configStub.saveStatus, { ok: false, error: "config write failed" });
    configStub.resp = { ...configStub.resp, ...(JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>) };
    return reply(200, configStub.resp);
  }
  return reply(200, configStub.resp);
}

/**
 * W870：`PUT /api/sessions/{id}/model` 的打桩实现（含 409 / 写入失败两种注入）。
 * 写入成功后把`configStub.resp.model` 一起改掉 —— 徽标下一次 `/api/status` 轮询读的是
 * **会话**的值，这条桩只是让「配置快照」与之一致，避免测试自身制造出 W870 那个 bug。
 */
function sessionModelRoute(method: string, body: string): unknown {
  if (method !== "PUT") return reply(405, { ok: false });
  if (sessionModelStub.status !== 200) {
    return reply(sessionModelStub.status, { ok: false, error: "turn 进行中，无法切换模型" });
  }
  const asked = String((JSON.parse(body === "" ? "{}" : body) as { model?: unknown }).model ?? "");
  const model = asked !== "" ? asked : String(configStub.resp["model"] ?? "");
  configStub.resp = { ...configStub.resp, model };
  return reply(200, {
    ok: true,
    session: "ws/s1",
    model,
    covered: sessionModelStub.covered,
    effective: { model, base_model: model, source: sessionModelStub.covered ? "session" : "global", next_turn: true },
  });
}

// ---- 权限面板查询助手（断言留在 *.test.ts） -------------------------------------

export const panel = (): ElLike | null => doc.querySelector("#statusline .grant-popup");
export const panelText = (): string => panel()?.textContent ?? "";
export const rowOf = (cap: string): ElLike =>
  doc.querySelector('#statusline .grant-row[data-cap="' + cap + '"]') as ElLike;
export const badgeOf = (cap: string): string =>
  rowOf(cap)?.querySelector(".grant-badge")?.textContent ?? "(无此行)";
export const btnWith = (cap: string, label: string): ElLike | null => {
  const row = rowOf(cap);
  if (!row) return null;
  return (
    Array.from(row.querySelectorAll(".grant-row-actions button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    ) ?? null
  );
};
export const note = (): string =>
  doc.querySelector("#statusline .grant-popup .sl-popup-status")?.textContent ?? "";
export const shieldBadge = (): string => el("slGrantBadge").textContent ?? "";
export const confirmOk = (): ElLike | null =>
  doc.querySelector(".confirm-card .modal-card-actions button.btn-danger") ??
  doc.querySelector(".confirm-card .modal-card-actions button.btn-accent");
export const presetBtn = (label: string): ElLike | null =>
  all("#statusline .grant-preset").find(
    (b) => (b.querySelector(".grant-preset-label")?.textContent ?? "") === label,
  ) ?? null;

/**
 * 轮询等待一个条件成立（上限 5s），返回它拿到的值。
 *
 * W896：本夹具的 `click()` 对 null 是**静默 no-op**，而面板行/确认弹窗都来自异步
 * refresh —— 负载下固定 flush 常常还没画出目标元素，于是点击静默落空、请求根本没发出，
 * 后续断言读到的是上一帧状态（6 路 CPU 争用下复现：撤销失败的回执永远不出现，等到 5s 超时）。
 * 用这个助手等**元素真的存在**再点，把「猜宏任务数」换成「等事实成立」。
 *
 * 超时给 15s（不是 vi.waitFor 默认的 1s）：它是**上限**，正常路径立即返回；只在宿主被
 * 极端挤压时才会用到（12 路 CPU 争用 + 26 文件并行下，一次面板 refresh 可能远超 1s）。
 * 仍远小于用例的 30s testTimeout，所以「真的坏了」依旧会快速失败。
 */
export async function waitForValue<T>(probe: () => T | null | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await flush(1);
  }
}

/** 走真实 UI 路径授予一项（点行内「授予」→ 确认弹窗点「授予」）。 */
export async function grantViaUi(cap: string): Promise<void> {
  // W896：先等行内按钮真的画出来（面板 refresh 是异步的），否则 click() 静默落空。
  const grant = await waitForValue(() => btnWith(cap, "授予") ?? btnWith(cap, "选择目录"), "the grant button for " + cap);
  click(grant);
  const ok = await waitForValue(() => confirmOk(), "the confirm dialog");
  click(ok);
  // W896：等到「这次授予真的落定」再返回。
  //
  // 为什么必须等：flow.grant 在乐观重绘之后还有一段**尾随续作**
  // （await submitGrant → optimisticSettle → setPanelNote(successText) → await host.refresh）。
  // 若本函数在请求仍挂着时就返回，调用方紧接着发起的撤销会把 note 写成「撤销失败」，
  // 随后那次尾随 setPanelNote 又把它**覆盖**回成功文案 —— 表现为随机 flake
  // （12 路 CPU 争用下 30 次复现 1 次：note 始终等不到「撤销失败」）。
  // 判据是「授予请求已落定」：成功 ⇒ 徽标为「已授予」；失败 ⇒ 失败文案出现。
  // 两者取其一即返回（**不**假定成功）—— 失败注入的用例同样需要这一步来避开尾随续作。
  await waitForValue(
    () => (badgeOf(cap).startsWith("已授予") || note().includes("失败") ? true : null),
    "the grant to settle for " + cap,
  );
  await flush(2);
}

// ---- 模块装配助手（真实模块；动态 import 见各测试文件） -------------------------

export interface GrantsMod {
  initGrants(): void;
  stopGrants(): void;
  grantsCapability(): "unknown" | "on" | "off";
}
export interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
export interface SlMod {
  statusline: { setSession(id: string): void; merge(p: Record<string, unknown>): void; stop(): void };
}

/** 聚焦一个真实会话 + 装配提权通道（真实 ui/grants.ts），并等首次快照落定。 */
export async function bootGrants(session = "ws/s1"): Promise<GrantsMod> {
  const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as ViewCtxMod;
  ctx.initViewCtx();
  ctx.ensurePane(session, "session", "甲会话");
  ctx.activatePane(session, "session", "甲会话");
  const grants = (await import(/* @vite-ignore */ at("ui/grants.ts"))) as GrantsMod;
  grants.initGrants();
  await flush(); // health → 能力位就绪 → 首次权限快照
  return grants;
}
