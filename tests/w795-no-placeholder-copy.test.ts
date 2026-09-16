/**
 * W795 ① 全站去占位文案：源码 / index.html / 构建产物里都不许再出现
 * 「加载中 / 正在加载 / 切换中 / 提交中 / 正在提交 / 正在读取 …」这类进度占位文案。
 *
 * 口径：裁决是「能立即推出终态的交互一律先画终态，请求后台跑、失败回滚并说明原因」，
 * 占位文案一旦回流就说明这条口径被推翻 —— 所以它由测试 + `tools/check-ui-copy.mjs`
 * （已加同一批规则，扫的是**字面量**，注释不受影响）双重看守。
 *
 * 真实运行的服务上的行为验证（同一帧即见终态）见 tests/w795-optimistic-*.test.ts
 * 与报告里的 headless Blink 实测。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, WEB } from "./lib/w795-dom.js";

/** 被禁的占位文案（W795 逐站点清除清单；参数化写法用其中一段即可命中）。 */
const BANNED = [
  "加载中",
  "加载清单中",
  "正在加载",
  "切换中",
  "提交中",
  "正在提交",
  "正在读取",
  "正在应用",
  "正在授予",
  "正在撤销",
];

/** 去掉注释：注释里描述历史行为（如「不再显示加载清单中…」）不算文案。 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function hitsIn(files: string[], strip: boolean): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const text = strip ? stripComments(readFileSync(f, "utf8")) : readFileSync(f, "utf8");
    for (const bad of BANNED) if (text.includes(bad)) hits.push(f.replace(ROOT + "/", "") + "  ← " + bad);
  }
  return hits;
}

describe("W795 ① 占位文案已从源码与产物里消失", () => {
  it("apps/web/src/**/*.ts 与 index.html、app.js：去掉注释后不含任何占位文案", () => {
    const files = walk(join(WEB, "src"))
      .filter((f) => f.endsWith(".ts"))
      .concat([join(WEB, "index.html"), join(WEB, "app.js")]);
    expect(hitsIn(files, true)).toEqual([]);
  });

  it("面板首屏改由「有快照就画终态 / 无快照先隐藏」承担，index.html 里六个容器首屏为空", () => {
    const src = readFileSync(join(WEB, "src", "ui", "grants", "panel", "body.ts"), "utf8");
    expect(src).not.toContain("sl-popup-loading");
    expect(src).toContain("classList.add('hidden')");
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    for (const id of [
      "sessionTree",
      "settingsConfig",
      "settingsTools",
      "settingsArchive",
      "settingsProviders",
      "settingsPrompts",
    ]) {
      expect(html, id + " 容器必须仍在（只是首屏无内容）").toContain('id="' + id + '"></div>');
    }
    expect(html).not.toContain("加载中");
  });

  it("构建产物（dist，且比源码新 = 确实是当前源码构建出来的）：也不含占位文案", (ctx) => {
    const distHtml = join(WEB, "dist", "index.html");
    if (!existsSync(distHtml)) {
      // W839 (R3 B9 / W818-P2-4): an absent build artifact is a VISIBLE skip,
      // not a silent return that vitest counted as passed.
      ctx.skip("dist 未构建：源码断言已覆盖；pnpm --dir apps/web build 后本断言自动生效");
    }
    const newest = Math.max(
      ...walk(join(WEB, "src"))
        .concat([join(WEB, "index.html"), join(WEB, "app.js")])
        .map((f) => statSync(f).mtimeMs),
    );
    // 陈旧产物不代表当前源码（可能是上一轮构建）：改为显式 skip 并计入 skip 数
    if (statSync(distHtml).mtimeMs < newest) {
      ctx.skip("dist 比源码旧（陈旧产物）：构建后本断言自动生效");
    }
    const files = walk(join(WEB, "dist")).filter((f) => f.endsWith(".html") || f.endsWith(".js"));
    expect(hitsIn(files, false)).toEqual([]); // 产物已剥注释，直接扫全文
  });
});
