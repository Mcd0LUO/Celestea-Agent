// @vitest-environment jsdom
/**
 * R3 W838 · B5（web 附件生命周期）—— 第 9 批前端修复的验收测试。
 *
 * 为什么单开文件：这些用例原计划追加进 tests/multimodal-attachments-dom.test.ts，
 * 但该文件会因此超过 eslint 的 max-lines 400（480 行），故按仓库规矩拆到本文件；
 * 用例内容与探针语义一字未改。
 *
 * 来源：/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 *   B5 验收探针：F1/F11 revoke 生命周期、F2 读失败不静默丢、F3 失败回滚原会话、
 *   F4 config-saved 重算能力位、F8 同批只拒溢出项。全部用 jsdom + pathToFileURL
 *   加载真实模块，驱动真实 dispatchSend / 真实事件派发，不复刻逻辑。
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
  value: string;
  disabled: boolean;
  hidden: boolean;
  title: string;
  type: string;
  accept: string;
  multiple: boolean;
  style: Record<string, unknown>;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  firstChild: ElLike | null;
  nextSibling: ElLike | null;
  parentElement: ElLike | null;
  children: ArrayLike<ElLike>;
  childElementCount: number;
  insertBefore(n: ElLike, ref: ElLike | null): ElLike;
  appendChild(n: ElLike): ElLike;
  append(...n: ElLike[]): void;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  contains(n: unknown): boolean;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface DocLike {
  body: ElLike & { innerHTML: string };
  createElement(t: string): ElLike;
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  addEventListener(t: string, f: (e: unknown) => void): void;
}
interface Net {
  health: Record<string, unknown>;
  config: Record<string, unknown>;
  providers: Record<string, unknown>;
  turnStatus: number;
  turnPayload: Record<string, unknown>;
}

const doc = (globalThis as unknown as { document: DocLike }).document;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;
const FileCtor = (globalThis as unknown as { File: new (...a: unknown[]) => unknown }).File;
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

const HTML =
  '<div id="app"><div id="layout"><main id="main"><div id="messages"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ring" id="slRing"></span><span class="sl-ctx" id="slCtx">—/—</span>' +
  '<button class="sl-model" id="slModel">—</button><button class="sl-effort" id="slEffort">—</button>' +
  '<button class="sl-mode hidden" id="slMode"></button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><div id="sessionBar" class="session-bar"></div>' +
  '<span class="sl-tps" id="slTps">—</span><span class="sl-cache" id="slCache">—</span>' +
  '<span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<div id="inputbar"><textarea id="input" rows="2"></textarea>' +
  '<div class="input-side"><button id="btnMode" class="btn btn-soft btn-mini hidden">插话</button>' +
  '<button id="btnCancel" class="btn btn-soft hidden">取消</button>' +
  '<button id="btnSend" class="btn btn-accent">发送</button></div></div></main></div></div>';

const net: Net = {
  health: { ok: true, capabilities: { multimodal: true } },
  config: { ok: true, model: "glm-5.3-flash" },
  providers: { ok: true, providers: [] },
  turnStatus: 202,
  turnPayload: { ok: true, turn: 1 },
};
const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const makeFile = (name: string, type: string, bytes = [1, 2, 3, 4]): unknown =>
  new FileCtor([new Uint8Array(bytes)], name, { type });

function installGlobals(): void {
  net.health = { ok: true, capabilities: { multimodal: true } };
  net.config = { ok: true, model: "glm-5.3-flash" };
  net.providers = { ok: true, providers: [] };
  net.turnStatus = 202;
  net.turnPayload = { ok: true, turn: 1 };
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.startsWith("/api/health")) return reply(200, net.health);
    if (u.startsWith("/api/config")) return reply(200, net.config);
    if (u.startsWith("/api/providers")) return reply(200, net.providers);
    if (u.startsWith("/api/status")) return reply(200, { ok: true });
    if (u === "/api/turn") return reply(net.turnStatus, net.turnPayload);
    return reply(200, { ok: true });
  });
  const url = globalThis.URL as unknown as {
    createObjectURL?: (f: unknown) => string;
    revokeObjectURL?: (u: string) => void;
  };
  url.createObjectURL = () => "blob:w805";
  url.revokeObjectURL = () => {};
}

interface InputbarMod {
  initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
  refreshAttachmentEntry(): void;
  refreshAttachmentTray(): void;
}
async function bootInputbar(): Promise<{ bar: InputbarMod; view: { activeSessionId(): string } }> {
  const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
    initViewCtx(): void;
    ensurePane(id: string, kind?: string, title?: string): unknown;
    activatePane(id: string, kind?: string, title?: string): unknown;
    activeSessionId(): string;
  };
  view.initViewCtx();
  view.ensurePane("ws/s1", "session", "甲会话");
  view.activatePane("ws/s1", "session", "甲会话");
  const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as InputbarMod;
  bar.initInputBar({ send: () => {}, cancel: () => {} });
  return { bar, view };
}

const trayItems = (): number => Array.from(doc.querySelectorAll(".attach-tray .attach-item")).length;
// ============================================================================
// R3 W838 · B5 —— 附件模块生命周期（第 9 批 web 前端）
// 来源：/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
//   的 B5 验收探针（F1/F11 revoke 生命周期、F2 读失败不静默丢、F3 失败回滚原会话、
//   F4 config-saved 重算能力位、F8 同批只拒溢出项）。全部走真实模块 + 真实路径。
// ============================================================================

interface R3AttMod {
  addFiles(f: ArrayLike<unknown>): number;
  pendingList(): Array<{ url: string; id: string }>;
  pendingCount(): number;
  removePending(i: { url: string; id: string }): void;
  clearPending(): void;
  attachmentViewsOf(refs: unknown[]): Array<{ url?: string }>;
}
interface R3BarMod {
  refreshAttachmentTray(): void;
}
interface R3SendMod {
  dispatchSend(t: string, m: string): void;
}
interface R3ViewMod {
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface R3ReaderStub {
  onload: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  result: string | null;
}

const importAtt = async (): Promise<R3AttMod> =>
  (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as unknown as R3AttMod;
const importBar = async (): Promise<R3BarMod> =>
  (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as unknown as R3BarMod;
const importSend = async (): Promise<R3SendMod> =>
  (await import(/* @vite-ignore */ at("ui/send.ts"))) as unknown as R3SendMod;
