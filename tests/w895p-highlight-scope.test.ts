/**
 * W895-P — 渲染内容的样式必须挂在**共享 class** `.rendered` 上，不能只写 `.content`。
 *
 * 这里踩过两次同一类 bug（用户报「文件管理器打开文件没有高亮」）：
 *   · hljs 的 token 颜色只写 `.content` ⇒ 预览面板里 span 建出来但没颜色；
 *   · `.code-wrap` / `.code-copy` / `.code-badge` / `.cl` 只写 `.content` ⇒
 *     预览里复制按钮 absolute 定位到错误的祖先（飘在右边缘）、徽标无样式。
 *
 * 修法是共享 class：聊天正文与预览面板都带 `.rendered`，规则只写一次。
 * 本门禁机械地守住它 ——
 *   ① 代码/高亮/表格类规则**不得**再出现 `.content ` 作用域（必须 `.rendered `）；
 *   ② 两个渲染面在源码里确实都带上了 `rendered` class。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB, ROOT } from "./lib/w795-dom.js";

function css(): string {
  return readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** 渲染内容类的前缀：凡这些规则都必须用 `.rendered`。 */
const RENDER_PREFIXES = [".hljs-", ".code-wrap", ".code-copy", ".code-badge", ".code-fold", ".cl", ".csv-", "table.csv-table"];

/** 取出所有 `选择器 {` 的左侧（跳过注释块里的说明文字）。 */
function selectors(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  const re = /([^{}\n][^{}]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) out.push((m[1] ?? "").trim());
  return out;
}

describe("W895-P 渲染面样式门禁", () => {
  it("代码/高亮/表格类规则一律用 .rendered，不得只写 .content", () => {
    const sels = selectors(css());
    expect(sels.length, "必须真的扫到选择器（防正则失效空跑）").toBeGreaterThan(50);
    const bad: string[] = [];
    for (const sel of sels) {
      if (!RENDER_PREFIXES.some((p) => sel.includes(p))) continue;
      if (/\.content /.test(sel)) bad.push(sel.slice(0, 90));
    }
    expect(bad).toEqual([]);
  });

  it("两个渲染面都带 rendered class（否则共享规则对它们不生效）", () => {
    expect(read("apps/web/src/ui/messages/assistant.ts")).toContain("content rendered");
    expect(read("apps/web/src/ui/messages/user.ts")).toContain("content rendered");
    expect(read("apps/web/src/ui/preview/panel.ts")).toContain("preview-body rendered");
  });

  it("反向对照：门禁真的会红（构造一条 .content 作用域的高亮规则）", () => {
    const fake = ".content .hljs-keyword { color: red; }\n.rendered .hljs-string { color: blue; }";
    const sels = selectors(fake);
    const bad = sels.filter((s) => RENDER_PREFIXES.some((p) => s.includes(p)) && /\.content /.test(s));
    expect(bad).toEqual([".content .hljs-keyword"]);
  });
});
