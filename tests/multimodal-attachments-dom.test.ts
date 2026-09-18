// @vitest-environment jsdom
/**
 * W805 · 多模态附件 P0 前端半边 —— jsdom 真实模块用例。
 *
 * 本机没有浏览器，故用 jsdom 加载**真实模块**（pathToFileURL 动态 import，不复刻逻辑），
 * 驱动真实 DOM 事件，覆盖：
 *   ① 三入口（粘贴 / 拖拽 / 文件选择）都进同一待发区，且**当帧**渲染（不发任何请求）；
 *   ② 能力位：部署位 + 逐模型显式排除（乐观默认）；
 *   ③ 发送失败的**完整回滚**（气泡移除 / 输入框还原 / 附件回待发区）；
 *   ④ 历史仅有引用时的元数据渲染（P0 无字节回读端点，不造假）；
 *   ⑤ 降级帧判定 + 信息块可见（真实帧形状见 real-backend 用例）。
 *
 * 后端真机端到端（真发图片 / 降级路径 / 日志无 base64）见
 * tests/multimodal-attachments-real-backend.test.ts —— 本文件不拿桩数据冒充验收。
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
  '<div id="sideFoot">—</div>' +
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

function paste(target: ElLike, files: unknown[]): void {
  const e = new Ev("paste") as { clipboardData?: unknown };
  e.clipboardData = {
    items: files.map((f) => ({ kind: "file", type: (f as { type: string }).type, getAsFile: () => f })),
    files,
  };
  target.dispatchEvent(e);
}
function drop(target: ElLike, files: unknown[]): void {
  const e = new Ev("drop", { bubbles: true }) as { dataTransfer?: unknown };
  e.dataTransfer = { types: ["Files"], files };
  target.dispatchEvent(e);
}
function select(files: unknown[]): void {
  const input = doc.getElementById("attachInput") as ElLike;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Ev("change"));
}
const trayItems = (): number => Array.from(doc.querySelectorAll(".attach-tray .attach-item")).length;

/** W805 真实降级帧形状（真机端到端见 real-backend 用例；此处供 DOM 断言复用）。 */
const REAL_DOWNGRADE = {
  phase: "error",
  reason: "IMAGE_UNSUPPORTED",
  model: "deepseek-v4-flash-0731",
  message:
    '模型 "deepseek-v4-flash-0731" 拒绝了图像输入（上游 400），本轮已自动降级为「仅文本 + 图片占位」继续，图片内容未送达模型。',
  hint: '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"。',
};

describe("W805 · 三入口 + 当帧渲染（不发请求）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    installGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it("粘贴 / 拖拽 / 文件选择三条入口都在**同一帧**进待发区，且不触发任何网络请求", async () => {
    await bootInputbar();
    await flush(10); // 让能力位请求先落定，后续「零请求」断言才干净
    const calls: string[] = [];
    const spy = globalThis.fetch as unknown as (u: unknown) => Promise<unknown>;
    vi.stubGlobal("fetch", (u: unknown) => {
      calls.push(String(u));
      return spy(u);
    });
    paste(doc.getElementById("input") as ElLike, [makeFile("paste.png", "image/png")]);
    expect(trayItems()).toBe(1); // 当帧可见：没有任何 await
    drop(doc.getElementById("inputbar") as ElLike, [makeFile("drop.png", "image/png")]);
    expect(trayItems()).toBe(2);
    select([makeFile("pick.png", "image/png")]);
    expect(trayItems()).toBe(3);
    expect(calls).toEqual([]); // 选择阶段零请求（不出现「上传中」占位）
    const imgs = Array.from(doc.querySelectorAll(".attach-tray .attach-thumb"));
    expect(imgs.length).toBe(3); // createObjectURL 可用 → 真缩略图
  });

  it("非图片 / 超大被当场标红并写明原因（不发请求）", async () => {
    await bootInputbar();
    await flush(10); // 能力位落定后再选择（否则入口尚未开放）
    // W869：.txt 已受支持（走「读文本 + 注入消息」），本用例改用**真二进制**内容
    // （含 NUL）伪装成 .txt —— 判定标准是内容能不能按 UTF-8 解出来，不是扩展名。
    select([makeFile("notes.txt", "text/plain", [0x41, 0x00, 0x42, 0x43])]);
    expect(trayItems()).toBe(1);
    await flush(20); // 文本读取是异步的：标红发生在落定之后
    expect(Array.from(doc.querySelectorAll(".attach-tray .attach-item.err")).length).toBe(1);
    expect((doc.querySelector(".attach-tray .attach-sub")?.textContent ?? "")).toContain("UTF-8");
  });
});

describe("W805 · 能力位（部署级 + 逐模型乐观默认）", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    installGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it("显式配成 text-only 的模型禁用入口并给可执行原因；缺省模型乐观放行", async () => {
    net.providers = { ok: true, providers: [{ id: "p", models: [{ id: "textonly", input_modalities: ["text"] }] }] };
    net.config = { ok: true, model: "textonly" };
    const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as {
      loadAttachmentCapabilities(): Promise<void>;
      attachmentsEnabled(): boolean;
      imageEntryDisabledReason(): string;
      modelAllowsImages(m: string): boolean;
    };
    await att.loadAttachmentCapabilities();
    expect(att.attachmentsEnabled()).toBe(true);
    expect(att.modelAllowsImages("textonly")).toBe(false);
    expect(att.modelAllowsImages("glm-5.3-flash")).toBe(true); // 缺省 = 乐观
    expect(att.imageEntryDisabledReason()).toContain("不含图像");
    const { bar } = await bootInputbar();
    bar.refreshAttachmentEntry();
    const btn = doc.getElementById("btnAttach") as ElLike;
    // W869：入口按钮对**文本文件**仍然可用（图像能力位管不到文本），故不再整体禁用；
    // 图像能力位降级为按钮提示，图片本身照旧在入口被拦（下一行断言）。
    expect(btn.disabled).toBe(false);
    expect(btn.title).toContain("不含图像");
    paste(doc.getElementById("input") as ElLike, [makeFile("x.png", "image/png")]);
    expect(trayItems()).toBe(0); // 被显式排除：不静默收下
  });
});