const r3RefOf = (id: string): unknown => ({ attachment_id: id, media_type: "image/png", width: 4, height: 4 });

function uniqueObjectUrls(): { revoked: string[] } {
  const revoked: string[] = [];
  let n = 0;
  const u = globalThis.URL as unknown as {
    createObjectURL?: (f: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };
  u.createObjectURL = () => "blob:w838-" + ++n;
  u.revokeObjectURL = (url: string) => { revoked.push(url); };
  return { revoked };
}

function trackFetch(calls: string[]): void {
  const base = globalThis.fetch as unknown as (u: unknown, i?: unknown) => Promise<unknown>;
  vi.stubGlobal("fetch", (u: unknown, i?: unknown) => { calls.push(String(u)); return base(u, i); });
}

const firstPending = (att: R3AttMod): { url: string; id: string } | undefined =>
  (att.pendingList() as Array<{ url: string; id: string }>)[0];

describe("R3 W838-F1/F11 · objectURL 吊销 + previews 回收", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("removePending 吊销该项 URL 并从预览表删除（F11：去掉 revoke 即变红）", async () => {
    const { revoked } = uniqueObjectUrls();
    await bootInputbar();
    await flush(10);
    const att = await importAtt();
    att.addFiles([makeFile("a.png", "image/png")]);
    await flush(20);
    const item = firstPending(att);
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.url).toBe("blob:w838-1");
    expect(att.attachmentViewsOf([r3RefOf(item.id)])[0]?.url).toBe(item.url);
    att.removePending(item);
    expect(revoked).toContain(item.url);
    expect(att.attachmentViewsOf([r3RefOf(item.id)])[0]?.url).toBeUndefined();
    expect(att.pendingList().length).toBe(0);
  });

  it("clearPending 吊销本会话全部待发 URL 并回收预览", async () => {
    const { revoked } = uniqueObjectUrls();
    await bootInputbar();
    await flush(10);
    const att = await importAtt();
    att.addFiles([makeFile("a.png", "image/png"), makeFile("b.png", "image/png")]);
    await flush(20);
    const items = att.pendingList();
    expect(items.map((i) => i.url)).toEqual(["blob:w838-1", "blob:w838-2"]);
    att.clearPending();
    expect(revoked).toEqual(expect.arrayContaining(["blob:w838-1", "blob:w838-2"]));
    for (const it of items) expect(att.attachmentViewsOf([r3RefOf(it.id)])[0]?.url).toBeUndefined();
  });

  it("切会话回收上一会话的预览 URL", async () => {
    const { revoked } = uniqueObjectUrls();
    const booted = (await bootInputbar()) as unknown as { view: R3ViewMod; bar: R3BarMod };
    await flush(10);
    const att = await importAtt();
    att.addFiles([makeFile("a.png", "image/png")]);
    await flush(20);
    const item = firstPending(att);
    expect(item).toBeDefined();
    if (!item) return;
    booted.view.activatePane("ws/s2", "session", "乙会话");
    expect(revoked).toContain(item.url);
    expect(att.attachmentViewsOf([r3RefOf(item.id)])[0]?.url).toBeUndefined();
  });
});

