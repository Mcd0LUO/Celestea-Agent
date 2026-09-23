import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB } from "./lib/w795-dom.js";

/**
 * W895-C — 代码高亮配色门禁。
 *
 * 真 bug（用户截图报「没有高亮」）：`--hl-*` 是**灰阶**，且 `--hl-title` 与正文
 * `--c-text-1` **同为 #111** —— 高亮一直在生效，但看不见。而且 `[data-theme="dark"]`
 * 完全没有覆盖 `--hl-*`，深色主题会沿用浅色值（浅底可读的深色 token 落在深底上不可读）。
 *
 * 本门禁机械守住三条：
 *   ① 每个浅色 `--hl-*` 必须在深色主题里有覆盖（否则深色下不可读）；
 *   ② 任何 `--hl-*` 不得等于同主题的正文色 `--c-text-1`（那等于没高亮）；
 *   ③ 同一主题内 token 之间不得全部同色（否则等于没区分）。
 * 真浏览器取色由人工/截图验证（jsdom 不算样式表，测不了计算值）。
 */

function tokensCss(): string {
  return readFileSync(join(WEB, "src", "styles", "tokens.css"), "utf8");
}

/** 取某个选择器块的声明体（够用即可：按 `选择器 {` 到配对的 `}` 切）。 */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector + " {");
  if (i < 0) return "";
  const start = css.indexOf("{", i);
  const end = css.indexOf("\n}", start);
  return css.slice(start + 1, end < 0 ? css.length : end);
}

/** 块内的 --hl-* 变量表。 */
function hlVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--hl-[a-z]+):\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out[m[1] ?? ""] = (m[2] ?? "").trim();
  return out;
}

function textColor(body: string): string {
  const m = /--c-text-1:\s*([^;]+);/.exec(body);
  return m === null ? "" : (m[1] ?? "").trim();
}

describe("W895-C 代码高亮配色门禁", () => {
  const css = tokensCss();
  // 浅色块写作 `:root,\n[data-theme="mono"] {` —— 用 mono 选择器切，`:root, {` 不存在。
  const light = hlVars(block(css, '[data-theme="mono"]'));
  const dark = hlVars(block(css, '[data-theme="dark"]'));

  it("浅色主题确实定义了 --hl-*（防解析失效空跑）", () => {
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(8);
  });

  it("深色主题必须覆盖**每一个** --hl-*（否则深色下不可读）", () => {
    const missing = Object.keys(light).filter((k) => !(k in dark));
    expect(missing).toEqual([]);
  });

  it("任何 --hl-* 不得等于同主题正文色（那等于没高亮）", () => {
    const lightText = textColor(block(css, '[data-theme="mono"]'));
    expect(lightText, "必须读到正文色").not.toBe("");
    const same = Object.entries(light).filter(([, v]) => v === lightText).map(([k]) => k);
    expect(same, "这些 token 与正文同色 ⇒ 视觉上不存在").toEqual([]);
  });

  it("同一主题内 token 必须真的有区分度（不得全部同色）", () => {
    for (const [name, vars] of [["light", light], ["dark", dark]] as const) {
      const uniq = new Set(Object.values(vars));
      expect(uniq.size, name + " 主题 token 色种类").toBeGreaterThanOrEqual(5);
    }
  });
});
