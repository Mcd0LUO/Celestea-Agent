// ============================================================================
// utils/markdown.ts — 增量流式 markdown 渲染（W301）
//
// 现状问题（messages.ts 旧实现）：每个渲染节拍对「整段累积文本」全量
//   marked.parse + 全量代码高亮。实测 128K 字符时单次 ≈ 60ms（不含 DOM
//   解析/布局/绘制/强制回流），60ms 节拍被吃满 → 主线程饱和、UI 假死。
//
// 本模块把文本切成两段：
//   - stableHtml：已固化前缀的 HTML（只解析一次，之后永不重解析）
//   - stableLen ：该前缀在原文中的长度
//   - tail      ：未固化尾部（每个节拍只解析这一段）
// update(fullText) 返回 stableHtml + md(tail)，在「安全切分」前提下与
// 「整段一次解析」的 HTML 逐字节等价（bench 用逐字符前缀校验实测）。
//
// 切分必须保守：宁可少固化（退化为当前全量行为，不得比现状更差），
// 也绝不固化错。判定见 findFixLen() / boundarySafe()：
//   1) 只在「空行边界」后固化完整区域（围栏内/HTML 容器块内的空行不算边界）；
//   2) 区域内未闭合围栏、未闭合 HTML 容器（pre/script/style/textarea/注释）
//      不固化；
//   3) 区域内行内标记未闭合（** / ` / ~~ / 方括号）不固化；
//   4) 引用式链接（[x] / [x][y]）的解析依赖「全文任意位置」的引用定义行，
//      而定义常出现在文末：只要全文（围栏/缩进代码之外）存在定义行，含用法
//      的区域一律不固化；定义尚未出现时允许临时固化并记录 refFrozen，定义
//      一旦出现即 reset() 整体重渲染一次（详见 MarkdownStream.update）；
//   5) 区域末行含 `|` 且后一行也含 `|`（可能组成表格）时不固化；
//   6) 区域含列表项且后一行是列表项/列表残行（`1`、`1.`、`-`）时不固化
//      （会被合并成同一个列表，松散化 → <p> 包裹）；
//   7) 后一行以缩进开头（列表/引用/缩进代码可跨空行续接）、或区域末尾之后
//      没有非空行时不固化。
//   边界不安全时**不立即停止**，而是把后续块并入候选区域继续找下一个边界
//   ——避免「一个表格/一次未闭合行内标记把后续全部文本永久留在 tail 里」。
//
// ★ 引用定义/用法判定必须**围栏与缩进代码感知**（W301 复审修复）：
//   代码块里一行 `[info]: xxx`（日志、YAML、`[INFO]:` 等）在纯文本正则下
//   会被误判为「引用定义行」。后果有两个，实测都能把卡死放回来：
//     - 误判为定义 → boundarySafe 永久拒绝固化含 `[x]` 用法的区域
//       → stableLen 恒为 0，每个节拍全量重解析（48K 文本实测 7726ms）；
//     - 误判为用法 → refFrozen 被置位，而同一行又命中「定义」检测
//       → 每节拍 reset() 一次（reset 风暴，实测 resets=1610）。
//   因此这里统一用「围栏感知扫描」判定：REF_DEF_LINE_RE / REF_USE_RE 只在
//   非围栏、非缩进代码行上生效——全文检测走 hasFenceAwareDef()，块检测走
//   blockHasRefUse()，逐行统计走 feedLine()（三者口径一致）。
//
// 对外接口：update() 返回完整 HTML（兼容基准/历史路径）；updateParts() 额外返回
//   「本次新固化的 HTML 增量」与「尾部 HTML」，供 messages.ts 做局部 DOM 替换
//   （已固化块对应的 DOM 节点原地保留 → 浏览器不重解析、已高亮代码块不重建）。
//
// 另一个必须处理的坑：marked 的标题 id 由 Parser 内的 Slugger 递增（同名标题
//   会得到 `标题`、`标题-1`…）。若分块解析时每块用新 Parser，重复标题的 id 会
//   漂移。因此这里始终自己 new Parser 并维护跨块 slugger 状态：固化块渲染后
//   持久化 seen，尾部块渲染时以 seen 为种子但不回写（尾部每 tick 重解析，
//   回写会造成重复计数）。标题 id 因此与「整段一次解析」完全一致。
// ============================================================================
import { marked, Parser } from 'marked';

