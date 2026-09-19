// @vitest-environment jsdom
/**
 * W888 · 上下文注入的可见块（前端）：非 user 的 origin 渲染成**独立配色 + 左侧色条
 * + 标题 + 可折叠**的 inbox 块，与用户气泡一眼可分。
 *
 * 真实模块（pathToFileURL 动态 import ui/messages/user.ts），真实 DOM。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { at, doc, resetHarness, type ElLike } from "./lib/w795-dom.js";

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
}
interface UserMod {
  renderInboxMessage(ctx: unknown, text: string, opts?: { source?: string; target?: string; kind?: string }): ElLike;
  addUserMessage(ctx: unknown, text: string, opts?: Record<string, unknown>): ElLike;
}

const ctx = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as ViewCtxMod;
const userMod = (await import(/* @vite-ignore */ at("ui/messages/user.ts"))) as UserMod;

resetHarness(); // 装好与 index.html 同构的骨架（含 #messages）
ctx.initViewCtx();
const pane = ctx.ensurePane("ws/s1", "session", "甲会话") as unknown as { id: string; el: ElLike };

afterEach(() => {
  vi.restoreAllMocks();
  pane.el.replaceChildren();
});

describe("W888 · inbox 块渲染", () => {
  it("每个 origin 都渲染成带标题的 inbox 块，且不是 user 气泡", () => {
    for (const kind of ["skill", "memory", "receipt", "steering", "compact"] as const) {
      pane.el.replaceChildren();
      const col = userMod.renderInboxMessage(pane, "BODY-" + kind, { kind });
      expect(col.querySelector(".msg.inbox"), kind).not.toBeNull();
      expect(col.querySelector(".msg.user"), kind).toBeNull();
      const title = col.querySelector(".inbox-fold-title")?.textContent ?? "";
      expect(title.length, kind).toBeGreaterThan(0);
      expect(col.textContent, kind).toContain("BODY-" + kind);
    }
  });

  it("长注入（memory/skill）默认折叠，回执/插话/压缩默认展开", () => {
    const cols: Record<string, ElLike> = {};
    for (const kind of ["memory", "skill", "receipt", "steering", "compact"] as const) {
      pane.el.replaceChildren();
      cols[kind] = userMod.renderInboxMessage(pane, "x", { kind });
    }
    const open = (kind: string): boolean => (cols[kind]?.querySelector(".inbox-fold") as unknown as { open: boolean }).open;
    expect(open("memory")).toBe(false);
    expect(open("skill")).toBe(false);
    expect(open("receipt")).toBe(true);
    expect(open("steering")).toBe(true);
    expect(open("compact")).toBe(true);
  });

  it("记忆块标题写明来源，回执块带 source 标签", () => {
    const mem = userMod.renderInboxMessage(pane, "x", { kind: "memory" });
    expect(mem.textContent).toContain("记忆");
    pane.el.replaceChildren();
    const rec = userMod.renderInboxMessage(pane, "done", { kind: "receipt", source: "W1" });
    // 标题条把「回执」与来源分列（summary 里两个 span），不拼成一个字符串。
    expect(rec.querySelector(".inbox-fold-title")?.textContent).toBe("回执");
    expect(rec.querySelector(".inbox-fold-src")?.textContent).toBe("W1");
  });

  it("inbox 块与用户气泡的 CSS 形态不同（左色条 / 等宽 / summary 头）", () => {
    const inbox = userMod.renderInboxMessage(pane, "x", { kind: "memory" });
    expect(inbox.querySelector(".bubble.inbox-bubble")).not.toBeNull();
    expect(inbox.querySelector(".inbox-fold")).not.toBeNull();
    pane.el.replaceChildren();
    const bubble = userMod.addUserMessage(pane, "hi") as ElLike;
    expect(bubble.querySelector(".msg.user")).not.toBeNull();
    // 用户气泡没有 summary 折叠头（不是 details）。
    expect(bubble.querySelector(".inbox-fold")).toBeNull();
    expect(bubble.querySelector(".inbox-fold-head")).toBeNull();
  });

  it("未知/缺省 kind 走 W515 旧形态（无折叠、回执前缀）", () => {
    const legacy = userMod.renderInboxMessage(pane, "系统提示");
    expect(legacy.querySelector(".inbox-fold")).toBeNull();
    expect(legacy.textContent).toContain("系统");
  });
});

describe("W888 · CSS 机械不变量", () => {
  it("views.css 定义了 origin 左色条与折叠头规则", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { WEB } = await import("./lib/w795-dom.js");
    const css = readFileSync(join(WEB, "src", "styles", "views.css"), "utf8");
    expect(css).toContain(".msg.inbox .inbox-fold-head");
    expect(css).toContain(".msg.inbox.inbox-memory .bubble.inbox-bubble");
    expect(css).toContain("inset 4px 0 0");
    expect(css).toContain("inbox-fold[open]");
  });
});
