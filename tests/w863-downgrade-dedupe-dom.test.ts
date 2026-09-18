// @vitest-environment jsdom
/**
 * W863 · 前端兜底 —— 同一会话容器里**至多一条**降级提示块。
 *
 * 现象：用户在 Studio 里看到「很多叠加的可滑动的块」，全是同一条
 * 「模型 … 拒绝了图像输入（上游 400）…」。
 * 根因：后端一个多步回合每一步都重发历史图片 → 每步一条降级 status 帧
 * （apps/studio/src/runtime/real-runtime-adapter.ts:235）；前端
 * apps/web/src/ui/downgrade.ts:12 每收到一帧就 renderInfoBlock **追加一个新块**
 * （apps/web/src/ui/messages/info.ts:14）。
 *
 * 本文件用 jsdom 加载**真实模块**（pathToFileURL 动态 import，不复刻逻辑）：
 * 同一 ctx 连发 5 帧同签名 → 恰好 1 个 .msg.info、文案=最新、flash 1 次；
 * 换 model / 换 cause → 仍是 1 个块但文案更新并再 flash；两个会话各 1 个互不影响；
 * 历史恢复（replaceChildren）清掉块后，live 帧只补 **1** 个块、不再叠加。
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
  hidden: boolean;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  appendChild(n: ElLike): ElLike;
  replaceChildren(...n: ElLike[]): void;
  remove(): void;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  contains(n: unknown): boolean;
}
interface DocLike {
  body: ElLike & { innerHTML: string };
  getElementById(id: string): ElLike | null;
  querySelector(sel: string): ElLike | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
}
interface PaneLike {
  id: string;
  el: ElLike;
}

const doc = (globalThis as unknown as { document: DocLike }).document;
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
const at = (rel: string): string => pathToFileURL(join(WEB, "src", rel)).href;

/** 与 index.html 同构的最小骨架（statusbar 的 need() 在模块加载期就要这些 id）。 */
const HTML =
  '<div id="app"><div id="layout"><main id="main"><div id="messages" tabindex="-1"></div>' +
  '<div id="statusline" class="statusline"><div class="sl-row sl-row-main">' +
  '<span class="sl-ctx" id="slCtx">—/—</span><button class="sl-model" id="slModel">—</button>' +
  '<button class="sl-effort" id="slEffort">—</button><span class="sl-spacer"></span>' +
  '<button id="slStop" class="sl-stop hidden"></button><span class="sl-hint" id="slHint"></span></div>' +
  '<div class="sl-row sl-row-sub"><span class="sl-tps" id="slTps">—</span>' +
  '<span class="sl-cache" id="slCache">—</span><span class="sl-steps" id="slSteps">—</span></div></div>' +
  '<footer id="statusbar"><span class="dot" id="statusDot"></span><span id="statusText"></span>' +
  '<span id="statusTurn"></span><span id="statusStep"></span><span id="statusTime"></span></footer>' +
  '<textarea id="input" rows="2"></textarea></main></div></div>';

/** flash 计数：flashStatus 每次都排一个 6000ms 的定时器（唯一 6000ms 调用点）。 */
let flashCalls: unknown[][] = [];
const flashCount = (): number => flashCalls.filter((c) => c[1] === 6000).length;

/** 服务端定稿的降级帧形状（apps/studio/src/runtime/image-downgrade.ts copyOf）。 */
function frame(model: string, message: string, cause?: string): Record<string, unknown> {
  return {
    phase: "error",
    reason: "IMAGE_UNSUPPORTED",
    model,
    message,
    hint: '下一步：切换到支持图像输入的模型，或确认该模型 input_modalities 含 "image"。',
    ...(cause === undefined ? {} : { cause }),
  };
}
const rejected = (model: string): Record<string, unknown> =>
  frame(model, '模型 "' + model + '" 拒绝了图像输入（上游 400），本轮已自动降级为「仅文本 + 图片占位」继续，图片内容未送达模型。', "upstream_rejected");
const timedOut = (model: string): Record<string, unknown> =>
  frame(model, '模型 "' + model + '" 未在超时时间内响应图像输入，本轮已自动降级为「仅文本 + 图片占位」并重试。', "timeout");

const infoCount = (pane: PaneLike): number => Array.from(pane.el.querySelectorAll(".msg.info")).length;
const downgradeCount = (pane: PaneLike): number =>
  Array.from(pane.el.querySelectorAll(".msg.info.downgrade")).length;
const blockText = (pane: PaneLike): string =>
  pane.el.querySelector(".msg.info.downgrade .info-content")?.textContent ?? pane.el.querySelector(".msg.info .info-content")?.textContent ?? "";

