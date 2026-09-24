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
// W1485（模块体积棘轮）：行级正则 / 候选区域统计 / 边界判定已拆到
//   ./markdown-scan.ts         行级正则（唯一一份口径）
//   ./markdown-region-state.ts 区域行内统计（增量累加）
//   ./markdown-region.ts       切分点判定（findFixLen / boundarySafe / forcedCut）
// 本文件只保留「解析器本体」；上面那套判定的完整理由见 markdown-region.ts 文件头。
//
// 切分必须保守：宁可少固化（退化为当前全量行为，不得比现状更差），
// 也绝不固化错。判定见 markdown-region.ts 的 fixLen() / boundarySafe()：
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
// W1485（后台标签页卡死修复）：**尾部上限不在这里**。未闭合围栏让 stableLen 停在
//   围栏之前（实测 106K 文本 6622ms/4000 tick，正常段落同规模 3430ms 且 stableLen
//   已推进到 105887），但那种尾部没有等价切点，强切必然改 HTML —— 上限落在调用方
//   的渲染上限（ui/messages/oversize.ts），见本文件 MarkdownStream 的类注释。
//
// 标题 id：marked v4→v5 上游移除了 headerIds/Slugger，v18 的 heading() 只产出
//   `<hN>…</hN>`（无 id）。但本项目 retain 标题 id（sanitize.ts 的 id 白名单、
//   会话内定位都依赖它），所以这里本地逐字节复刻 v4 的 Slugger 算法，零新依赖
//   （见 ./markdown-heading-id）。同名标题会得到 `标题`、`标题-1`…
//   若分块解析时每块各起一套计数，重复标题的 id 会漂移；因此解析器仍共享同一份
//   跨块 seen：固化块渲染后持久化，尾部块以 seen 为种子但不回写（尾部每 tick
//   重解析，回写会造成重复计数）。标题 id 因此与「整段一次解析」完全一致。
// ============================================================================
import { marked } from 'marked';
import { mathExtension } from './markdown-math';
import { parseWithHeadingIds, type SluggerSeen } from './markdown-heading-id';
import { blockHasRefUse, fixLen, hasFenceAwareDef } from './markdown-region';

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

// ---- 数学（W846 方案 A：只渲染 MathML，懒加载 KaTeX） -------------------------
// 识别逻辑在 ./markdown-math（零 DOM、零 KaTeX）；这里在模块加载时注册扩展，
// 扩展只产出安全占位；真实 MathML 渲染见 ui/messages/math.ts（懒加载）。
marked.use(mathExtension(escapeHtml));

/** 一次性全量渲染（历史恢复路径 / done 全文覆盖用）。 */
export function renderMarkdown(text: string): string {
  try {
    return parseWithHeadingIds({}, text, true);
  } catch {
    return '<pre>' + escapeHtml(text) + '</pre>';
  }
}

/** 单块解析（与 renderMarkdown 同管线；固化块/尾部块解析用）。 */
function md(text: string, seen: SluggerSeen, persist: boolean): string {
  try {
    return parseWithHeadingIds(seen, text, persist);
  } catch {
    return '<pre>' + escapeHtml(text) + '</pre>';
  }
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
 *
 * ★ W1485 的实测结论：本类**没有**、也不该有「尾部超限就强制切分」的兜底。
 *   一个未闭合的代码围栏确实会让稳定前缀停在围栏之前（实测 stableLen=105/106011），
 *   但那种尾部**不存在**任何与「整段一次解析」等价的切点 —— 强切必然改 HTML。
 *   尾部上限的正确落点在**调用方**：ui/messages/oversize.ts 的
 *   MESSAGE_RENDER_LIMIT 把送进来的全文钳在有限长度上，于是
 *   「每 tick 全量重解析」的代价有界（实测 64K 尾部 2.1ms/tick、渲染上限生效后
 *   一次 flush 的解析 0.73ms）。完整论证见 markdown-region.ts 的 fixLen()。
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
  private seen: SluggerSeen = {};
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
    const fix = fixLen(tail, hasDef);
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
