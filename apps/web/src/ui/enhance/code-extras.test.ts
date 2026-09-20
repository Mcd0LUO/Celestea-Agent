// @vitest-environment jsdom
/**
 * W895-C2 — 代码块增强（语言徽标 / 行号 / 悬停行 / 超长折叠）。
 *
 * 重点是**按行切分**这个纯函数：它必须保留 hljs 的 span，跨行 span 在行边界重开，
 * 处理行尾换行 / 空行 / CRLF，并且幂等重入不重复包裹。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Seg { classes: string[]; text: string }
interface Line { segments: Seg[] }
interface CodeExtrasMod {
  splitCodeLines(segments: readonly Seg[]): Line[];
  collectSegments(code: Element): Seg[];
  languageOf(code: Element): string;
  codeExtrasEnhancer(): { id: string; enhance(c: Element): void };
  CODE_EXTRAS_ID: string;
  CODE_FOLD_LINES: number;
}

async function mod(): Promise<CodeExtrasMod> {
  return (await import(/* @vite-ignore */ "./code-extras")) as CodeExtrasMod;
}

/** 用真实 DOM 造一个 <pre><code>（不用 innerHTML，避免依赖消毒）。 */
function preWithCode(cls: string, parts: Array<string | { cls: string; text: string }>): { pre: HTMLElement; code: HTMLElement } {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = cls;
  for (const p of parts) {
    if (typeof p === "string") code.appendChild(document.createTextNode(p));
    else {
      const s = document.createElement("span");
      s.className = p.cls;
      s.textContent = p.text;
      code.appendChild(s);
    }
  }
  pre.appendChild(code);
  document.body.appendChild(pre);
  return { pre, code };
}

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("W895-C2 splitCodeLines（纯函数）", () => {
  it("单行：一段一行", async () => {
    const { splitCodeLines } = await mod();
    expect(splitCodeLines([{ classes: [], text: "abc" }])).toEqual([{ segments: [{ classes: [], text: "abc" }] }]);
  });

  it("多行：按 \\n 拆开，段序与 class 保留", async () => {
    const { splitCodeLines } = await mod();
    const lines = splitCodeLines([{ classes: ["hljs-keyword"], text: "a\nb" }]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.segments).toEqual([{ classes: ["hljs-keyword"], text: "a" }]);
    expect(lines[1]!.segments).toEqual([{ classes: ["hljs-keyword"], text: "b" }]);
  });

  it("跨行 span：两行都带同一个 class（行边界重开）", async () => {
    const { splitCodeLines } = await mod();
    const lines = splitCodeLines([{ classes: ["hljs-string"], text: "x\ny\nz" }]);
    expect(lines.map((l) => l.segments[0]!.classes.join(" "))).toEqual(["hljs-string", "hljs-string", "hljs-string"]);
  });

  it("行尾单个 \\n 不产生额外空行；中间空行保留", async () => {
    const { splitCodeLines } = await mod();
    expect(splitCodeLines([{ classes: [], text: "a\n" }])).toHaveLength(1);
    expect(splitCodeLines([{ classes: [], text: "a\n\nb" }])).toHaveLength(3);
    expect(splitCodeLines([{ classes: [], text: "a\n\nb" }])[1]!.segments).toEqual([]);
  });

  it("CRLF / 孤立 CR 归一为 LF", async () => {
    const { splitCodeLines } = await mod();
    expect(splitCodeLines([{ classes: [], text: "a\r\nb\rc" }]).map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["a", "b", "c"]);
  });

  it("全空输入 → []；单个换行 → 一个空行", async () => {
    const { splitCodeLines } = await mod();
    expect(splitCodeLines([])).toEqual([]);
    expect(splitCodeLines([{ classes: [], text: "" }])).toEqual([]);
    expect(splitCodeLines([{ classes: [], text: "\n" }])).toEqual([{ segments: [] }]);
  });
});