// 与现状一致（breaks/gfm）；renderMarkdown 与分块解析共用同一套默认选项
marked.setOptions({ breaks: true, gfm: true });

// ---- 兜底转义（与 utils/dom.esc 同一映射；本地实现以免本模块依赖 DOM） -------
const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

/**
 * 用自带 slugger 状态的 Parser 渲染（等价于 marked.parse，但标题 id 计数器
 * 跨块连续）。seen 为标题 slug 计数表；persist=true 时把本次计数回写。
 */
function parseWith(seen: Record<string, number>, text: string, persist: boolean): string {
  // 复制默认选项（与 marked.parse 一致）：Parser 构造器会往 options 上写
  // renderer，直接传 marked.defaults 会污染全局默认值。
  const opts = { ...marked.defaults };
  const parser = new Parser(opts);
  Object.assign(parser.slugger.seen, seen);
  const html = parser.parse(marked.lexer(text, opts));
  if (persist) Object.assign(seen, parser.slugger.seen);
  return html;
}

/** 一次性全量渲染（历史恢复路径 / done 全文覆盖用）。 */
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return '<pre>' + escapeHtml(text) + '</pre>';
  }
}

/** 单块解析（与 renderMarkdown 同管线；固化块/尾部块解析用）。 */
function md(text: string, seen: Record<string, number>, persist: boolean): string {
  try {
    return parseWith(seen, text, persist);
  } catch {
    return '<pre>' + escapeHtml(text) + '</pre>';
  }
}

// ---- 行级扫描 ----------------------------------------------------------------

/**
 * 围栏开行：与 marked 的 fences 规则同口径——反引号围栏的语言行不得含反引号
 * （marked: `` `{3,}(?=[^`\n]*(?:\n|$)) ``），波浪号围栏语言行不限。
 * 判定必须与 marked 一致：把真围栏误判为普通行会导致在代码块中间固化。
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})([^\n]*)$/;
/**
 * 可能的围栏行（开或闭）：前导同字符 run + 允许的尾随 `~`/`` ` ``。
 * 与 marked 的 fences 规则同口径——闭围栏必须是**同一字符**且长度不短于开行
 * （marked: `(?: {0,3}\1[~`]* *(?=\n|$)|$)`）；若把混字符行当闭行（例如
 * 开行 ``` 而 `~~~` 之类的行），会误在代码块中间固化。
 */
const FENCE_LINE_RE = /^ {0,3}(`+|~+)([~`]*)[ \t]*$/;
/** 列表项行（无序 / 有序）。 */
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** 「可能是列表项」的残行（`1`、`1.`、`- `、`*`）：下一 tick 补全后会与前一块合并。 */
const LISTISH_RE = /^ {0,3}(?:[-*+]|\d{1,9})(?:[.)][ \t]*)?$/;
/** 任意缩进深度的列表项行（嵌套列表末行也会与后续同级项合并）。 */
const LIST_ANY_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** 缩进行（2 空格以上或制表符）：列表/引用续行、缩进代码块可跨空行。 */
const INDENT_RE = /^(?: {2,}|\t)/;
/** setext 标题下划线（空行理论上阻断，保守起见仍不固化）。 */
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** 主题分隔线（`***` 等，行内标记统计前剔除，避免误判未闭合 `**`）。 */
const THEMATIC_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/**
 * 引用定义**单行**判定：`[id]: url`。
 * 只在「非围栏、非缩进代码」行上使用（围栏感知，见文件头 ★ 说明）。
 */
