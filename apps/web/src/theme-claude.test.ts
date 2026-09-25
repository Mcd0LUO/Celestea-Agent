// @vitest-environment jsdom
// ============================================================================
// W1535 — Claude Code 风格色卡：对比度与「两套都在」的结构不变量。
//
// 为什么需要它：色卡是**纯 token**，没有行为逻辑，静态门禁（tsc/lint）证明不了
// 「正文在背景上真的读得清」。WCAG 对比度是可机械计算的量，把它钉成测试，
// 以后有人顺手调一个灰度就会立刻红 —— 而不是等用户抱怨「字看不清」。
//
// 四条不变量：
//   ① [data-theme="claude"] 必须存在，且覆盖**每一个** mono 会漏出的硬编码 token
//      （--c-grant-danger / --c-grant-idle 在 mono 块里是硬编码、dark 也没覆盖，
//        不显式覆盖就会漏出灰阶值 —— 这正是最容易被漏掉的一类）。
//   ② 浅色块与深色块都必须定义**完整一套** --hl-*（漏一个 ⇒ 那个 token 沿用浅色值，
//      落在深底上不可读；与 W1526 深色覆盖浅色的同一条理由）。
//   ③ 对比度：正文 / 次要 / 三级文字与代码高亮全部 >= 4.5:1（WCAG AA 正文档）。
//      取值从 CSS 里**解析**出来算，不是把期望值抄一遍 —— 抄一遍就变成自证。
//   ④ 官方品牌色确实落位，且「官方橙不能直接当正文」这一事实被钉住
//      （#d97757 白底仅 3.12:1，所以正文橙必须加深 —— 见报告实测）。
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "apps/web/src/styles/theme-claude.css"), "utf8");

/** 去掉注释，避免注释里的示例值被当成声明。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取某个选择器块（大括号配对）的正文。 */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error("selector not found: " + selector);
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error("unbalanced braces for " + selector);
}

/** 解析一个块里的 --x: value; 声明。 */
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}

const CLEAN = stripComments(CSS);
/** 深色块在 @media (prefers-color-scheme: dark) 里 —— 先切出媒体块再取内层选择器。 */
const mediaStart = CLEAN.indexOf("@media (prefers-color-scheme: dark)");
const lightPart = mediaStart >= 0 ? CLEAN.slice(0, mediaStart) : CLEAN;
const darkPart = mediaStart >= 0 ? CLEAN.slice(mediaStart) : "";

const LIGHT = vars(block(lightPart, '[data-theme="claude"]'));
const DARK = mediaStart >= 0 ? vars(block(darkPart, '[data-theme="claude"]')) : {};

