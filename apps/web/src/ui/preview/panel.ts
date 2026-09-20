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
import { runEnhancers } from '../enhance';
import { renderPreview } from './renderers';
import type { PreviewCandidate } from './detect';
import { t } from '../../i18n';

/** 富加载结果：拿到文本（+ 是否截断），或一个**可读的**降级原因。 */
export type PreviewLoad = { text: string; truncated?: boolean } | { degraded: string; badge?: string };

export interface PreviewRequest {
  candidate: PreviewCandidate;
  /** 内容加载（P0：从会话 DOM 取文本；返回 null = 走降级）。 */
  load?: () => Promise<string | null>;
  /** F2 P1：工作区文件用——服务端读取，binary/超大/读取失败给可读降级。 */
  loadFull?: () => Promise<PreviewLoad>;
  /** 图片预览地址（objectURL / attachment URL）。 */
  url?: string | null;
}

let host: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
/** 「已截断」标记（服务端说 truncated 时才显示）。 */
let noteEl: HTMLElement | null = null;
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
    title: t('chat.preview.manager'),
    note: t('chat.preview.target', { path }),
    confirmLabel: t('chat.preview.chooseDir'),
    busyLabel: t('chat.preview.busy'),
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
  noteEl = el('span', 'preview-note hidden');
  head.appendChild(noteEl);
  const close = el('button', 'preview-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = t('chat.preview.close');
  close.setAttribute('aria-label', t('chat.preview.close'));
  close.addEventListener('click', closePreview);
  head.appendChild(close);
  panel.appendChild(head);
  bodyEl = el('div', 'preview-body rendered');
  panel.appendChild(bodyEl);
  const actions = el('div', 'preview-actions');
  const copy = el('button', 'preview-action', t('chat.preview.copyPath')) as HTMLButtonElement;
  copy.type = 'button';
  copy.addEventListener('click', () => copyPath(currentPath));
  actions.appendChild(copy);
  const open = el('button', 'preview-action', t('chat.preview.openInManager')) as HTMLButtonElement;
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
  let degraded: string | undefined;
  let badge: string | undefined;
  let truncated = false;
  if (!req.url && req.loadFull) {
    try {
      const r = await req.loadFull();
      if ('degraded' in r) {
        degraded = r.degraded;
        badge = r.badge;
      } else {
        text = r.text;
        truncated = r.truncated === true;
      }
    } catch {
      degraded = t('chat.preview.degradeReadFailed');
    }
  } else if (!req.url && req.load) {
    try {
      text = await req.load();
    } catch {
      text = null;
    }
  }
  if (my !== seq) return; // 竞态：晚到的加载结果丢弃，绝不覆盖当前文件
  const content = renderPreview({ path: req.candidate.path, kind: req.candidate.kind, text, url: req.url ?? null, degraded, badge });
  if (my !== seq) return;
  body.replaceChildren(content.node);
  // 预览也走**同一条增强缝**（此前只有 code 分支自己调 hljs，于是 markdown 文件里的
  // 围栏代码块、以及数学占位都永远不处理 —— 文件管理器里打开 .md 看不到高亮）。
  //
  // ★ 传 `body` 而不是 `content.node`：增强遍把参数当**作用域**用
  //   （`container.querySelectorAll(...)` 只匹配后代、匹配不到容器自身）。
  //   代码文件预览时 `content.node` **就是** `<pre>`，于是 code-copy / code-extras 的
  //   `querySelectorAll('pre')` 永远返回空 —— 实测「高亮有了、复制按钮/行号/徽标没有」。
  //   `highlightCode` 用的是 `pre code`，后代 `code` 能匹配，所以只有它看起来正常。
  runEnhancers(body);
  body.classList.toggle('is-degraded', content.degraded !== null);
  if (noteEl) {
    noteEl.textContent = truncated ? t('chat.preview.truncated') : '';
    noteEl.classList.toggle('hidden', !truncated);
  }
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
  if (noteEl) {
    noteEl.textContent = '';
    noteEl.classList.add('hidden');
  }
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
