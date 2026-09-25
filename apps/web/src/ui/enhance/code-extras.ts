// ============================================================================
// ui/enhance/code-extras.ts — 代码块增强（W895-C2 · 可选组件）
// ----------------------------------------------------------------------------
// 在**已高亮之后**运行（内置 hljs 遍先注册），对一个 `pre > code` 做四件事：
//   1) 语言徽标（language-xxx；没有就不显示，不写 plaintext）；
//   2) 超长折叠（默认折叠到固定高度 + 展开/收起）；
//   3) 行号栏；
//   4) 悬停整行轻微底色。
// 3/4 需要按行切分：把 code 的子树按 `\n` 拆成每行一个 `.cl`，**保留 hljs 的
// span**（跨行 span 在行边界重开）。切分算法是纯函数 [splitCodeLines]，DOM 只是
// 把节点拍平成 `{classes,text}` 段再回填 —— 不用 innerHTML 重拼（会丢 hljs 标记）。
// 幂等：`code.dataset.linesDone` / `pre` 上的宿主与徽标/按钮只加一次。
// 与 code-copy 协调：**复用**已有 `.code-wrap`，绝不再包一层。
//
// W1526（代码块优化）：徽标与折叠按钮也从**绝对定位浮层**改为住进 `.code-head`
// 工具条（见 code-chrome.ts；工具条在 `.code-wrap` 里、`pre` 上面）—— 此前它们
// 分别压在首行左侧与末行右下角（用户原话「挡文字」）。
// ============================================================================
import { t } from "../../i18n";
import { ensureHead } from "./code-chrome";
import type { Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const CODE_EXTRAS_ID = "display.codeExtras";
/** 超过这个行数默认折叠。 */
export const CODE_FOLD_LINES = 30;
/**
 * W1485：单个代码块的**渲染上限**（字符）。超过就不做行号切分/行号栏 —— 切分要
 * 遍历整棵子树并按行建 span，一个 200K 字符的块会产出上万个节点（真实日志里最大
 * 单条工具结果 196187 字符）。折叠与徽标不受影响，块本身照常渲染。
 */
export const CODE_LINES_MAX_CHARS = 20000;

export interface CodeSegment {
  /** 该段文本继承的 class 链（hljs 的 hljs-* 与 language-*）。 */
  classes: string[];
  text: string;
}
export interface CodeLine {
  segments: CodeSegment[];
}

/**
 * 纯函数：把「按文档序拍平的段」按换行拆成行。
 *   · CRLF / 孤立 CR 归一为 LF；
 *   · 行尾单个 \n 不额外产生空行；中间空行保留为空行；
 *   · 全空输入返回 []；跨段边界不合并（段即高亮单元）。
 */
export function splitCodeLines(segments: readonly CodeSegment[]): CodeLine[] {
  const normalized = segments.map((s) => ({ classes: [...s.classes], text: s.text.replace(/\r\n?/g, "\n") }));
  if (normalized.every((s) => s.text === "")) return [];
  const lines: CodeLine[] = [{ segments: [] }];
  for (const seg of normalized) {
    if (seg.text === "") continue;
    const parts = seg.text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push({ segments: [] });
      const part = parts[i]!;
      if (part !== "") lines[lines.length - 1]!.segments.push({ classes: seg.classes, text: part });
    }
  }
  if (lines.length > 1 && lines[lines.length - 1]!.segments.length === 0) lines.pop();
  return lines;
}

/** 拍平 code 的子树为「文档序段」（继承祖先 class；忽略注释等非元素节点）。 */
export function collectSegments(code: Element): CodeSegment[] {
  const out: CodeSegment[] = [];
  const walk = (node: Node, classes: string[]): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out.push({ classes, text: child.textContent ?? "" });
      } else if (child.nodeType === 1) {
        const e = child as Element;
        const own = (e.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
        walk(e, classes.concat(own));
      }
    }
  };
  walk(code, []);
  return out;
}

/** 一个「代码块增强」遍（工厂：幂等，可反复调用）。 */
export function codeExtrasEnhancer(): Enhancer {
  return { id: CODE_EXTRAS_ID, enhance: applyCodeExtras };
}

function applyCodeExtras(container: Element): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLElement>("pre"))) {
    const code = pre.querySelector("code");
    if (!code) continue;
    if (pre.dataset["structured"] === "1") continue; // csv 已接管
    const wrap = ensureWrap(pre);
    addBadge(wrap, code);
    // W1485：超大块跳过「行号切分」这一步（它是唯一按行建节点的增强）。
    if ((code.textContent ?? "").length <= CODE_LINES_MAX_CHARS) renderLineSpans(code);
    addFold(wrap, pre, code);
  }
}