/* ---------------- WCAG 2.1 相对亮度 / 对比度 ---------------- */
function rgb(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error("not a 6-digit hex: " + c);
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(c: string): number {
  const [r, g, b] = rgb(c);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** HSL 色相角（度）。用于验证「加深」确实保持色相，而不是换成另一个颜色。 */
function hue(c: string): number {
  const [r, g, b] = rgb(c).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** token -> 最终 hex：跟随 var() 别名链（--c-text-1 -> --label-primary -> --s-gray-900）。 */
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error("var() chain too deep at " + name);
  const raw = table[name];
  if (raw === undefined) throw new Error("token not defined: " + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  if (!m) return raw.trim();
  return resolve(table, m[1] as string, depth + 1);
}

/**
 * 合并 token 表：mono 的 :root 兜底 -> claude 覆盖。
 * 为什么必须带兜底：--c-text-1 等在 claude 块里**没有**直接定义（它走 alias），
 * 只解析 claude 块会报 "token not defined"。
 */
const TOKENS_CSS = stripComments(readFileSync(join(process.cwd(), "apps/web/src/styles/tokens.css"), "utf8"));
const BASE = vars(block(TOKENS_CSS, ":root,"));
function table(overrides: Record<string, string>): Record<string, string> {
  return { ...BASE, ...overrides };
}
const T_LIGHT = table(LIGHT);
const T_DARK = table(DARK);

const HL_KEYS = ["--hl-comment", "--hl-keyword", "--hl-string", "--hl-number", "--hl-title", "--hl-attr", "--hl-builtin", "--hl-literal", "--hl-meta", "--hl-type"];

describe("W1535 ① claude 主题块结构", () => {
  it("浅色块存在且非空", () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(30);
  });

  it("深色块存在（两套都做，深色走 prefers-color-scheme）", () => {
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    expect(Object.keys(DARK).length).toBeGreaterThan(30);
  });

  it("mono 里硬编码、alias 不重指的 token 必须显式覆盖（防漏出灰阶）", () => {
    const hardcoded = ["--c-grant-danger", "--c-grant-idle", "--c-ok-dim", "--c-err-dim", "--c-warn-dim", "--c-live-dim", "--c-grant-soft", "--c-sweep"];
    for (const k of hardcoded) {
      expect(LIGHT[k], "浅色漏覆盖 " + k).toBeDefined();
      expect(DARK[k], "深色漏覆盖 " + k).toBeDefined();
    }
  });

  it("深色覆盖每一个浅色 key（漏一个 => 该 token 在深底上沿用浅色值）", () => {
    expect(Object.keys(LIGHT).filter((k) => !(k in DARK))).toEqual([]);
  });

  it("浅色与深色必须真的不同（深色不是把浅色抄了一遍）", () => {
    // --interactive-accent-ring 是**故意**浅深同值的：focus 指示色属于品牌标识，
    // 深浅两套用同一个橙可保证「焦点在哪」在两种模式下观感一致（且两底上都 >=3:1）。
    const intentional = ["--interactive-accent-ring"];
    const same = Object.keys(LIGHT).filter(
      (k) => LIGHT[k] === DARK[k] && !/^--shadow/.test(k) && !intentional.includes(k),
    );
    expect(same).toEqual([]);
  });
});

describe("W1535 ② 代码高亮两套完整", () => {
  it("浅色定义完整一套 --hl-*", () => {
    expect(HL_KEYS.filter((k) => !(k in LIGHT))).toEqual([]);
  });
  it("深色定义完整一套 --hl-*", () => {
    expect(HL_KEYS.filter((k) => !(k in DARK))).toEqual([]);
  });
  it("每个 --hl-* 浅深不同", () => {
    expect(HL_KEYS.filter((k) => LIGHT[k] === DARK[k])).toEqual([]);
  });
  it("高亮色有区分度（不得全部同色）", () => {
    for (const [name, t] of [["light", LIGHT], ["dark", DARK]] as const) {
      expect(new Set(HL_KEYS.map((k) => t[k])).size, name).toBeGreaterThanOrEqual(6);
    }
  });
});

/** 对比度用例表：[说明, 前景 token, 背景 token, 最低比值]。 */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ["正文 / 页面底", "--label-primary", "--bg-base", 4.5],
  ["正文 / 卡片", "--label-primary", "--bg-layer-1", 4.5],
  ["正文 / 次级面", "--label-primary", "--bg-layer-3", 4.5],
  ["次要文字 / 页面底", "--label-secondary", "--bg-base", 4.5],
  ["次要文字 / 卡片", "--label-secondary", "--bg-layer-1", 4.5],
  ["次要文字 / 次级面", "--label-secondary", "--bg-layer-3", 4.5],
  ["三级文字 / 页面底", "--label-tertiary", "--bg-base", 4.5],
  ["三级文字 / 卡片", "--label-tertiary", "--bg-layer-1", 4.5],
  ["三级文字 / 次级面", "--label-tertiary", "--bg-layer-3", 4.5],
  ["三级文字 / 代码底", "--label-tertiary", "--bg-code", 4.5],
  ["强调色作文字 / 页面底", "--interactive-accent", "--bg-base", 4.5],
  ["强调色作文字 / 卡片", "--interactive-accent", "--bg-layer-1", 4.5],
  ["按钮字 / 强调底", "--interactive-accent-fg", "--interactive-accent", 4.5],
  ["状态 ok / 页面底", "--state-ok", "--bg-base", 4.5],
  ["状态 warn / 页面底", "--state-warn", "--bg-base", 4.5],
  ["状态 err / 页面底", "--state-err", "--bg-base", 4.5],
  ["状态 live / 页面底", "--state-live", "--bg-base", 4.5],
  ["状态 grant / 页面底", "--state-grant", "--bg-base", 4.5],
  ["代码 comment / 代码底", "--hl-comment", "--bg-code", 4.5],
  ["代码 keyword / 代码底", "--hl-keyword", "--bg-code", 4.5],
  ["代码 string / 代码底", "--hl-string", "--bg-code", 4.5],
  ["代码 number / 代码底", "--hl-number", "--bg-code", 4.5],
  ["代码 title / 代码底", "--hl-title", "--bg-code", 4.5],
  ["代码 attr / 代码底", "--hl-attr", "--bg-code", 4.5],
  ["代码 builtin / 代码底", "--hl-builtin", "--bg-code", 4.5],
  ["代码 meta / 代码底", "--hl-meta", "--bg-code", 4.5],
  ["代码 type / 代码底", "--hl-type", "--bg-code", 4.5],
];

describe("W1535 ③ WCAG AA 对比度（全部 >= 4.5:1）", () => {
  for (const [label, fg, bg, min] of CASES) {
    it("浅色 · " + label, () => {
      const r = contrast(resolve(T_LIGHT, fg), resolve(T_LIGHT, bg));
      expect(r, label + " = " + r.toFixed(2) + ":1").toBeGreaterThanOrEqual(min);
    });
    it("深色 · " + label, () => {
      const r = contrast(resolve(T_DARK, fg), resolve(T_DARK, bg));
      expect(r, label + " = " + r.toFixed(2) + ":1").toBeGreaterThanOrEqual(min);
    });
  }

  /**
   * 边框棘轮：**不得劣于 mono 现状**。
   * 为什么不用一个拍脑袋的绝对阈值（初版写的 1.2）：本仓 mono 的浅色发丝边框
   * 实测就只有 1.17:1 —— 定 1.2 会把既有主题也判红，而定 1.1 又什么都拦不住。
   * 「新主题不得比现状更差」才是真正要守的不变量，且它是可机械比较的。
   * 这条用例在初版确实抓到过：claude dark 边框只有 1.30/1.80，弱于 mono 的 1.49/2.69。
   */
  it("边框对比度不得劣于 mono 现状（棘轮）", () => {
    // mono 的**浅色**表 = 静态调色板 + :root,[data-theme=mono] 的 alias。
    const MONO = { ...vars(block(TOKENS_CSS, ":root {")), ...BASE };
    // mono 的**深色**表 = 浅色表 + [data-theme=dark] 覆盖。
    // 少了这一层，深色用例会拿 claude-dark 去比 mono-**浅色**（1.17），
    // 于是 1.30 的劣化边框也能"通过" —— 变异 4 正是这样漏网的。
    const MONO_DARK = { ...MONO, ...vars(block(TOKENS_CSS, '[data-theme="dark"]')) };
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
      ["light", "--border-l1", "--bg-base"],
      ["light", "--border-l3", "--bg-base"],
      ["dark", "--border-l1", "--bg-base"],
      ["dark", "--border-l3", "--bg-base"],
    ];
    for (const [mode, border, bg] of pairs) {
      const mono = mode === "light" ? MONO : MONO_DARK;
      const claude = mode === "light" ? T_LIGHT : T_DARK;
      const monoR = contrast(resolve(mono, border), resolve(mono, bg));
      const claudeR = contrast(resolve(claude, border), resolve(claude, bg));
      expect(claudeR, mode + " " + border + "：claude " + claudeR.toFixed(3) + " vs mono " + monoR.toFixed(3)).toBeGreaterThanOrEqual(monoR);
    }
  });

  it("focus 环（非文本）在两个底色上都 >= 3:1", () => {
    for (const [name, t] of [["light", T_LIGHT], ["dark", T_DARK]] as const) {
      const r = contrast(resolve(t, "--interactive-accent-ring"), resolve(t, "--bg-base"));
      expect(r, name + " focus 环 = " + r.toFixed(2) + ":1").toBeGreaterThanOrEqual(3);
    }
  });

  it("对比度算法自检：黑白 = 21:1，同色 = 1:1", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#123456", "#123456")).toBeCloseTo(1, 10);
  });
});

