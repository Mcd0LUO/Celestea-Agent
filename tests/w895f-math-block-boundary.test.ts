// @vitest-environment jsdom
/**
 * W895-F — 块级 `$$...$$` 的两个边界（讲语法时的字面例子曾经把整段正文吞掉）。
 *
 * 症状（用户截图）：一条讲「怎么用数学」的消息里，代码 span 中的字面 `$$...$$` 被当作
 * **块公式起点**，惰性正则一路找到后面真正的 `$$` 才收尾 —— 中间所有内容（含标题与
 * 行内公式）被塞进一个 math-block，于是行内 `$E=mc^2$` 变成字面文本、版面糊成一团。
 *
 * 修法：块级正则不再允许内容里出现未转义的 `$`，因此不会跨过后续的 `$`/`$$` 去配对。
 * 多行公式仍然工作（`[^$]` 允许换行）。
 */
import { describe, expect, it } from "vitest";
import { at } from "./lib/w795-dom.js";

let mdMod: { renderMarkdown: (s: string) => string } | null = null;
async function renderMarkdown(s: string): Promise<string> {
  if (mdMod === null) {
    mdMod = (await import(/* @vite-ignore */ at("utils/markdown.ts"))) as { renderMarkdown: (s: string) => string };
  }
  return mdMod.renderMarkdown(s);
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

describe("W895-F 块级数学的边界", () => {
  it("代码 span 里的字面 $$...$$ 不再吞掉后面的正文", async () => {
    const src = "语法是行内 `$...$`、块级 `$$...$$`。\n\n**标题**\n\n$$\nx = 1\n$$";
    const html = await renderMarkdown(src);
    expect(count(html, /class="math-block"/g)).toBe(1);
    // 标题必须仍被解析为强调，而不是被吞进 math-block。
    expect(html).toContain("<strong>标题</strong>");
    const block = /<div class="math-block">([\s\S]*?)<\/div>/.exec(html);
    expect(block?.[1] ?? "").not.toContain("标题");
    expect((block?.[1] ?? "").trim()).toBe("x = 1");
  });

  it("多行块公式仍然工作（换行不算越界）", async () => {
    const html = await renderMarkdown("$$\na = 1 \\\\ b = 2\n$$");
    expect(count(html, /class="math-block"/g)).toBe(1);
    expect(html).toContain("a = 1");
  });

  it("未闭合的 $$ 不得吞掉后续内容（内容里不允许未转义 $ 的用意）", async () => {
    // 这正是旧行为：一个孤立的 `$$` 会一路找到后面的 `$$` 才收尾。
    const html = await renderMarkdown("**前**\n\n$$\n没有收尾\n\n**后**");
    expect(count(html, /class="math-block"/g)).toBe(0);
    expect(html).toContain("<strong>后</strong>");
  });
  it("行内公式在有字面 $$ 的段落里仍然渲染", async () => {
    const src = "语法 `$$...$$` 之后 $E = mc^2$ 结束。";
    const html = await renderMarkdown(src);
    expect(count(html, /class="math-block"/g)).toBe(0);
    expect(count(html, /class="math-inline"/g)).toBe(1);
  });
});
