// ============================================================================
// ui/workbench/files-open.ts — W1545：文件管理器「点文件 ⇒ 右侧预览」的装载侧。
// ----------------------------------------------------------------------------
// 用户要求（原话）：「文件管理器打开文件应该直接渲染完整的文件（流式打开巨文件）
// 而不是直接原地展开」。所以点击**不再**在行下方内联展开（W1532 的 .wb-inline 已删），
// 而是走 ui/preview/panel.ts 的右侧覆盖式预览面板 —— 与工具卡里的「预览」同一个面。
//
// 本模块只负责**怎么把字节喂给面板**：
//   · 服务端 GET /api/fs/read 是**按行窗口**的（offset/limit/totalLines/truncated），
//     所以「完整文件」= 一段一段取到 truncated === false（不设 256 KiB 之类的软上限）；
//   · 首段刻意小（FIRST_SEGMENT_LINES）：面板要**几乎瞬时**出现内容，
//     400 行的往返在任何盘上都远快于 2000 行；后续段放大以减少往返次数；
//   · html 是唯一例外：它的渲染需要**整篇**（iframe srcdoc 逐字节等于文件原文，
//     「源码」视图读的也是同一份文档），所以走一次性读全（内部同样是分段循环，
//     只是不往 DOM 里追加）。其余类型（code/markdown/diff）全部走分段追加。
//
// 降级口径与 F2 预览**同一条**：二进制 / 端点报错 / 读失败都给人话，绝不白屏。
// ============================================================================
import { api } from '../../api';
import { classifyByPath, type PreviewCandidate, type PreviewKind } from '../preview/detect';
import { openPreview, type PreviewLoad } from '../preview/panel';
import { PREVIEW_MAX_CHARS } from '../preview/renderers';
import type { StreamFill } from '../preview/stream';
import { t } from '../../i18n';

/** 首段行数（小 ⇒ 首屏快；见头注）。 */
export const FIRST_SEGMENT_LINES = 400;
/**
 * 后续段行数。
 *
 * ★ 为什么是 1200 而不是更大（W1545 真机实测定的，不是拍的）：
 *   ① 服务端单次响应**本来**就被 256 KiB 字节预算夹住（readTextLines 的
 *      MAX_READ_BYTES），所以「一次多要几行」并不能少读字节，只是把同一个窗口
 *      要得更满；
 *   ② 段越大，**单段高亮的同步时长**越长 —— 主线程的 longtask 就出在这里。
 *      hljs 实测（5000 行样本，node 26）：400 行 ≈ 107ms / 2400 行 ≈ 475ms。
 *      1200 行把单段压到 ≈300ms 量级，配合段间让帧，面板始终可交互；
 *   ③ 每段一个块 ⇒ 块数 = 文件行数 / 1200（20000 行 ⇒ 17 块），不会碎成上千个块。
 */
export const NEXT_SEGMENT_LINES = 1200;

/**
 * 扩展名不认识（LICENSE / Makefile）或图片（文件管理器没有图片 URL 可给）时按
 * **纯文本**渲染 —— 沿用 W1532 files-inline 的同一条规则，避免「类型不支持」误判：
 * 图片按文本读会被服务端如实判为 binary，那才是对的话。
 */
function kindOf(path: string): PreviewKind {
  const k = classifyByPath(path);
  return k === 'markdown' || k === 'diff' || k === 'code' || k === 'html' ? k : 'code';
}

/** 文本里的行数（末行没有换行也算一行；与 readTextLines 的 totalLines 同口径）。 */
export function countLines(text: string): number {
  if (text === '') return 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

/** 分段读取器（每次 next() 取下一段）。 */
export interface SegmentReader {
  next(): Promise<StreamFill>;
}

/**
 * 造一个分段读取器。状态全在闭包里：下一段的 1-based 起始行 + 已累计字符数。
 *
 * 两个防跑飞：
 *   · **不前进就不继续**（服务端若回一个 offset 不动的窗口，循环必须停，否则死循环）；
 *   · 累计字符数撞到 PREVIEW_MAX_CHARS ⇒ 停并 capped=true（面板会**显式**告知）。
 */
export function createReader(abs: string): SegmentReader {
  let next = 1; // 下一段的 1-based 起始行
  let total = 0;
  let chars = 0;
  let stopped = false;
  return {
    next: async (): Promise<StreamFill> => {
      if (stopped) return { text: '', totalLines: total, more: false };
      const limit = next === 1 ? FIRST_SEGMENT_LINES : NEXT_SEGMENT_LINES;
      let r;
      try {
        r = await api.fsRead(abs, next, limit);
      } catch {
        stopped = true;
        return { text: '', totalLines: total, more: false, degraded: t('chat.preview.degradeReadFailed') };
      }
      if (r.error !== undefined && r.error !== '') {
        stopped = true;
        return { text: '', totalLines: total, more: false, degraded: r.error };
      }
      if (r.kind === 'binary') {
        stopped = true;
        return { text: '', totalLines: 0, more: false, degraded: t('chat.preview.degradeBinary') };
      }
      const text = r.text ?? '';
      total = r.totalLines > 0 ? r.totalLines : total;
      chars += text.length;
      const advanced = r.offset + countLines(text);
      let more = r.truncated === true && text !== '' && advanced > next;
      let capped = false;
      if (more && chars >= PREVIEW_MAX_CHARS) {
        more = false;
        capped = true;
      }
      stopped = !more;
      next = advanced;
      return { text, totalLines: total, more, capped };
    },
  };
}

/** 一次性读全（html 用；内部仍是分段循环，只是不往 DOM 里追加）。 */
async function readWhole(abs: string): Promise<PreviewLoad> {
  const reader = createReader(abs);
  let out = '';
  for (;;) {
    const fill = await reader.next();
    if (fill.degraded !== undefined) return { degraded: fill.degraded };
    out += fill.text;
    if (!fill.more) return { text: out, truncated: fill.capped === true };
  }
}

/**
 * 打开一个文件的右侧预览。**同步返回**：面板壳当帧出现，内容随后流式填入。
 */
export function openFilePreview(abs: string): void {
  const kind = kindOf(abs);
  const candidate: PreviewCandidate = { path: abs, kind, source: 'label' };
  if (kind === 'html') {
    openPreview({ candidate, loadFull: () => readWhole(abs) });
    return;
  }
  const reader = createReader(abs);
  openPreview({ candidate, stream: () => reader.next() });
}