describe("W1535 ④ 取色来源可追溯（官方品牌色落位）", () => {
  it("官方 Light #faf9f5 是页面底", () => {
    expect(LIGHT["--s-gray-25"]).toBe("#faf9f5");
  });
  it("官方 Dark #141413 是主文字", () => {
    expect(LIGHT["--s-gray-900"]).toBe("#141413");
  });
  /**
   * 官方橙 #d97757 在米白底上**两个门槛都差一口气**：
   *   正文 4.5:1 —— 实测 3.12；非文本 3:1 —— 实测 2.96。
   * 所以它不是「只降级当装饰」，而是正文与装饰位**都**必须加深一档。
   * 这条用例把「官方值本身不达标」钉住，防止以后有人凭印象把 #d97757 放回去。
   */
  it("官方 Orange #d97757 在米白底上正文与非文本门槛都不达标（故两处都加深）", () => {
    expect(contrast("#d97757", "#faf9f5")).toBeLessThan(4.5);
    expect(contrast("#d97757", "#faf9f5")).toBeLessThan(3.0);
  });

  it("加深后的橙与原官方橙同色相（不是换了个颜色）", () => {
    const official = hue("#d97757");
    for (const [name, v] of [["正文橙 --interactive-accent", LIGHT["--interactive-accent"]], ["focus 环 --interactive-accent-ring", LIGHT["--interactive-accent-ring"]]] as const) {
      expect(Math.abs(hue(v as string) - official), name + " 色相偏移").toBeLessThan(6);
    }
  });

  it("加深后的橙达标：正文 >=4.5、focus 环 >=3", () => {
    expect(contrast(LIGHT["--interactive-accent"] as string, "#faf9f5")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LIGHT["--interactive-accent-ring"] as string, "#faf9f5")).toBeGreaterThanOrEqual(3);
  });
  it("官方 Light Gray #e8e6dc 是浅色边框", () => {
    expect(LIGHT["--s-gray-100"]).toBe("#e8e6dc");
  });
});
