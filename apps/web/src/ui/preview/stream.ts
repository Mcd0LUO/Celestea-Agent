// ============================================================================
// ui/preview/stream.ts — W1545：巨文件的**分段流式装载**（壳先出、内容逐段填）。
// ----------------------------------------------------------------------------
// 需求（用户原话）：「文件管理器打开文件应该直接渲染完整的文件（流式打开巨文件）」+
// 「右侧的预览是应该几乎瞬时出现的」。两条都要，所以装载被拆成两件事：
//   · **壳**由 panel.ts 当帧建好并显示（不等任何读盘）；
//   · **内容**由本模块按服务端的行窗口一段一段取、一段一段追加。
//
// 地基是服务端**已有**的分页读：GET /api/fs/read?path=&offset=<1-based 行>&limit=<行数>
// 200 ⇒ { text, offset, limit, totalLines, truncated }，truncated 说「这只是一段窗口」
// （见 apps/studio/src/handlers/fs-read.ts）。分段策略与「怎么算读完了」全在
// workbench/files-open.ts（它是唯一知道 offset/limit 的地方）。
//
// 三条硬约束：
//   ① **追加，不重建**（FRONTEND-RULES 铁律 1/2）：每段建一个 <pre><code> 块
//      appendChild 到 body 尾部，已有段落原样留在 DOM 里（滚动位置、已高亮的块都不动）。
//      每段一个块而不是拼成一个巨大的块，是因为 hljs 的 dataset.hlDone 幂等标记是
//      **块级**的：拼块会让「已经高亮过的前缀 + 新后缀」每段整块重高亮（O(n²)）。
//      代价是相邻块之间没有词法连续性（跨段的多行注释/模板串会被切成两段各自解析），
//      这是**明确取舍**：对「打开巨文件先看到内容」这个目标，连续性不是关键路径。
//   ② **竞态**：每段落地前查 isCurrent()（panel 的 seq 口径）。快速连点不同文件时，
//      旧文件的段落一个字都不许画进新文件。
//   ③ **不许占住主线程**：段与段之间让出一帧（requestAnimationFrame），
//      让浏览器有机会绘制已追加的内容 —— 这个 paint 就是用户看到的「进度」。
//
// 上限：PREVIEW_MAX_CHARS（renderers.ts 的 8 MiB 绝对闸门）是**客户端**兜底；
// 撞上它不是静默停，而是把「文件超过 N MB 的预览上限」写在面板上（note）。
// ============================================================================
import { el } from '../../utils/dom';
import { runEnhancers } from '../enhance';
import { renderPreview, PREVIEW_MAX_CHARS } from './renderers';
import { extOf } from './detect';
import { LANG_BY_EXT } from './lang';
import { t } from '../../i18n';

/**
 * 分段装载的一步（由调用方的 provider 产出）。
 *
 * text = 本次要追加的文本；totalLines = 服务端报的文件总行数（进度分母）；
 * more = 还有下一段；capped = 撞上客户端硬上限（显式告知）；degraded = 读不下去了。
 */
export interface StreamFill {
  text: string;
  totalLines: number;
  more: boolean;
  capped?: boolean;
  degraded?: string;
}

/** 装载目标（panel.ts 提供；本模块不认识面板的内部状态）。 */
export interface StreamSink {
  /** 内容容器（已带 .rendered，见 panel.ts 的 buildPanel）。 */
  body: HTMLElement;
  /** 文件路径（决定语言 class）。 */
  path: string;
  /** 渲染类型：diff 的行分类需要整篇，故流式只走 code/markdown/unknown。 */
  kind: string;
  /** 这一段还属于当前文件吗（panel 的 seq 守卫）。 */
  isCurrent(): boolean;
  /** 进度 / 上限提示（只改文本，不重建节点）。 */
  note(text: string): void;
}