describe("W895-C2 codeExtrasEnhancer（DOM）", () => {
  it("切行保留 hljs span；徽标取 language-xxx；幂等重入不重复包裹", async () => {
    const { codeExtrasEnhancer } = await mod();
    const { pre, code } = preWithCode("language-ts hljs", [{ cls: "hljs-keyword", text: "const" }, " x = 1;\nconst y = 2;"]);
    const container = document.createElement("div");
    container.appendChild(pre);
    const enh = codeExtrasEnhancer();
    enh.enhance(container);
    expect(code.querySelectorAll(".cl")).toHaveLength(2);
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(pre.parentElement?.classList.contains("code-wrap")).toBe(true);
    expect(container.querySelectorAll(".code-wrap")).toHaveLength(1);
    expect(container.querySelector(".code-badge")?.textContent).toBe("ts");

    enh.enhance(container); // 幂等重入
    expect(code.querySelectorAll(".cl")).toHaveLength(2);
    expect(container.querySelectorAll(".code-wrap")).toHaveLength(1);
    expect(container.querySelectorAll(".code-badge")).toHaveLength(1);
  });

  it("没有 language 类就不显示徽标（不写 plaintext）", async () => {
    const { codeExtrasEnhancer } = await mod();
    const { pre } = preWithCode("hljs", ["x"]);
    const container = document.createElement("div");
    container.appendChild(pre);
    codeExtrasEnhancer().enhance(container);
    expect(container.querySelector(".code-badge")).toBeNull();
  });

  it("超过阈值默认折叠，按钮可展开/收起", async () => {
    const { codeExtrasEnhancer, CODE_FOLD_LINES } = await mod();
    const text = Array.from({ length: CODE_FOLD_LINES + 5 }, (_, i) => "line" + i).join("\n");
    const { pre } = preWithCode("language-ts", [text]);
    const container = document.createElement("div");
    container.appendChild(pre);
    codeExtrasEnhancer().enhance(container);
    const btn = container.querySelector<HTMLButtonElement>(".code-fold");
    expect(btn).not.toBeNull();
    expect(pre.classList.contains("code-folded")).toBe(true);
    btn!.click();
    expect(pre.classList.contains("code-folded")).toBe(false);
    btn!.click();
    expect(pre.classList.contains("code-folded")).toBe(true);
  });

  it("复用已有 .code-wrap（code-copy 已包过）而不是再包一层", async () => {
    const { codeExtrasEnhancer } = await mod();
    const { pre } = preWithCode("language-ts", ["x"]);
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    wrap.appendChild(pre);
    const container = document.createElement("div");
    container.appendChild(wrap);
    codeExtrasEnhancer().enhance(container);
    expect(container.querySelectorAll(".code-wrap")).toHaveLength(1);
    expect(pre.parentElement).toBe(wrap);
  });

  it("★ 换行必须留在 DOM 文本里：增强后 code.textContent 与原文逐字相同", async () => {
    // 独立复核补的回归：`.cl` 是 display:block，看起来分行没问题，但如果把 \n 丢掉，
    // `code.textContent` 就变成一整行 —— 而**复制按钮读的正是 textContent**，
    // 会把整段代码复制成一行。这里对每种形状断言逐字相同。
    const { codeExtrasEnhancer } = await mod();
    const cases = ["a\nb\nc\n", "a\nb\nc", "a\n\nb", "only one line", "/**\n * doc\n */\nconst x = 1;\n"];
    for (const src of cases) {
      document.body.replaceChildren();
      const { code } = preWithCode("language-ts", [src]);
      const before = code.textContent ?? "";
      codeExtrasEnhancer().enhance(document.body);
      expect(code.textContent, "源码 " + JSON.stringify(src)).toBe(before);
    }
  });

  it("★ 行内容本身不受影响（换行载体只承载 \\n，不污染行文本）", async () => {
    const { codeExtrasEnhancer } = await mod();
    const { code } = preWithCode("language-ts", ["a\nb"]);
    codeExtrasEnhancer().enhance(document.body);
    expect(Array.from(code.querySelectorAll(".cl")).map((c) => c.textContent)).toEqual(["a", "b"]);
  });
});
