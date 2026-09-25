// ============================================================================
// ui/workbench/files-inline.ts — W1532：文件行**内联展开**的内容装载。
// ----------------------------------------------------------------------------
// 用户要求（VSCode 风格）：「点击文件默认就是展开的」。展开块挂在**文件行正下方**
// （DOM 上是 .wb-row 的兄弟，见 files.ts），不是右侧覆盖式浮层。
//
// 为什么单独一个文件而不是塞进 files.ts：内联展开有自己的一组规则（上限、降级、
// 渲染分派），与「浏览目录」是两件事；files.ts 已经承担导航 + 竞态 + 列表渲染，
// 再长就会盖住它自己的主线（本仓单文件 400 行上限）。
//
// 复用**既有**渲染器与**既有**文案：内容分派走 ui/preview/renderers 的
// renderPreview（markdown / diff / code / 图片 / 降级同一套），降级原因直接沿用
// F2 预览的字典键 —— 同一种失败在浮层里与内联里必须是同一句话。
// ============================================================================
import { el } from '../../utils/dom';
import { api, userErrorText } from '../../api';
import { classifyByPath, type PreviewKind } from '../preview/detect';
import { renderPreview } from '../preview/renderers';
import { runEnhancers } from '../enhance';
import { t } from '../../i18n';

/**
 * 内联展开的**字符上限**（比 F2 浮层的 256 KiB 更紧）。
 *
 * 为什么更紧：内联块长在**目录列表**里，用户还会继续往下翻其它文件；把一个
 * 256 KiB 的文本塞进行内，滚动条会被它一个人吃掉，列表本身就没法用了。超过
 * 上限**不截断塞进去**，而是给一句可读的降级（与浮层同一条口径：宁可说清楚，
 * 不要塞半截让人误以为文件就这么长）。
 */
export const INLINE_MAX_CHARS = 128 * 1024;

/** 一次内联装载的结果（node 直接插进展开块；badge 非空 = 降级类型标记）。 */
export interface InlineLoad {
  node: HTMLElement;
  /** 降级类型标记（二进制 / 过大 / 类型不支持）；正常内容是 null。 */
  badge: string | null;
  /** 服务端说响应只是窗口（还有更多行 / 撞了字节预算）。 */
  truncated: boolean;
}

/**
 * 扩展名不认识（LICENSE / Makefile）或图片（内联没有 URL 可给）时按**纯文本**渲染 ——
 * 与 F2 浮层同一条规则（见 files.ts 的 filePreviewKind），避免「类型不支持」误判。
 */
function kindOf(path: string): PreviewKind {
  const k = classifyByPath(path);
  return k === 'markdown' || k === 'diff' || k === 'code' ? k : 'code';
}

function degradedNode(reason: string): HTMLElement {
  return renderPreview({ path: '', kind: 'unknown', text: null, degraded: reason }).node;
}

/**
 * 装载一个文件的内联内容。**永不抛**：读取失败 / 二进制 / 过大都给可读降级，
 * 绝不白屏、绝不静默（F2 的降级口径原样复用）。
 */
export async function loadInline(abs: string): Promise<InlineLoad> {
  let r;
  try {
    r = await api.fsRead(abs);
  } catch (err) {
    return { node: degradedNode(userErrorText(err, t('chat.preview.degradeReadFailed'))), badge: null, truncated: false };
  }
  if (r.error !== undefined && r.error !== '') {
    return { node: degradedNode(r.error), badge: null, truncated: false };
  }
  if (r.kind === 'binary') {
    return { node: degradedNode(t('chat.preview.degradeBinary')), badge: t('chat.preview.badgeBinary'), truncated: false };
  }
  const text = r.text ?? '';
  if (text.length > INLINE_MAX_CHARS) {
    return { node: degradedNode(t('chat.preview.degradeTooLarge')), badge: t('chat.preview.badgeTooLarge'), truncated: false };
  }
  const content = renderPreview({ path: abs, kind: kindOf(abs), text });
  // 增强遍（代码高亮 / markdown 围栏 / 复制按钮）走**同一条缝**：浮层里有的，
  // 内联里也得有，否则同一个文件在两处长得不一样。
  // 传容器而不是 content.node：增强遍把参数当**作用域**用（querySelectorAll 只匹配
  // 后代），代码文件的 content.node 本身就是 <pre>，传它会让 pre 类增强全部落空。
  if (content.degraded === null) {
    const box = el('div', 'wb-inline-content');
    box.appendChild(content.node);
    runEnhancers(box);
    return { node: box, badge: null, truncated: r.truncated === true };
  }
  return { node: content.node, badge: content.degraded, truncated: r.truncated === true };
}
