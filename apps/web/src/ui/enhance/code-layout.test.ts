// @vitest-environment jsdom
// ============================================================================
// W1526 — 代码块优化：装饰元素不挡文字 + 高亮配色对齐 VSCode。
//
// 用户原话：「代码块优化（避免挡文字，+颜色)」。
//
// 这里守两条**结构性**不变量（jsdom 没有排版，像素几何由真机 CDP 实测，见
// results/W1526-codeblock.md；本文件守的是让那组像素几何必然成立的结构事实）：
//
//   ① 不挡文字：三个装饰（.code-badge / .code-copy / .code-fold）必须是
//      **正常流**里的元素，且住在 pre **外面**的 .code-head 里。
//      为什么这两条一起才够：
//        · 只是「移出 pre」而仍绝对定位 ⇒ 仍然可以压在 pre 上（老 bug 原样）；
//        · 只是「position:static」而放进 pre 里 ⇒ 长行横向滚动时控件被滚走
//          （W895 特意把复制按钮放在 .code-wrap 上就是为了这个，见 code-copy.test.ts）。
//      两条合起来 ⇒ 工具条与 pre 是上下相邻的两个块 ⇒ 几何上不可能相交。
//
//   ② 颜色：--hl-* 在**本波的 seam 文件** codeblock.css 里覆盖，且取值等于
//      highlight.js 官方 VSCode 主题（vs.css = Light+ / vs2015.css = Dark+）
//      对应 class 的颜色。深色必须覆盖**每一个**浅色 key。
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { codeCopyEnhancer } from "./code-copy";
import { codeExtrasEnhancer, CODE_FOLD_LINES } from "./code-extras";
import { CODE_HEAD_CLASS } from "./code-chrome";
import { registerEnhancer, runEnhancers } from "./registry";

// 用 process.cwd()（vitest 的 root = 仓库根）而不是 import.meta.url：jsdom 环境下
// import.meta.url 是 http://localhost/... 而不是 file:，new URL(..., import.meta.url)
// 会被 readFileSync 拒绝（"The URL must be of scheme file"）。
const CSS = readFileSync(join(process.cwd(), "apps", "web", "src", "styles", "codeblock.css"), "utf8");

/** 去注释（注释里也有选择器样例，会把「选择器存在」这类断言带偏）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 取某选择器**最后一条**规则体（后写的才生效）。
 *
 * 必须支持**分组选择器**（`.a,\n.b { … }`）：本项目里三个装饰的覆盖规则就是一条
 * 分组规则 —— 只按整串匹配会读不到（本轮实测踩到）。
 */
function rule(cssText: string, selector: string): string {
  const want = selector.trim().replace(/\s+/g, " ");
  let found = "";
  for (const m of cssText.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const list = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (list.includes(want)) found = m[2] ?? "";
  }
  return found;
}

/** 块内的 --hl-* 变量表。 */
function hlVars(selector: string): Record<string, string> {
  const body = rule(stripComments(CSS), selector);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--hl-[a-z]+)\s*:\s*([^;]+);/g)) out[m[1] ?? ""] = (m[2] ?? "").trim();
  return out;
}

function containerWith(html: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "content rendered";
  box.innerHTML = html;
  document.body.appendChild(box);
  return box;
}