/** 复用已有 .code-wrap；没有才创建一个（绝不重复包）。 */
function ensureWrap(pre: HTMLElement): HTMLElement {
  const parent = pre.parentElement;
  if (parent !== null && parent.classList.contains("code-wrap")) return parent;
  const wrap = document.createElement("div");
  wrap.className = "code-wrap";
  pre.parentNode?.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  return wrap;
}

/** 语言徽标：取 language-xxx；没有语言就不显示（不写 plaintext）。 */
function addBadge(wrap: HTMLElement, code: Element): void {
  const lang = languageOf(code);
  if (lang === "") return;
  const head = ensureHead(wrap);
  if (childWithClass(head, "code-badge") !== null) return;
  const badge = document.createElement("span");
  badge.className = "code-badge";
  badge.textContent = lang;
  // W1526：徽标是工具条的**首个子节点**（正常流），不再是压在首行上的浮层。
  head.insertBefore(badge, head.firstChild);
}

/** 把 code 子树按行切成 .cl（幂等：dataset.linesDone）。 */
function renderLineSpans(code: Element): void {
  const el = code as HTMLElement;
  if (el.dataset["linesDone"] === "1") return;
  // ★ 换行必须**留在 DOM 文本里**（只是视觉上隐藏）：`.cl` 是 display:block，
  //   于是行与行看起来分行；但如果把 \n 丢掉，`code.textContent` 就变成一整行 ——
  //   复制按钮（读 textContent）会把整段代码复制成一行。故用一个 display:none 的
  //   `.cl-nl` 承载 \n：textContent 正确，渲染不变（在 <pre> 里直接放 \n 会多一个空行）。
  const trailingNewline = (code.textContent ?? "").endsWith("\n");
  const lines = splitCodeLines(collectSegments(code));
  const frag = document.createDocumentFragment();
  const newlineNode = (): Node => {
    const nl = document.createElement("span");
    nl.className = "cl-nl";
    nl.textContent = "\n";
    return nl;
  };
  for (const line of lines) {
    if (frag.childNodes.length > 0) frag.appendChild(newlineNode());
    const row = document.createElement("span");
    row.className = "cl";
    for (const seg of line.segments) {
      if (seg.classes.length === 0) {
        row.appendChild(document.createTextNode(seg.text));
      } else {
        const span = document.createElement("span");
        span.className = seg.classes.join(" ");
        span.textContent = seg.text;
        row.appendChild(span);
      }
    }
    frag.appendChild(row);
  }
  if (trailingNewline && lines.length > 0) frag.appendChild(newlineNode());
  code.replaceChildren(frag);
  el.dataset["linesDone"] = "1";
}

/** 行数超过阈值时默认折叠 + 展开/收起按钮（幂等：工具条里只加一次）。 */
function addFold(wrap: HTMLElement, pre: HTMLElement, code: Element): void {
  // 先判「要不要折叠」再建工具条：没东西可放时不留空工具条（DOM 里不留空节点）。
  const count = code.querySelectorAll(".cl").length;
  if (count <= CODE_FOLD_LINES) return;
  const head = ensureHead(wrap);
  if (childWithClass(head, "code-fold") !== null) return;
  pre.classList.add("code-folded");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn code-fold";
  btn.textContent = t("chat.codeExtras.expand");
  btn.addEventListener("click", () => {
    // 文案由**这一处**更新（不交给 CSS content：读屏要读到真文本）。
    const folded = pre.classList.toggle("code-folded");
    btn.textContent = folded ? t("chat.codeExtras.expand") : t("chat.codeExtras.collapse");
  });
  head.appendChild(btn);
}

/** 直接子元素里按 class 找（避免 :scope，jsdom 支持参差）。 */
function childWithClass(host: Element, cls: string): Element | null {
  for (const child of Array.from(host.children)) if (child.classList.contains(cls)) return child;
  return null;
}

/** 从 class 里取 language-xxx（取不到返回空串）。 */
export function languageOf(code: Element): string {
  const m = /(?:^|\s)language-([A-Za-z0-9_+-]+)/.exec(code.getAttribute("class") ?? "");
  return m === null ? "" : m[1]!;
}