describe("R3 W838-F2 · 读失败不静默丢附件", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("FileReader 失败 → 不发 /api/turn、提示可见、附件留待发区", async () => {
    await bootInputbar();
    await flush(10);
    const att = await importAtt();
    att.addFiles([makeFile("bad.png", "image/png")]);
    (await importBar()).refreshAttachmentTray();
    vi.stubGlobal("FileReader", class {
      onload: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      result: string | null = null;
      readAsDataURL(): void {
        const self = this as unknown as R3ReaderStub;
        setTimeout(() => { if (self.onerror) self.onerror(new Ev("error")); }, 0);
      }
    });
    const calls: string[] = [];
    trackFetch(calls);
    (doc.getElementById("input") as ElLike).value = "看图";
    (await importSend()).dispatchSend("看图", "steer");
    await flush(24);
    expect(calls.indexOf("/api/turn")).toBe(-1);
    expect(att.pendingList().length).toBe(1);
    const info = Array.from(doc.querySelectorAll(".msg.info")).map((e) => e.textContent ?? "").join("\n");
    expect(info).toContain("读取失败");
  });
});

describe("R3 W838-F3 · 失败回滚到原会话", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("await 期间切会话 → 附件回到原会话，不串到当前会话", async () => {
    const booted = (await bootInputbar()) as unknown as { view: R3ViewMod; bar: R3BarMod };
    await flush(10);
    const att = await importAtt();
    att.addFiles([makeFile("shot.png", "image/png")]);
    (await importBar()).refreshAttachmentTray();
    net.turnStatus = 500;
    net.turnPayload = { ok: false, error: "boom" };
    (doc.getElementById("input") as ElLike).value = "看图";
    (await importSend()).dispatchSend("看图", "steer"); // 会话 A = ws/s1
    booted.view.activatePane("ws/s2", "session", "乙会话"); // await 期间切到 B
    await flush(24);
    expect(att.pendingList().length).toBe(0); // B 的待发区没被串图
    booted.view.activatePane("ws/s1", "session", "甲会话");
    expect(att.pendingList().length).toBe(1); // 回到 A
    (await importBar()).refreshAttachmentTray(); // 真机由 chat.ts 的 onPaneChange 触发
    expect(trayItems()).toBe(1);
  });
});

describe("R3 W838-F4 · config-saved 重算能力位", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("保存配置把模型换成 text-only → 图片被拦且文案更新（文本文件仍可用）", async () => {
    await bootInputbar();
    await flush(10);
    const btn = doc.getElementById("btnAttach") as ElLike;
    expect(btn.disabled).toBe(false);
    net.config = { ok: true, model: "textonly" };
    net.providers = { ok: true, providers: [{ id: "p", models: [{ id: "textonly", input_modalities: ["text"] }] }] };
    (globalThis as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new Ev("studio:config-saved"));
    await flush(14);
    // W869：「图片入口禁用」的判据由「按钮 disabled」改为「图片进不来 + 原因可见」——
    // 同一个入口现在也收文本文件，而文本与图像能力位无关（见 tests/w869-text-file-attach.test.ts ⑥）。
    expect(btn.title).toContain("不含图像");
    // 图片仍被显式排除：粘贴一张图，待发区必须为空（不静默收下）。
    const paste = new Ev("paste") as { clipboardData?: unknown };
    const png = makeFile("a.png", "image/png");
    paste.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => png }], files: [png] };
    (doc.getElementById("input") as ElLike).dispatchEvent(paste);
    expect(trayItems()).toBe(0);
  });
});

describe("R3 W838-F8 · 同批只拒溢出项", () => {
  beforeEach(() => { doc.body.innerHTML = HTML; vi.resetModules(); installGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it("已有 5 张时 16 张收 15 拒 1；空区 21 张收 20 拒 1", async () => {
    await bootInputbar();
    await flush(10);
    const att = await importAtt();
    const files = (n: number, tag: string): unknown[] =>
      Array.from({ length: n }, (_, i) => makeFile(tag + i + ".png", "image/png"));
    expect(att.addFiles(files(5, "a"))).toBe(0);
    expect(att.addFiles(files(16, "b"))).toBe(1);
    expect(att.pendingCount()).toBe(20);
    att.clearPending();
    expect(att.addFiles(files(21, "c"))).toBe(1);
    expect(att.pendingCount()).toBe(20);
  });
});