/**
 * 单个高亮块的**字符上限**（W1545 真机实测踩出来的，不是拍的）。
 *
 * utils/hljs.ts 有一条内置规则：单块 > 32 KB（HL_MAX_BLOCK_CHARS）**直接跳过
 * 高亮**（那是为流式渲染保命的既有取舍，本波不动它）。而服务端的分页窗口是按
 * **行**给的：400 行的首段在「行长 ≈150 字符」的真实源码上就是 ~60 KB ⇒
 * 整段一个字都不高亮。真机第一次跑就是这个结果（.hljs-keyword = 0 个）——
 * 而用户抱怨的恰恰是「打开文件没有高亮」，所以每段进 DOM 前按**行**再切成
 * ≤ 24 KB 的块（给 32 KB 留 8 KB 余量）。
 *
 * 单行本身超过 24 KB（压缩过的 .min.js / 单行 JSON）时它独占一块，由 hljs 那条
 * 既有规则跳过 —— 那是既有取舍，这里不重复实现、也不假装它被高亮了。
 */
export const HL_BLOCK_MAX_CHARS = 24 * 1024;

/**
 * 把一段文本按**行边界**切成若干块，每块 ≤ max 字符（单行超限则独占一块）。
 *
 * 只在超限时才切：常规段（≤ 24 KB）原样返回单元素数组，不引入额外 DOM。
 */
export function splitForHighlight(text: string, max: number = HL_BLOCK_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let start = 0;
  let lastBreak = -1; // 上一次「可以安全断开」的位置（某个换行之后）
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i + 1 - start > max) {
      // 这一行把当前块顶超了：在**上一个**换行处断开（断不出非空块时退化为硬切）。
      const cut = lastBreak > start ? lastBreak : i + 1;
      out.push(text.slice(start, cut));
      start = cut;
    }
    lastBreak = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.length === 0 ? [''] : out;
}

/** 新建一个分段代码块；语言 class 只**声明**，高亮交给增强缝（与整篇预览同一条规则）。 */
function newBlock(path: string, cls: string, text: string): HTMLElement {
  const pre = el('pre', cls);
  const code = el('code');
  const lang = LANG_BY_EXT[extOf(path)];
  if (lang) code.className = 'language-' + lang;
  code.textContent = text;
  pre.appendChild(code);
  return pre;
}

/**
 * 追加一段：按 HL_BLOCK_MAX_CHARS 切块 → 逐块 append → 对**本段新建的块**跑增强缝。
 *
 * ★ 作用域必须是「本段新建的块」，不能是整个 body（W1545 真机实测定的）：
 *   runEnhancers(body) 每段都会**遍历全部已累积的 DOM**，第 k 段要走 k 段那么大的树。
 *   hljs 的 dataset.hlDone 保证了旧块不会被**重算** —— 但**遍历本身**要钱，
 *   这正是「幂等 ≠ 免费」的实例。
 *
 * ★ 还有第二处 O(n²)，在**浏览器**里、不在我们的 JS 里：每追加一段都要重排整篇文档。
 *   逐段埋点（真机，20k 行）：append 0.4–4.5ms、hl ≈150ms 恒定，而「让帧」那一步
 *   9.8 → 47 → 145 → 278 → … → 1301ms 线性增长。修法不在 JS，而在 CSS：
 *   .preview-seg 的 content-visibility:auto 让浏览器跳过视口外的分段
 *   （实测总耗时 30.5s → 3.8s，见 preview.css 的长注释）。
 */
function append(sink: StreamSink, cls: string, text: string): HTMLElement {
  // 作用域容器：只用来**收集**本段新建的块，让增强缝恰好只走这一段。
  // ★ 它必须**已经挂在 body 上**：增强遍按 document 语义操作（createElement /
  //   appendChild / getComputedStyle），脱离 document 的子树会让部分实现静默跳过
  //   （本波真机 + jsdom 都踩过）。它自己不产生盒子：内容全在它里面，而
  //   .preview-seg 走 content-visibility —— 分段块看起来与 body 直接子节点无异。
  const scope = el('div', 'preview-seg');
  if (text === '') return scope; // 空段：连容器都不挂（不留空盒子）
  sink.body.appendChild(scope);
  for (const part of splitForHighlight(text)) {
    if (part === '') continue;
    scope.appendChild(newBlock(sink.path, cls, part));
  }
  return scope;
}

