// ============================================================================
// ui/attachment-view.ts — W805 附件渲染（气泡网格 / 待发缩略图条 / 放大浮层）。
//   为守模块体积棘轮从 ui/attachments.ts 拆出；本层不做网络请求、不改状态。
//   W867（追加）：待发条从「输入框左侧的一摞卡片」改成**悬浮在输入框上方的收纳展示夹**
//     —— 单行 + 横向滚动 + 单个移除 + 整体折叠，展开也不挤 #input 宽度（绝对定位，见
//     styles/attachments.css）；缩略图不再假设一定是图片：非图片 / 无预览地址的条目
//     退化成「文件名首字」通用图标（W869 的文本附件会走这条路径）。
// ============================================================================
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { AttachmentRef, ImageMediaType } from '../types/attachment';
import type { PendingAttachment } from './attachments';

/** 渲染一层附件所需的全部字段（live 有 url+bytes；历史只有 ref 元数据）。 */
export interface AttachmentView {
  ref?: AttachmentRef;
  name?: string;
  url?: string;
  bytes?: number;
  /** W869：'text' = 文本文件（气泡里只给文件名 chip + 大小，全文不进气泡）。 */
  kind?: 'image' | 'text';
}

export function renderAttachmentGrid(views: readonly AttachmentView[]): HTMLElement {
  const grid = el('div', 'attach-grid');
  for (const v of views) grid.appendChild(attachmentItem(v));
  return grid;
}

/** 待发缩略图条：每项可单个移除；被拒项标红并写明原因；整条可折叠（W867）。 */
export function renderTray(
  container: HTMLElement,
  items: readonly PendingAttachment[],
  onRemove: (p: PendingAttachment) => void,
  onToggleFold?: () => void,
): void {
  if (items.length === 0) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }
  container.classList.remove('hidden');
  const folded = container.classList.contains('collapsed');
  const kids: HTMLElement[] = [foldButton(container, items.length, folded, onToggleFold)];
  for (const it of items) kids.push(pendingItem(it, onRemove));
  container.replaceChildren(...kids);
}

/** 折叠键：常显（折叠态下它是唯一可见项），点它切换整条的展开/收起。 */
function foldButton(
  container: HTMLElement,
  count: number,
  folded: boolean,
  onToggleFold?: () => void,
): HTMLElement {
  const btn = el('button', 'attach-mode') as HTMLButtonElement;
  btn.type = 'button';
  btn.dataset['fold'] = folded ? 'collapsed' : 'expanded';
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  btn.title = folded ? '展开附件' : '收起附件';
  btn.setAttribute('aria-label', btn.title);
  btn.appendChild(el('span', 'attach-mode-label', '附件 ' + count));
  btn.appendChild(el('span', 'attach-mode-fold', folded ? '▸' : '▾'));
  btn.addEventListener('click', () => {
    container.classList.toggle('collapsed');
    onToggleFold?.();
  });
  return btn;
}

function pendingItem(item: PendingAttachment, onRemove: (p: PendingAttachment) => void): HTMLElement {
  const node = el('div', 'attach-item' + (item.error !== '' ? ' err' : ''));
  // W869：文本待发项给「文」字形（与历史附件网格同一形态），图片走空 url ⇒ 原占位。
  node.appendChild(thumb(item.url, item.name, item.name, item.kind === 'text' ? '文' : undefined));
  const meta = el('div', 'attach-meta');
  meta.appendChild(el('div', 'attach-name', item.name));
  const sub = item.error !== '' ? item.error : (item.kind === 'text' ? fmtBytes(item.bytes) + ' · 文本' : fmtBytes(item.bytes));
  meta.appendChild(el('div', 'attach-sub', sub));
  node.appendChild(meta);
  const rm = el('button', 'attach-remove', '×') as HTMLButtonElement;
  rm.type = 'button';
  // W867 的 aria-label（指名到具体文件） + W869 的分类文案，两边都保留。
  rm.title = item.kind === 'text' ? '移除这个文本文件' : '移除这张图片';
  rm.setAttribute('aria-label', rm.title + '：' + item.name);
  rm.addEventListener('click', () => onRemove(item));
  node.appendChild(rm);
  return node;
}

function attachmentItem(v: AttachmentView): HTMLElement {
  const isText = v.kind === 'text';
  const label = v.name ?? (isText ? '文本文件' : '图片');
  const node = el('div', 'attach-item');
  // W869：文本项没有图可放，用与历史占位同形的方块（'文'）—— 不动几何、不动 CSS。
  node.appendChild(thumb(isText ? '' : (v.url ?? ''), label, label, isText ? '文' : '图'));
  const meta = el('div', 'attach-meta');
  meta.appendChild(el('div', 'attach-name', label));
  meta.appendChild(el('div', 'attach-sub', isText ? fmtBytes(v.bytes ?? 0) + ' · 文本' : subLabel(v)));
  node.appendChild(meta);
  return node;
}

/** 通用兜底图标：取文件名首字（非图片 / 无预览地址的条目共用，绝不写死「一定是图片」）。 */
function genericMark(name: string): string {
  const base = name.trim().replace(/^.*[\\/]/, '');
  const ch = Array.from(base)[0];
  return ch === undefined || ch === '' ? '附' : ch.toUpperCase();
}

/** 只看扩展名，不碰 attachments.ts 的 MEDIA_TYPES / accept 判定（那是 W869 的领地）。 */
function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
}

/** glyph：显式指定占位字形（W869 的文本项传 '文'）；缺省时按扩展名判图片。 */
function thumb(url: string, alt: string, title: string, glyph?: string): HTMLElement {
  if (url !== '') {
    const img = el('img', 'attach-thumb') as HTMLImageElement;
    img.src = url;
    img.alt = alt;
    img.title = title;
    img.addEventListener('click', () => openLightbox(url, alt));
    return img;
  }
  // 无预览地址：图片显示「图」占位（P0 无字节回读端点，设计 §7.4）；
  // 非图片显示文件名首字 —— 两条路径都**不假装有图**。
  const ph = el('div', 'attach-thumb attach-thumb-meta');
  // W869：显式 glyph 优先（文本项 '文'）；否则按扩展名 —— 非图片显示文件名首字。
  ph.textContent = glyph ?? (looksLikeImage(title) ? '图' : genericMark(title));
  ph.title = title;
  return ph;
}

function subLabel(v: AttachmentView): string {
  if (v.ref) return v.ref.width + '×' + v.ref.height + ' · ' + v.ref.media_type;
  if (v.bytes !== undefined) return fmtBytes(v.bytes);
  return '图片';
}

function openLightbox(url: string, name: string): void {
  const box = el('div', 'attach-lightbox');
  const img = el('img', 'attach-lightbox-img') as HTMLImageElement;
  img.src = url;
  img.alt = name;
  box.appendChild(img);
  let handle: OverlayHandle | null = null;
  const close = (): void => {
    box.remove();
    if (handle) popOverlay(handle);
  };
  handle = pushOverlay(close); // utils/overlays：Esc 只关栈顶这一层
  box.addEventListener('click', close);
  document.body.appendChild(box);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 媒体类型 → 短标签（历史元数据占位用）；未知时回落 MIME 子类型。 */
export function mediaLabel(media: ImageMediaType): string {
  return media === 'image/jpeg' ? 'JPEG' : media.replace('image/', '').toUpperCase();
}