describe("W805 · 发送失败完整回滚 + 历史元数据渲染 + 降级可见", () => {
  beforeEach(() => {
    doc.body.innerHTML = HTML;
    vi.resetModules();
    installGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it("带附件的发送失败：移除乐观气泡、还原输入框、附件回到待发区并说明原因", async () => {
    const { bar } = await bootInputbar();
    const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as {
      addFiles(f: ArrayLike<unknown>): number;
      pendingList(): unknown[];
    };
    att.addFiles([makeFile("shot.png", "image/png")]);
    bar.refreshAttachmentTray();
    net.turnStatus = 500;
    net.turnPayload = { ok: false, error: "boom" };
    const send = (await import(/* @vite-ignore */ at("ui/send.ts"))) as { dispatchSend(t: string, m: string): void };
    (doc.getElementById("input") as ElLike).value = "看图";
    send.dispatchSend("看图", "steer");
    expect(Array.from(doc.querySelectorAll(".msg.user")).length).toBe(1); // 先画终态
    expect(trayItems()).toBe(0);
    await flush(24);
    expect(Array.from(doc.querySelectorAll(".msg.user")).length).toBe(0); // 失败 → 气泡移除
    expect((doc.getElementById("input") as ElLike).value).toBe("看图"); // 文本还原
    expect(att.pendingList().length).toBe(1); // 附件回待发区
    expect(trayItems()).toBe(1);
    expect(Array.from(doc.querySelectorAll(".msg.info")).length).toBeGreaterThan(0);
  });

  it("历史只有引用时渲染元数据（文件名 + 尺寸 + MIME），没有字节就不假装有图", async () => {
    const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as {
      attachmentViewsOf(refs: unknown[]): unknown[];
      renderAttachmentGrid(views: unknown[]): ElLike;
    };
    const ref = { attachment_id: "a".repeat(64), media_type: "image/png", width: 64, height: 48, name: "shot.png" };
    const views = att.attachmentViewsOf([ref]);
    const grid = att.renderAttachmentGrid(views);
    expect(grid.querySelectorAll(".attach-thumb-meta").length).toBe(1); // 无字节 → 元数据占位
    expect(grid.querySelectorAll("img").length).toBe(0);
    expect(grid.querySelector(".attach-name")?.textContent).toBe("shot.png");
    expect(grid.querySelector(".attach-sub")?.textContent).toContain("64×48");
    expect(grid.querySelector(".attach-sub")?.textContent).toContain("image/png");
  });

  it("降级帧判定真实帧为真、普通错误帧为假；信息块含服务端 message + hint", async () => {
    const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as {
      isImageDowngrade(p: Record<string, unknown>): boolean;
      downgradeNotice(p: Record<string, unknown>): string;
    };
    const real = REAL_DOWNGRADE;
    expect(att.isImageDowngrade(real)).toBe(true);
    expect(att.isImageDowngrade({ phase: "error", error: "其它错误" })).toBe(false);
    const text = att.downgradeNotice(real);
    expect(text).toContain("拒绝了图像输入");
    expect(text).toContain("下一步");

    const { view } = await bootInputbar();
    void view;
    const pane = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as {
      activePane(): { el: ElLike } | null;
    };
    const dg = (await import(/* @vite-ignore */ at("ui/downgrade.ts"))) as {
      renderImageDowngrade(ctx: unknown, p: Record<string, unknown>): void;
    };
    dg.renderImageDowngrade(pane.activePane(), real);
    // D1：全局侧栏脚注零污染（旧实现 note(headline) 会写 #sideFoot）
    expect((doc.getElementById("sideFoot") as ElLike).textContent).toBe("—");
    const info = doc.querySelector(".msg.info .info-content");
    expect(info?.textContent ?? "").toContain("拒绝了图像输入");
  });

  it("可切换清单排除本次肇事模型（乐观默认下它本会出现在清单里）", async () => {
    net.providers = {
      ok: true,
      providers: [{ id: "p", models: [{ id: "deepseek-v4-flash-0731" }, { id: "glm-5.3-flash" }] }],
    };
    const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as {
      loadAttachmentCapabilities(): Promise<void>;
      downgradeNotice(p: Record<string, unknown>): string;
    };
    await att.loadAttachmentCapabilities();
    const text = att.downgradeNotice(REAL_DOWNGRADE);
    // 正文按服务端定稿 message 仍含肇事模型名，所以只对「可切换到：」那一行断言。
    const suggest = text.split("\n").find((l) => l.startsWith("可切换到：")) ?? "";
    expect(suggest).not.toBe("");
    expect(suggest).toContain("glm-5.3-flash");
    expect(suggest).not.toContain("deepseek-v4-flash-0731");
    expect(text).toContain("deepseek-v4-flash-0731");
  });
});