/** 读到一半坏了：保留已读内容，另加一行可读原因（不白屏、不静默）。 */
function appendDegrade(sink: StreamSink, reason: string): void {
  const node = renderPreview({ path: sink.path, kind: 'unknown', text: null, degraded: reason }).node;
  if (sink.body.childElementCount === 0) {
    sink.body.replaceChildren(node);
    sink.body.classList.add('is-degraded');
    return;
  }
  sink.body.appendChild(node);
}

/**
 * 流式装载主循环：**首段落地即返回控制权**，后续段落继续追加。
 *
 * ★ 顺序上有一条不显眼但吃劲的规定：**先 append + paint，再让帧，最后才补跑
 *   整链**（见循环末尾）。首段如果先把 hljs 跑完再让出控制权，首帧就要等整段
 *   高亮（真机实测：60 KB 的首段 ≈ 150-200ms）—— 那正是「面板不瞬时」的形态。
 *   现在的口径是：点击 → 面板壳 + **未高亮的正文**当帧可见（几十 ms），
 *   高亮在随后的帧里补上（用户看到的是「文字先出来、颜色随后到位」）。
 *
 * 返回值无意义（状态全在 DOM 与 note 上）；异常一律转成可读降级，**永不抛**。
 */
export async function streamInto(sink: StreamSink, stream: () => Promise<StreamFill>): Promise<void> {
  const cls = sink.kind === 'diff' ? 'preview-diff' : 'preview-code';
  let total = 0;
  let loaded = 0;
  let first = true;
  let degraded: string | null = null;
  for (;;) {
    let fill: StreamFill;
    try {
      fill = await stream();
    } catch {
      fill = { text: '', totalLines: total, more: false, degraded: t('chat.preview.degradeReadFailed') };
    }
    if (!sink.isCurrent()) return; // 竞态：晚到的段落整段丢弃
    total = fill.totalLines > 0 ? fill.totalLines : total;
    if (fill.degraded !== undefined) {
      degraded = fill.degraded;
      break;
    }
    if (first) {
      // 首段：把**骨架**换成真内容。这里的 replaceChildren 清的是骨架占位，
      // 此刻 body 里还没有任何文件内容（铁律 1 禁的是「清已渲染的内容再加载」）。
      sink.body.replaceChildren();
      sink.body.classList.remove('is-loading');
      first = false;
    }
    // ① 先落 DOM（未高亮的纯文本）。这一步之后**当帧**就有内容可看 —— 面板「瞬时
    //    出现」靠的就是它：首帧不等 hljs。
    const fresh = append(sink, cls, fill.text);
    if (fill.text !== '') loaded += fill.text.split('\n').length;
    const denom = total > 0 ? total : loaded;
    sink.note(t('chat.preview.streamRead', { loaded: Math.min(loaded, denom), total: denom }));
    if (!fill.more) {
      sink.note(fill.capped === true ? t('chat.preview.streamLimit', { mb: Math.round(PREVIEW_MAX_CHARS / (1024 * 1024)) }) : '');
      // ② 末段：不再让帧，直接高亮（此时没有「后续段落」要抢时间）。
      runEnhancers(fresh);
      break;
    }
    // ③ 让出一帧：浏览器先绘制**未高亮**的正文（可见的进度），高亮在下一帧再跑。
    //    巨文件因此不会在「点击 → 首帧」之间插入任何长任务。
    await new Promise<void>((r) => { requestAnimationFrame(() => { r(); }); });
    if (!sink.isCurrent()) return;
    // ④ 补高亮：只跑本段新建的块（见 append 的作用域注释）。
    runEnhancers(fresh);
  }
  if (!sink.isCurrent()) return;
  if (degraded !== null) {
    sink.body.classList.remove('is-loading');
    appendDegrade(sink, degraded);
    sink.note('');
  }
  // 收尾再跑一次整链：code-extras 的**折叠**判据要数一个块**完整**的行数（幂等，
  // 旧块不会被重算，代价是一次遍历）。逐段跑会把第一段误判成「短块 ⇒ 不折叠」。
  runEnhancers(sink.body);
}
