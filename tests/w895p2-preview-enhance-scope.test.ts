// @vitest-environment jsdom
/**
 * W895-P2 — 预览面板必须和聊天正文一样走**完整的**增强链。
 *
 * 真 bug（用户报「文件管理器中打开文件依旧没有代码高亮」的后续发现）：
 * `runEnhancers(content.node)` 把**那个 `<pre>` 自己**当作用域传进去，而
 * `container.querySelectorAll("pre")` **匹配不到容器自身** ⇒ code-copy / code-extras
 * 静默跳过：高亮有（`pre code` 能匹配后代）、但复制按钮/行号/徽标全没有。
 * 修法：作用域传 `.preview-body`（包住目标的容器）。
 *
 * 本用例走**真实**路径：真 openPreview + 真插件装配（initHints），不用手搓 DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, HTML, resetHarness } from "./lib/w795-dom.js";

interface ElLike2 { querySelectorAll(s: string): ArrayLike<unknown>; querySelector(s: string): ElLike2 | null }
const q = (s: string): ElLike2 | null => doc.querySelector(s) as unknown as ElLike2 | null;
const n = (root: ElLike2 | null, s: string): number => (root === null ? -1 : root.querySelectorAll(s).length);

const TS_SRC = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
].join("\n");

beforeEach(() => {
  resetHarness();
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("EventSource", class { addEventListener(): void {} close(): void {} });
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true, disabled: [], questions: [], messages: [] }) }));
});
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

async function openCodePreview(text: string, path: string): Promise<ElLike2 | null> {
  const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as { initViewCtx(): void };
  V.initViewCtx();
  // 真装配客户端插件（code-copy / code-extras 等）—— 漏了这步会让用例假绿。
  const hints = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as { initHints(): void };
  hints.initHints();
  const panel = (await import(/* @vite-ignore */ at("ui/preview/panel.ts"))) as {
    openPreview(r: unknown): void;
  };
  panel.openPreview({
    candidate: { path, kind: "code", source: "label" },
    loadFull: async () => ({ text }),
  });
  await flush(30);
  return q(".preview-body");
}

describe("W895-P2b 增强链顺序与 import 顺序无关", () => {
  it("先 import hint（客户端插件）再 import enhance，内置两遍仍必须排在前面", async () => {
    const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as { initViewCtx(): void };
    V.initViewCtx();
    const hints = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as { initHints(): void };
    hints.initHints();
    const enhance = (await import(/* @vite-ignore */ at("ui/enhance/index.ts"))) as {
      enhancerIds(): string[];
    };
    const ids = enhance.enhancerIds();
    // hljs 必须先于 code-extras：否则 code-extras 切好的行会被 hljs 的
    // innerHTML 整体替换抹掉（行号静默消失）。
    expect(ids[0]).toBe("builtin.hljs");
    expect(ids.indexOf("builtin.hljs")).toBeLessThan(ids.indexOf("display.codeExtras"));
  });
});
describe("W895-P2 预览面板走完整增强链", () => {
  it("代码文件预览：高亮 + 复制按钮 + 行号 + 语言徽标都在", async () => {
    const body = await openCodePreview(TS_SRC, "/tmp/demo.ts");
    expect(body, "预览面板必须出现").not.toBeNull();
    expect(n(body, "pre code .hljs-keyword"), "hljs 高亮").toBeGreaterThan(0);
    expect(n(body, ".code-wrap"), "代码块包裹（code-copy 的容器）").toBeGreaterThan(0);
    expect(n(body, ".code-copy"), "复制按钮").toBeGreaterThan(0);
    expect(n(body, ".cl-nl"), "行号载体").toBeGreaterThan(0);
    expect(n(body, ".code-badge"), "语言徽标").toBeGreaterThan(0);
  });

  it("变异对照：作用域传节点自身时，复制按钮会消失（证明这条断言真的在测那件事）", async () => {
    // 直接复刻 bug 形态：容器就是那个 <pre>。
    const wrap = doc.createElement("div") as unknown as { appendChild(c: unknown): void };
    const pre = doc.createElement("pre") as unknown as ElLike2 & { appendChild(c: unknown): void };
    const code = doc.createElement("code") as unknown as { className: string; textContent: string };
    code.className = "language-typescript";
    code.textContent = "const a = 1;";
    pre.appendChild(code);
    const enhance = (await import(/* @vite-ignore */ at("ui/enhance/index.ts"))) as {
      runEnhancers(c: unknown): void;
    };
    enhance.runEnhancers(pre); // ← bug 形态：作用域 = 目标自身
    expect(n(pre as unknown as ElLike2, ".code-copy"), "自作用域下确实取不到").toBe(0);
    void wrap;
  });
});
