// @vitest-environment jsdom
/**
 * W895-C — 行号。
 *
 * descriptor/i18n 一直声称 code-extras 提供「行号」，但此前**全仓没有实现**（无 counter）。
 * 用户裁决补上。关键不变量：行号必须画在 `::before` 伪元素上，**不得**成为真文本节点 ——
 * 「复制」按钮读的是 `code.textContent`，若行号进了文本，复制出来的代码每行都会多一个数字。
 *
 * 经 w795-dom 夹具访问 DOM：根 tsconfig 没有 DOM lib（见 AGENT.md §7）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { at, doc, WEB, type ElLike } from "./lib/w795-dom.js";

interface EnhancerLike { enhance(c: unknown): void }
interface Mod { codeExtrasEnhancer(): EnhancerLike }

const SRC = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

function makePre(): { wrap: ElLike; code: ElLike } {
  const wrap = doc.createElement("div");
  const pre = doc.createElement("pre");
  const code = doc.createElement("code");
  code.className = "language-typescript";
  code.textContent = SRC;
  pre.appendChild(code);
  wrap.appendChild(pre);
  return { wrap, code };
}

async function enhancer(): Promise<EnhancerLike> {
  const mod = (await import(/* @vite-ignore */ at("ui/enhance/code-extras.ts"))) as Mod;
  return mod.codeExtrasEnhancer();
}

describe("W895-C 代码行号", () => {
  it("切行后 .cl 存在（行号的载体）", async () => {
    const { wrap } = makePre();
    (await enhancer()).enhance(wrap);
    expect(wrap.querySelectorAll(".cl").length).toBe(3);
  });

  it("行号不得进入 textContent（否则复制按钮会把行号一起复制）", async () => {
    const { wrap, code } = makePre();
    (await enhancer()).enhance(wrap);
    expect(code.textContent).toBe(SRC);
    expect(wrap.querySelectorAll(".cl-num, .line-number, [data-line]").length).toBe(0);
  });

  it("CSS 用 counter + ::before 画行号（不是真节点）", () => {
    const css = readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");
    expect(css).toMatch(/\.rendered pre code \{[^}]*counter-reset: cl-line/);
    expect(css).toMatch(/\.rendered pre \.cl::before \{[^}]*counter-increment: cl-line/);
    expect(css).toMatch(/\.rendered pre \.cl::before \{[^}]*content: counter\(cl-line\)/);
  });
});