const REF_DEF_LINE_RE = /^ {0,3}\[[^\]\n]+\]:/;
/** 引用式链接用法：`[text]` 或 `[text][ref]`（未紧跟 `(` 即非行内链接）。 */
const REF_USE_RE = /\[[^\]\n]*\](?!\()/;
/**
 * 裸 HTML 标签/构造（行内或块级）探测：`<tag`、`</tag>`、`<!--`、`<?`、`<!X`。
 *
 * marked 对 HTML 有多套跨空行吞并规则（容器块 <pre|script|style|textarea>、
 * 注释/PI/CDATA/声明、type 6/7 标签块、行内 raw block 状态），其边界行为依赖
 * 全文结构，无法用廉价的行级统计可靠判定「切分后等价」。因此采取保守策略：
 * 区域内（围栏/缩进代码之外）出现任何裸 HTML 构造 → 该区域不固化，退化为
 * 全量渲染（与现状相同，绝不比现状更差）。围栏/缩进代码里的 `<` 是字面量，
 * 不触发该规则（rust 泛型等不受影响）。
 */
const RAW_HTML_RE = /<[a-zA-Z!/?]/;
/** 缩进代码行 / 制表符起始行。 */
const CODE_LINE_RE = /^(?: {4,}|\t)/;

/**
 * 取 i 处的行内容与下一行起点。CRLF / CR / LF 均视为换行——marked 的 Lexer
 * 会先把 `\r\n|\r` 归一化为 `\n`，若这里只按 `\n` 切行，含 `\r` 的文本会
 * 与 marked 看到的分块结构不一致（可能把围栏行误判为普通行）。
 */
function lineAt(text: string, i: number): { line: string; next: number; eol: boolean } {
  let j = i;
  while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
  if (j >= text.length) return { line: text.slice(i), next: text.length, eol: false };
  let next = j + 1;
  if (text[j] === '\r' && text[next] === '\n') next += 1;
  return { line: text.slice(i, j), next, eol: true };
}

// ---- 围栏感知的整段检测（引用定义 / 引用用法） ----------------------------------

/**
 * 围栏与缩进代码感知的行遍历：对每个「普通行」（非围栏内容、非缩进代码）
 * 调用 visit(line)。与 feedLine 的过滤口径一致。
 */
function scanPlainLines(text: string, visit: (line: string) => void): void {
  let i = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  while (i < text.length) {
    const { line, next } = lineAt(text, i);
    if (!inFence) {
      const fm = FENCE_OPEN_RE.exec(line);
      if (fm) {
        const marker = fm[1] ?? '';
        inFence = true;
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        i = next;
        continue;
      }
    } else {
      const cm = FENCE_LINE_RE.exec(line);
      const marker = cm?.[1] ?? '';
      if (marker !== '' && marker.charAt(0) === fenceChar && marker.length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      i = next;
      continue;
    }
    if (line.trim() !== '' && !CODE_LINE_RE.test(line)) visit(line);
    i = next;
  }
}

/**
 * 全文（围栏/缩进代码之外）是否出现引用定义行。
 * 定义可以出现在用法之后的任意位置，因此边界判定必须用**全文**结果，
 * 否则「用法块先固化、定义后到」会产出与整段解析不一致的 HTML。
 */
function hasFenceAwareDef(text: string): boolean {
  let found = false;
  scanPlainLines(text, (line) => {
    if (!found && REF_DEF_LINE_RE.test(line)) found = true;
  });
  return found;
}

/** 某段文本（围栏/缩进代码之外）是否出现引用式链接用法。 */
function blockHasRefUse(block: string): boolean {
  let found = false;
  scanPlainLines(block, (line) => {
    if (!found && REF_USE_RE.test(line)) found = true;
  });
  return found;
}

// ---- 候选区域状态（增量累加，不重复扫旧行） ------------------------------------

/** 区域 [stable, 候选边界) 的结构统计，用于判定该切分点是否与整段解析等价。 */
interface RegionState {
  inFence: boolean;        // 是否位于未闭合围栏内
  fenceChar: string;       // 围栏字符（` 或 ~）
  fenceLen: number;        // 围栏长度
  ticks: number;           // 行内代码标记（` 串）计数
  strong: number;          // ** 计数
  strike: number;          // ~~ 计数
  openBrackets: number;    // [ 计数
  closeBrackets: number;   // ] 计数
  refUse: boolean;         // 出现引用式链接用法（围栏/缩进代码之外）
  hasList: boolean;        // 出现列表项（含嵌套）
  hasRawHtml: boolean;     // 区域内出现裸 HTML 标签/构造（保守：不固化）
  lastLine: string | null; // 最后一个非空行（含缩进行）
  hasContent: boolean;     // 区域内是否有非空内容
}

function newRegion(): RegionState {
  return {
    inFence: false,
    fenceChar: '',
    fenceLen: 0,
    ticks: 0,
    strong: 0,
    strike: 0,
    openBrackets: 0,
    closeBrackets: 0,
    refUse: false,
    hasList: false,
    hasRawHtml: false,
    lastLine: null,
    hasContent: false,
  };
}

function cloneRegion(st: RegionState): RegionState {
  return { ...st };
}

/** 把一行计入区域状态（围栏行只切围栏状态，不参与行内标记统计）。 */
function feedLine(st: RegionState, line: string): void {
  if (!st.inFence) {
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      const marker = fm[1] ?? '';
      st.inFence = true;
      st.fenceChar = marker.charAt(0);
      st.fenceLen = marker.length;
      if (line.trim() !== '') st.hasContent = true;
      return; // 围栏开行不参与行内统计，也不作为表格候选行
    }
  } else {
    // 围栏内容行：字面量，全部跳过；只等与开行同字符且不短于开行的闭行
    const cm = FENCE_LINE_RE.exec(line);
    const marker = cm?.[1] ?? '';
    if (marker !== '' && marker.charAt(0) === st.fenceChar && marker.length >= st.fenceLen) {
      st.inFence = false;
      st.fenceChar = '';
      st.fenceLen = 0;
    }
    if (line.trim() !== '') st.hasContent = true;
    return;
  }
  if (line.trim() === '') return;
  st.hasContent = true;
  st.lastLine = line;
  // 缩进代码：其中的标记是字面量，不参与行内配对，也不算引用定义/用法
  if (CODE_LINE_RE.test(line)) return;
  // 主题分隔线：`***` / `---` 是分隔线而非未闭合强调
  if (THEMATIC_RE.test(line)) return;
  if (RAW_HTML_RE.test(line)) st.hasRawHtml = true;
  const ticks = line.match(/`+/g);
  if (ticks) st.ticks += ticks.length;
  const strong = line.match(/\*\*/g);
  if (strong) st.strong += strong.length;
  const strike = line.match(/~~/g);
  if (strike) st.strike += strike.length;
  const open = line.match(/\[/g);
  if (open) st.openBrackets += open.length;
  const close = line.match(/\]/g);
  if (close) st.closeBrackets += close.length;
  if (REF_USE_RE.test(line)) st.refUse = true;
  if (LIST_ANY_RE.test(line)) st.hasList = true;
}

/**
 * 候选区域 [stable, boundary) 是否可在 boundary 处固化（nextLine = 边界之后
 * 第一条非空行；hasDef = 全文（围栏/缩进代码之外）存在引用定义行）。
 */
function boundarySafe(snap: RegionState, nextLine: string, hasDef: boolean): boolean {
  if (snap.inFence) return false;                              // 未闭合围栏
  if (snap.hasRawHtml) return false;                           // 区域含裸 HTML（保守：不固化）
  if (snap.refUse && hasDef) return false;                     // 用法会被文末定义解析成链接
  if (snap.ticks % 2 !== 0) return false;                      // 未闭合 `
  if (snap.strong % 2 !== 0) return false;                     // 未闭合 **
  if (snap.strike % 2 !== 0) return false;                     // 未闭合 ~~
  if (snap.openBrackets !== snap.closeBrackets) return false;  // 未闭合 [
  const last = snap.lastLine;
  // 表格：末行含 `|` 且后一行也含 `|`（可能是表头 + 分隔行/数据行）
  if (last !== null && last.indexOf('|') !== -1 && nextLine.indexOf('|') !== -1) return false;
  // 列表合并：区域内有列表项且后一行是列表项/列表残行
  if (snap.hasList && (LIST_RE.test(nextLine) || LISTISH_RE.test(nextLine))) return false;
  // 续接：后一行以缩进开头（列表/引用/缩进代码）、或为 setext 下划线
  if (INDENT_RE.test(nextLine)) return false;
  if (SETEXT_RE.test(nextLine)) return false;
  return true;
}

/**
 * 在 tail 中寻找可安全固化的前缀长度（0 = 不前进，退化为全量行为）。
 * 单次 O(n) 前向扫描：区域状态增量累加，遇到空行时挂起候选边界并快照状态，
 * 到「下一条非空行」时判定快照是否安全；不安全则作废候选、区域继续增长。
 *
 * hasDef 由调用方传入（全文围栏感知检测结果）——定义可能在候选边界之后，
 * 只看已扫描范围会漏判。
 */
function findFixLen(tail: string, hasDef: boolean): number {
  let stable = 0;              // 已确认可固化的长度
  let st = newRegion();        // 当前区域 [stable, 扫描位置)
  let pending = -1;            // 挂起的候选边界（区域结束位置）
  let snap: RegionState | null = null;
  let i = 0;
  while (i < tail.length) {
    const { line, next, eol } = lineAt(tail, i);
    // 只把「真正空行」（长度为 0）当边界：只含空白的行可被 marked 的
    // setext 标题规则跨行吞并（`(?:.|\n(?!\n))+?` 允许 ` \n`），
    // 若在空白行处固化会与整段解析结果不一致。
    const blank = eol && line === '';
    if (!blank && line.trim() !== '') {
      // 非空行：先判定挂起候选（该行属于下一个区域，故先判定再计入）
      if (pending >= 0 && snap !== null) {
        if (boundarySafe(snap, line, hasDef)) {
          stable = pending;
          st = newRegion();
        }
        pending = -1;
        snap = null;
      }
    }
    feedLine(st, line);
    if (!st.inFence && blank) {
      if (!st.hasContent) {
        // 连续空行：直接并入已固化区（无内容可解析）
        stable = next;
        st = newRegion();
        pending = -1;
        snap = null;
      } else {
        pending = next;
        snap = cloneRegion(st);
      }
    }
    i = next;
  }
  return stable;
}

// ---- 增量流式解析器 -----------------------------------------------------------

/** MarkdownStream.updateParts() 的返回值（增量 DOM 更新用）。 */
export interface MarkdownParts {
  /** 完整 HTML（= stableHtml + tailHtml） */
  html: string;
  /** 已固化前缀的 HTML（本 tick 不会变） */
  stableHtml: string;
  /** 本次新固化出来的 HTML 增量（空串 = 无新增固化） */
  stableDeltaHtml: string;
  /** 未固化尾部 HTML */
  tailHtml: string;
  /** 已固化前缀的原文长度 */
  stableLen: number;
  /** 本次是否发生整体重置（调用方须重建整个容器） */
  reset: boolean;
}

/**
 * 增量流式 markdown 解析器。
 * 每 tick 用「累积全文」调用 update()，返回该渲染的完整 HTML。
 */
export class MarkdownStream {
  /** 已固化前缀对应的 HTML */
  private stableHtml = '';
  /** stableHtml 对应的原文长度 */
  private stableLen = 0;
  /** 上一次 update() 传入的全文（用于前缀/回退判定与无变化短路） */
  private raw = '';
  /** 上一次的完整 HTML（内容未变时直接返回） */
  private html = '';
  /** 上一次的尾部 HTML（未固化部分） */
  private tailHtml = '';
  /** 已固化前缀的标题 slug 计数（跨块连续，见文件头说明） */
  private seen: Record<string, number> = {};
  /** 已固化前缀里含「无定义时的引用式链接用法」→ 定义行一旦出现必须整体重渲染 */
  private refFrozen = false;

  /** 已固化前缀长度（诊断/基准用；只读）。 */
  get stableLength(): number {
    return this.stableLen;
  }

  /** 会话清空 / 新段开始时复位缓存。 */
  reset(): void {
    this.stableHtml = '';
    this.stableLen = 0;
    this.raw = '';
    this.html = '';
    this.tailHtml = '';
    this.seen = {};
    this.refFrozen = false;
  }

  /** 每 tick 用「累积全文」调用；返回该渲染的完整 HTML。 */
  update(fullText: string): string {
    return this.updateParts(fullText).html;
  }

  /**
   * 每 tick 用「累积全文」调用；返回渲染结果的分解形式：
   *   html            = stableHtml + tailHtml（完整 HTML）
   *   stableDeltaHtml = 本次新固化出来的 HTML（空串 = 无新增固化）
   *   tailHtml        = 未固化尾部 HTML（每 tick 重建）
   *   stableLen       = 已固化前缀的原文长度
   *   reset           = 本次发生了整体重置（调用方须重建整个容器）
   */
  updateParts(fullText: string): MarkdownParts {
    const text = typeof fullText === 'string' ? fullText : String(fullText ?? '');
    if (text === this.raw) {
      // 内容未变：不重复解析，直接复用上次结果
      return {
        html: this.html,
        stableHtml: this.stableHtml,
        stableDeltaHtml: '',
        tailHtml: this.tailHtml,
        stableLen: this.stableLen,
        reset: false,
      };
    }
    let didReset = false;
    // 长度回退 / 内容不一致（done 全文覆盖、会话切换、编辑）→ 整体重来
    if (!text.startsWith(this.raw)) {
      this.reset();
      didReset = true;
    }
    // 全文（围栏/缩进代码之外）是否存在引用定义行：决定含用法区域能否固化。
    // 必须用全文结果——定义可能在候选边界之后。
    const hasDef = hasFenceAwareDef(text);
    // 已固化前缀里含引用式用法、而此刻出现了真正的定义行 → 用法解析结果改变，
    // 整体重渲染一次（此后含用法的区域不再固化，见 boundarySafe）。
    if (this.refFrozen && hasDef) {
      this.reset();
      didReset = true;
    }

    const tail = text.slice(this.stableLen);
    const fix = findFixLen(tail, hasDef);
    let stableDelta = '';
    if (fix > 0) {
      const block = tail.slice(0, fix);
      stableDelta = md(block, this.seen, true);
      this.stableHtml += stableDelta;
      this.stableLen += fix;
      // 只在「围栏/缩进代码之外」出现引用用法时才置位（否则代码块里的
      // `[info]` 会触发无意义的整体重渲染）
      if (blockHasRefUse(block)) this.refFrozen = true;
    }

    const rest = text.slice(this.stableLen);
    this.raw = text;
    this.tailHtml = md(rest, this.seen, false);
    this.html = this.stableHtml + this.tailHtml;
    return {
      html: this.html,
      stableHtml: this.stableHtml,
      stableDeltaHtml: stableDelta,
      tailHtml: this.tailHtml,
      stableLen: this.stableLen,
      reset: didReset,
    };
  }
}