type DowngradeMod = { renderImageDowngrade(ctx: unknown, p: Record<string, unknown>): void };
type ViewMod = {
  initViewCtx(): PaneLike;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): PaneLike;
};
type AttMod = { downgradeNotice(p: Record<string, unknown>): string };
type RestoreMod = { restoreSessionHistory(ctx: unknown): Promise<void> };

async function boot(): Promise<{ view: ViewMod; dg: DowngradeMod; att: AttMod; restore: RestoreMod; a: PaneLike; b: PaneLike }> {
  const view = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as ViewMod;
  view.initViewCtx();
  const a = view.activatePane("ws/a", "session", "甲会话");
  const b = view.ensurePane("ws/b", "session", "乙会话");
  const dg = (await import(/* @vite-ignore */ at("ui/downgrade.ts"))) as DowngradeMod;
  const att = (await import(/* @vite-ignore */ at("ui/attachments.ts"))) as AttMod;
  const restore = (await import(/* @vite-ignore */ at("ui/restore.ts"))) as RestoreMod;
  return { view, dg, att, restore, a, b };
}

beforeEach(() => {
  doc.body.innerHTML = HTML;
  vi.resetModules();
  flashCalls = (vi.spyOn(globalThis as unknown as { setTimeout: (f: () => void, ms?: number) => unknown }, "setTimeout") as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true, messages: [] }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  doc.body.replaceChildren();
});

describe("W863 B: 同一会话至多一条降级提示块", () => {
  it("同签名 5 帧 → 1 个块 + 最新文案 + flash 一次；换 model/cause → 仍 1 块但更新文案并再 flash", async () => {
    const { dg, att, a } = await boot();
    for (let i = 0; i < 5; i++) dg.renderImageDowngrade(a, rejected("deepseek-v4-flash-0731"));

    expect(infoCount(a)).toBe(1);
    expect(downgradeCount(a)).toBe(1);
    expect(blockText(a)).toBe(att.downgradeNotice(rejected("deepseek-v4-flash-0731")));
    expect(flashCount()).toBe(1);

    // 换 model：新签名 → 仍是同一个块，就地更新文案，并且再 flash 一次。
    dg.renderImageDowngrade(a, rejected("glm-5.3-flash"));
    dg.renderImageDowngrade(a, rejected("glm-5.3-flash"));
    expect(infoCount(a)).toBe(1);
    expect(blockText(a)).toContain("glm-5.3-flash");
    expect(flashCount()).toBe(2);

    // 换 cause（同 model）：也是新签名。
    dg.renderImageDowngrade(a, timedOut("glm-5.3-flash"));
    expect(infoCount(a)).toBe(1);
    expect(blockText(a)).toContain("超时");
    expect(flashCount()).toBe(3);

    // 重复帧只改文案，绝不重复 flash。
    dg.renderImageDowngrade(a, timedOut("glm-5.3-flash"));
    expect(infoCount(a)).toBe(1);
    expect(flashCount()).toBe(3);
  });

  it("两个会话各 1 个块，互不影响；非活跃容器的帧不 flash", async () => {
    const { dg, view, a, b } = await boot();
    dg.renderImageDowngrade(a, rejected("m1"));
    dg.renderImageDowngrade(b, rejected("m1")); // b 不是活跃容器
    dg.renderImageDowngrade(b, rejected("m1"));

    expect(infoCount(a)).toBe(1);
    expect(infoCount(b)).toBe(1);
    expect(flashCount()).toBe(1); // 只有 a（活跃）那次
    expect(blockText(b)).toContain("m1");

    view.activatePane("ws/b");
    dg.renderImageDowngrade(b, rejected("m2")); // 切到 b 后签名变化 → flash
    expect(infoCount(b)).toBe(1);
    expect(infoCount(a)).toBe(1);
    expect(blockText(b)).toContain("m2");
    expect(flashCount()).toBe(2);
  });

  it("历史恢复（replaceChildren）清掉块后，后续帧只补 1 个块、不叠加", async () => {
    const { dg, restore, a } = await boot();
    dg.renderImageDowngrade(a, rejected("m1"));
    expect(infoCount(a)).toBe(1);

    await restore.restoreSessionHistory(a); // 真实历史恢复：先 replaceChildren 再渲染历史
    expect(infoCount(a)).toBe(0); // 恢复出来的历史里没有降级块（它从不写进会话日志）

    dg.renderImageDowngrade(a, rejected("m1"));
    dg.renderImageDowngrade(a, rejected("m1"));
    expect(infoCount(a)).toBe(1);
    expect(downgradeCount(a)).toBe(1);
  });
});
