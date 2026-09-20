/**
 * W895-P — 代码高亮的**作用域**必须覆盖所有渲染面。
 *
 * 真 bug（用户报「文件管理器中打开文件依旧没有代码高亮」）：hljs 的 token 颜色规则只写了
 * `.content`（聊天正文），而预览面板挂在 `.preview-body` 下。于是预览里 hljs 的 span
 * **建出来了却没有颜色规则命中** —— 加类不等于上色：类由 JS 加，颜色靠 CSS。
 *
 * 这条门禁是机械的：扫 CSS 文本，凡出现 `.hljs-*` 的颜色规则，其选择器必须**同时**覆盖
 * 已知渲染面。新增渲染面时把它加进 SURFACES，门禁会逼你把选择器一起扩 ——
 * 这样「新加一个渲染面但忘了上色」就不可能悄悄溜过。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB } from "./lib/w795-dom.js";

/** 已知的代码渲染面（新增渲染面必须同时加进这里与 CSS）。 */
const SURFACES = [".content", ".preview-body"];

function readCss(): string {
  return readFileSync(join(WEB, "src", "styles", "components.css"), "utf8");
}

/** 取出所有含 .hljs- 的选择器块（`选择器 { ... }` 的左侧）。 */
function hljsSelectors(css: string): string[] {
  const out: string[] = [];
  const re = /([^{}]*\.hljs-[^{}]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push(m[1] ?? "");
  return out;
}

describe("W895-P 高亮作用域门禁", () => {
  it("每个 .hljs-* 颜色规则都覆盖全部渲染面", () => {
    const sels = hljsSelectors(readCss());
    expect(sels.length, "必须真的扫到 hljs 规则（防止正则失效导致空跑）").toBeGreaterThan(5);
    const missing: string[] = [];
    for (const sel of sels) {
      for (const s of SURFACES) {
        if (!sel.includes(s + " ")) missing.push(s + " 未覆盖：" + sel.trim().slice(0, 80));
      }
    }
    expect(missing).toEqual([]);
  });

  it("反向对照：门禁真的会红（构造一条只写 .content 的规则）", () => {
    const fake = ".content .hljs-comment { color: red; }";
    const sels = hljsSelectors(fake);
    expect(sels.length).toBe(1);
    const missing = SURFACES.filter((s) => !sels[0]!.includes(s + " "));
    expect(missing).toEqual([".preview-body"]);
  });
});