const HEAD = "." + CODE_HEAD_CLASS;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("W1526 ① 装饰元素不挡文字（结构不变量）", () => {
  it("工具条是 pre 的**前面兄弟**（正常流），装饰住在工具条里", () => {
    const box = containerWith("<pre><code class='language-ts'>const a = 1;</code></pre>");
    const offCopy = registerEnhancer(codeCopyEnhancer());
    const offExtras = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      const wrap = box.querySelector(".code-wrap")!;
      const pre = wrap.querySelector("pre")!;
      const head = wrap.querySelector(HEAD)!;
      expect(head, "工具条必须存在").not.toBeNull();
      expect(head.parentElement, "工具条住在 .code-wrap 里（不在 pre 内）").toBe(wrap);
      expect(pre.parentElement).toBe(wrap);
      // ★ 文档序：工具条必须在 pre **之前** —— 这才是「正文从工具条下面开始」。
      const rel = head.compareDocumentPosition(pre);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING, "工具条在前，pre 在后").toBeTruthy();
    } finally { offCopy(); offExtras(); }
  });

  it("★ 三个装饰一个都不在 pre 里（放进 pre 会被横向滚动带走）", () => {
    // 行数必须**超过** CODE_FOLD_LINES，否则不会出现折叠按钮，断言会漏测它。
    const long = Array.from({ length: CODE_FOLD_LINES + 5 }, (_, i) => "l" + i).join("\n");
    const box = containerWith("<pre><code class='language-ts'>" + long + "</code></pre>");
    const offCopy = registerEnhancer(codeCopyEnhancer());
    const offExtras = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      const wrap = box.querySelector(".code-wrap")!;
      for (const sel of ["button.code-copy", ".code-badge", "button.code-fold"]) {
        expect(wrap.querySelector(HEAD + " > " + sel), sel + " 在工具条里").not.toBeNull();
      }
      // 反面：pre 内部一个装饰都没有 —— 「不可能压在正文上」的结构前提。
      expect(box.querySelectorAll("pre .code-copy, pre .code-badge, pre .code-fold")).toHaveLength(0);
      expect(box.querySelectorAll("pre " + HEAD)).toHaveLength(0);
    } finally { offCopy(); offExtras(); }
  });

  it("CSS：工具条里的装饰一律 position:static（浮层 = 老 bug 的形态）", () => {
    const css = stripComments(CSS);
    const body = rule(css, ".rendered .code-head .code-badge");
    expect(body, "必须能读到这条覆盖规则").not.toBe("");
    expect(body, "不脱离文档流 ⇒ 不可能与正文重叠").toContain("position: static");
    expect(body, "清掉 absolute 遗留的 inset").toContain("inset: auto");
    expect(rule(css, ".rendered .code-head")).toContain("display: flex");
  });

  it("CSS：三个装饰各有覆盖规则，且特异性高于 components.css 的浮层规则", () => {
    const css = stripComments(CSS);
    for (const sel of [".rendered .code-head .code-copy", ".rendered .code-head .code-badge", ".rendered .code-head .code-fold"]) {
      expect(rule(css, sel), sel + " 必须有自己的覆盖规则").not.toBe("");
      // components.css 写的是 `.rendered .code-copy`（2 个 class）—— 3 个 class 才压得住。
      expect((sel.match(/\.[\w-]+/g) ?? []).length).toBeGreaterThan(2);
    }
  });

  it("幂等：反复跑增强链只产出一条工具条 / 一个徽标 / 一个复制按钮", () => {
    const box = containerWith("<pre><code class='language-ts'>a</code></pre>");
    const offCopy = registerEnhancer(codeCopyEnhancer());
    const offExtras = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      runEnhancers(box);
      runEnhancers(box);
      expect(box.querySelectorAll(HEAD)).toHaveLength(1);
      expect(box.querySelectorAll(".code-badge")).toHaveLength(1);
      expect(box.querySelectorAll("button.code-copy")).toHaveLength(1);
      expect(box.querySelectorAll(".code-wrap")).toHaveLength(1);
    } finally { offCopy(); offExtras(); }
  });

  it("两个组件共用同一条工具条（code-copy 先建、code-extras 复用）", () => {
    const box = containerWith("<pre><code class='language-ts'>a</code></pre>");
    const offCopy = registerEnhancer(codeCopyEnhancer());
    try {
      runEnhancers(box);
      const head = box.querySelector(HEAD);
      expect(head, "code-copy 先建出工具条").not.toBeNull();
      const offExtras = registerEnhancer(codeExtrasEnhancer());
      try {
        runEnhancers(box);
        expect(box.querySelectorAll(HEAD), "不重复建条").toHaveLength(1);
        expect(box.querySelector(HEAD)).toBe(head);
        expect(head!.querySelector(".code-badge"), "徽标进的是同一条").not.toBeNull();
      } finally { offExtras(); }
    } finally { offCopy(); }
  });

  it("组件可各自单独开：只有 code-extras 时工具条里只有徽标", () => {
    const box = containerWith("<pre><code class='language-ts'>a</code></pre>");
    const off = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelector(HEAD)!.querySelector(".code-badge")).not.toBeNull();
      expect(box.querySelector(".code-copy"), "复制组件没开就不该有按钮").toBeNull();
    } finally { off(); }
  });

  it("没东西可放时不留空工具条（无语言 + 未超折叠阈值）", () => {
    const box = containerWith("<pre><code>plain</code></pre>");
    const off = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      expect(box.querySelector(".code-badge"), "无 language-* 不显示徽标").toBeNull();
      expect(box.querySelector(HEAD), "没有装饰就不该建空条").toBeNull();
    } finally { off(); }
  });

  it("折叠按钮也在工具条里（旧实现 bottom:6px 会压住末行）", () => {
    const long = Array.from({ length: CODE_FOLD_LINES + 5 }, (_, i) => "l" + i).join("\n");
    const box = containerWith("<pre><code class='language-ts'>" + long + "</code></pre>");
    const off = registerEnhancer(codeExtrasEnhancer());
    try {
      runEnhancers(box);
      const head = box.querySelector(HEAD)!;
      const fold = head.querySelector("button.code-fold")!;
      expect(fold).not.toBeNull();
      expect(fold.parentElement).toBe(head);
      expect(box.querySelector("pre")!.classList.contains("code-folded")).toBe(true);
      (fold as HTMLButtonElement).click();
      expect(box.querySelector("pre")!.classList.contains("code-folded")).toBe(false);
    } finally { off(); }
  });
});
describe("W1526 ② 高亮配色对齐 VSCode", () => {
  const light = hlVars(":root");
  const dark = hlVars('[data-theme="dark"]');

  it("浅色定义了完整的一套 --hl-*（防解析失效空跑）", () => {
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(10);
  });

  it("深色覆盖**每一个**浅色 key（漏一个 ⇒ 深色下那个 token 不可读）", () => {
    expect(Object.keys(light).filter((k) => !(k in dark))).toEqual([]);
  });

  it("取值等于 highlight.js 官方 VSCode 主题（Light+ = styles/vs.css）", () => {
    expect(light["--hl-comment"]).toBe("#008000");   // vs: .hljs-comment
    expect(light["--hl-keyword"]).toBe("#0000ff");   // vs: .hljs-keyword
    expect(light["--hl-string"]).toBe("#a31515");    // vs: .hljs-string
    expect(light["--hl-attr"]).toBe("#ff0000");      // vs: .hljs-attr
    expect(light["--hl-meta"]).toBe("#2b91af");      // vs: .hljs-meta
  });

  it("取值等于 highlight.js 官方 VSCode 主题（Dark+ = styles/vs2015.css）", () => {
    expect(dark["--hl-comment"]).toBe("#57a64a");    // vs2015: .hljs-comment
    expect(dark["--hl-keyword"]).toBe("#569cd6");    // vs2015: .hljs-keyword
    expect(dark["--hl-string"]).toBe("#d69d85");     // vs2015: .hljs-string
    expect(dark["--hl-number"]).toBe("#b8d7a3");     // vs2015: .hljs-number
    expect(dark["--hl-attr"]).toBe("#9cdcfe");       // vs2015: .hljs-attr
    expect(dark["--hl-builtin"]).toBe("#4ec9b0");    // vs2015: .hljs-built_in
  });

  it("两套主题内 token 都要真的有区分度（不得全部同色）", () => {
    for (const [name, vars] of [["light", light], ["dark", dark]] as const) {
      expect(new Set(Object.values(vars)).size, name + " 主题 token 色种类").toBeGreaterThanOrEqual(5);
    }
  });

  it("浅色与深色必须真的不同（深色不是把浅色抄了一遍）", () => {
    expect(Object.keys(light).filter((k) => light[k] === dark[k])).toEqual([]);
  });
});
