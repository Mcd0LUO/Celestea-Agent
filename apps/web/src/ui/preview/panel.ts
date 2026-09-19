// ============================================================================
// ui/preview/panel.ts — F2 文件侧边预览：右侧**覆盖式浮层**（不动 #layout）。
// ----------------------------------------------------------------------------
// 铁律：面板只建一次（ensurePanel），切换文件只改标题/路径并**在内容就绪时单次
//       replaceChildren**（旧内容保持可见到新内容就绪，不先清空后加载）；
//       竞态守卫 seq：打开新文件即 ++seq，晚到的旧加载结果一律丢弃（写入的是同一个
//       body，所以守卫是真正吃劲的那道闸）；
//       弹层开关不触发背景（#messages / #main）重渲染；
//       Esc 走 utils/overlays 层级栈（只关栈顶一层）。
// 降级：二进制 / 超大 / 类型不明 / 内容不在会话里 → 可读原因 + 「复制路径」+
//       「在文件管理器中打开」（openFsBrowser），绝不留白屏。
// ============================================================================
import { el } from '../../utils/dom';
import { openFsBrowser, type FsBrowserUi } from '../fsbrowser';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { renderPreview } from './renderers';
import type { PreviewCandidate } from './detect';

export interface PreviewRequest {
  candidate: PreviewCandidate;
  /** 内容加载（P0：从会话 DOM 取文本；返回 null = 走降级）。 */
  load?: () => Promise<string | null>;
  /** 图片预览地址（objectURL / attachment URL）。 */
  url?: string | null;
}

let host: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
let overlay: OverlayHandle | null = null;
let seq = 0;
let currentPath = '';

function basename(path: string): string {
  return path.replace(/^.*[\\/]/, '') || path;
}

function copyPath(path: string): void {
  const cb = navigator.clipboard;
  if (cb && typeof cb.writeText === 'function') void cb.writeText(path).catch(() => {});
}

function openManager(path: string): void {
  openFsBrowser({
    title: '文件管理器',
    note: '目标文件：' + path,
    confirmLabel: '选择此目录',
    busyLabel: '处理中…',
    onPick: (_p: string, ui: FsBrowserUi) => ui.close(),
  });
}

/** 只建一次：头（标题/路径/关闭）+ 空 body + 动作行（复制路径 / 在文件管理器中打开）。 */
function buildPanel(): void {
  const h = el('div', 'preview-host hidden');
  const panel = el('div', 'preview-panel');
  const head = el('div', 'preview-head');
  titleEl = el('span', 'preview-title');
  pathEl = el('span', 'preview-path');
  head.appendChild(titleEl);
  head.appendChild(pathEl);
  const close = el('button', 'preview-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = '关闭预览';
  close.setAttribute('aria-label', '关闭预览');
  close.addEventListener('click', closePreview);
  head.appendChild(close);
  panel.appendChild(head);
  bodyEl = el('div', 'preview-body');
  panel.appendChild(bodyEl);
  const actions = el('div', 'preview-actions');
  const copy = el('button', 'preview-action', '复制路径') as HTMLButtonElement;
  copy.type = 'button';
  copy.addEventListener('click', () => copyPath(currentPath));
  actions.appendChild(copy);
  const open = el('button', 'preview-action', '在文件管理器中打开') as HTMLButtonElement;
  open.type = 'button';
  open.addEventListener('click', () => openManager(currentPath));
  actions.appendChild(open);
  panel.appendChild(actions);
  h.appendChild(panel);
  document.body.appendChild(h);
  host = h;
}

function ensurePanel(): void {
  if (!host || !host.isConnected || !bodyEl) buildPanel();
}

async function resolveBody(req: PreviewRequest, my: number, body: HTMLElement): Promise<void> {
  let text: string | null = null;
  if (!req.url && req.load) {
    try {
      text = await req.load();
    } catch {
      text = null;
    }
  }
  if (my !== seq) return; // 竞态：晚到的加载结果丢弃，绝不覆盖当前文件
  const content = renderPreview({ path: req.candidate.path, kind: req.candidate.kind, text, url: req.url ?? null });
  if (my !== seq) return;
  body.replaceChildren(content.node);
  body.classList.toggle('is-degraded', content.degraded !== null);
}

/** 打开（或切换到）右侧覆盖式预览面板：头当帧更新，内容就绪时单次替换。 */
export function openPreview(req: PreviewRequest): void {
  const my = ++seq;
  ensurePanel();
  if (!host || !bodyEl || !titleEl || !pathEl) return;
  currentPath = req.candidate.path;
  titleEl.textContent = basename(req.candidate.path);
  pathEl.textContent = req.candidate.path;
  pathEl.title = req.candidate.path;
  host.classList.remove('hidden');
  if (overlay === null) overlay = pushOverlay(closePreview);
  void resolveBody(req, my, bodyEl);
}

/** 关闭面板（Esc 由 overlays 层级栈调用本函数）。 */
export function closePreview(): void {
  seq += 1; // 使在飞的加载失效
  if (host) {
    host.classList.add('hidden');
    if (bodyEl) bodyEl.replaceChildren();
  }
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

/** 是否打开（诊断/测试）。 */
export function previewIsOpen(): boolean {
  return host !== null && !host.classList.contains('hidden');
}
