// ============================================================================
// ui/attachment-view.ts — W805 附件渲染（气泡网格 / 待发缩略图条 / 放大浮层）。
//   为守模块体积棘轮从 ui/attachments.ts 拆出；本层不做网络请求、不改状态。
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
}

export function renderAttachmentGrid(views: readonly AttachmentView[]): HTMLElement {
  const grid = el('div', 'attach-grid');
  for (const v of views) grid.appendChild(attachmentItem(v));
  return grid;
}

/** 待发缩略图条：每项可单个移除；被拒项标红并写明原因。 */
export function renderTray(
  container: HTMLElement,
  items: readonly PendingAttachment[],
  onRemove: (p: PendingAttachment) => void,
): void {
  if (items.length === 0) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }
  container.classList.remove('hidden');
  container.replaceChildren(...items.map((it) => pendingItem(it, onRemove)));
}

function pendingItem(item: PendingAttachment, onRemove: (p: PendingAttachment) => void): HTMLElement {
  const node = el('div', 'attach-item' + (item.error !== '' ? ' err' : ''));
  node.appendChild(thumb(item.url, item.name, item.name));
  const meta = el('div', 'attach-meta');
  meta.appendChild(el('div', 'attach-name', item.name));
  meta.appendChild(el('div', 'attach-sub', item.error !== '' ? item.error : fmtBytes(item.bytes)));
  node.appendChild(meta);
  const rm = el('button', 'attach-remove', '×') as HTMLButtonElement;
  rm.type = 'button';
  rm.title = '移除这张图片';
  rm.addEventListener('click', () => onRemove(item));
  node.appendChild(rm);
  return node;
}

function attachmentItem(v: AttachmentView): HTMLElement {
  const node = el('div', 'attach-item');
  node.appendChild(thumb(v.url ?? '', v.name ?? '图片', v.name ?? '图片'));
  const meta = el('div', 'attach-meta');
  meta.appendChild(el('div', 'attach-name', v.name ?? '图片'));
  meta.appendChild(el('div', 'attach-sub', subLabel(v)));
  node.appendChild(meta);
  return node;
}

function thumb(url: string, alt: string, title: string): HTMLElement {
  if (url !== '') {
    const img = el('img', 'attach-thumb') as HTMLImageElement;
    img.src = url;
    img.alt = alt;
    img.title = title;
    img.addEventListener('click', () => openLightbox(url, alt));
    return img;
  }
  // P0 无字节回读端点：历史回放只显示元数据占位，不假装有图（设计 §7.4）。
  const ph = el('div', 'attach-thumb attach-thumb-meta');
  ph.textContent = '图';
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
  handle = pushOverlay(close);
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
