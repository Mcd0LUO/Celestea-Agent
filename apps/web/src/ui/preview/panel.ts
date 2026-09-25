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
//
// W1534（HTML 预览）：kind === 'html' 时给**两种查看方式**（预览 / 源码），
//   控件常驻在 .preview-head（见 modes.ts 的两条硬约束）。
//
//   ★ 为什么两个视图节点**同时建、同时进 DOM**，而不是切换时重建：
//     · 重建 = 每次切换都要重新加载 + 重新高亮 + 重新加载 iframe（闪一下白）；
//       本仓铁律 1 就是「禁止先清空后加载」。
//     · 同时存在 ⇒ 两个视图各自的滚动位置天然保留（非当前视图用 visibility:hidden
//       而非 display:none，理由见 preview.css 的双视图注释 —— W1543 更正了 W1534
//       在此处的过度声称：display:none 并不丢 iframe 内位置，只是隐藏期间读出来是 0）。
//       panel.ts 另有 scroll[] 显式保存/恢复兜底（见 switchView），不单靠浏览器行为。
//     · 代价：源码模式下 iframe 仍然挂着（它的文档已加载完，且 CSP 已关掉全部
//       外部请求面，不再有网络活动）。可接受。
//
//   ★ 滚动位置的取舍（用户要求「切回源码时不丢滚动位置（或明确记录取舍）」）：
//     · **源码**：滚动发生在 .preview-body 上（父文档），可读可写 ⇒ **明确保留**。
//     · **预览**：滚动发生在 iframe **内部**，而 iframe 在不透明源里
//       （contentDocument === null，见 sandbox.ts）⇒ 父页面**读不到也写不了**它的
//       scrollTop。这是隔离生效的必然代价，**明确记录为取舍**，不假装保留。
//       缓解：iframe 节点不重建、也不 display:none（用 visibility 隐藏），
//       ⇒ 浏览器自身的滚动状态得以保留。实测见报告「滚动位置」一节。
// ============================================================================
import { el } from '../../utils/dom';
import { openFsBrowser, type FsBrowserUi } from '../fsbrowser';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { runEnhancers } from '../enhance';
import { renderPreview } from './renderers';
import { streamInto, type StreamFill } from './stream';
import { createModeSwitch, type ModeSwitch, type PreviewView } from './modes';
import type { PreviewCandidate } from './detect';
import { t } from '../../i18n';

/** 富加载结果：拿到文本（+ 是否截断），或一个**可读的**降级原因。 */
export type PreviewLoad = { text: string; truncated?: boolean } | { degraded: string; badge?: string };

/**
 * W1545：**分段装载**的一步（巨文件流式打开）。
 *
 * 服务端 `GET /api/fs/read` 是「按行窗口」的（offset/limit，见
 * apps/studio/src/handlers/fs-read.ts）—— 一次只给一段，`truncated` 说还有更多。
 * 这个形状把「取下一段」交给调用方（workbench/files-open.ts）：
 *   · 壳与**首段**由 panel 当帧画出（面板不等整篇读完就出现）；
 *   · 后续每段**追加**一个 <pre><code> 块，绝不整块重建（铁律 1/2）。
 */
export interface PreviewRequest {
  candidate: PreviewCandidate;
  /** 内容加载（P0：从会话 DOM 取文本；返回 null = 走降级）。 */
  load?: () => Promise<string | null>;
  /** F2 P1：工作区文件用——服务端读取，binary/超大/读取失败给可读降级。 */
  loadFull?: () => Promise<PreviewLoad>;
  /**
   * W1545：**分段装载**（巨文件流式打开）。给了它就优先走流式路径；
   * 与 loadFull 二选一（html 例外，理由见 resolveBody 注释）。
   */
  stream?: () => Promise<StreamFill>;
  /** 图片预览地址（objectURL / attachment URL）。 */
  url?: string | null;
}

let host: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let pathEl: HTMLElement | null = null;
/** 「已截断」标记（服务端说 truncated 时才显示）。 */
let noteEl: HTMLElement | null = null;
/** W1545：流式装载的进度行（住在动作行里，与「已截断」标记分开：一个说「还在读」，一个说「读不到了」）。 */
let streamNoteEl: HTMLElement | null = null;
let modes: ModeSwitch | null = null;
let overlay: OverlayHandle | null = null;
let seq = 0;
let currentPath = '';
/** 当前文件的已加载内容（切视图不重新加载）。 */
let currentLoad: PreviewLoad | string | null = null;

/** 当前查看方式（只在 kind === 'html' 且内容可渲染时有意义）。 */
let view: PreviewView = 'preview';
/** 两个视图各自的滚动位置（按视图分开记：切换时各回各家）。 */
let scroll: Record<PreviewView, number> = { preview: 0, source: 0 };
/** 当前 body 里是否真的有「双视图」（html 且可渲染）。 */
let dualView = false;

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

/**
 * 某个视图的滚动容器。
 *
 * 双视图下是视图节点自己（`.preview-view`，overflow:auto），单视图下是 body。
 * ★ **预览视图的内部滚动不在这里**：它发生在 iframe 的文档里，而 iframe 在不透明源
 *   （contentDocument === null）⇒ 父页面读不到它的 scrollTop。那部分靠「非当前视图
 *   用 visibility:hidden 而不是 display:none」保住（★ W1543 更正：早先写的
 *   「display:none 会把 iframe 内滚动位归零」**不成立** —— 实测恢复后位置还在，
 *   只是隐藏期间读出来是 0；选 visibility 的真实理由是留在布局里 + scrollTop 始终可读）。
 *   见 preview.css 的双视图注释。
 */
function scrollHost(v: PreviewView): HTMLElement | null {
  return dualView ? viewEls[v] : bodyEl;
}

/** 切换查看方式：先存旧视图滚动位，重画后还原新视图滚动位。 */
function switchView(next: PreviewView): void {
  if (next === view) return;
  if (dualView) scroll[view] = scrollHost(view)?.scrollTop ?? 0;
  view = next;
  modes?.setView(next);
  // ★ 只切 class，**不重画**：两个视图节点都已在 DOM 里（paint 时同时建好）。
  //   重画 = replaceChildren ⇒ 新 iframe 节点 ⇒ 文档被重新加载（闪白 + 丢滚动位）。
  //   这条由 tests/w1534-html-panel.test.ts 的「iframe 节点身份不变」守着
  //   （该断言真的抓到过本函数的重画版本）。
  applyView();
}

/** 造头部控件：标题 / 路径 / 已截断标记 / 查看方式 / 关闭。 */
function buildHead(panel: HTMLElement): void {
  const head = el('div', 'preview-head');
  titleEl = el('span', 'preview-title');
  pathEl = el('span', 'preview-path');
  head.appendChild(titleEl);
  head.appendChild(pathEl);
  noteEl = el('span', 'preview-note hidden');
  head.appendChild(noteEl);
  modes = createModeSwitch(switchView);
  head.appendChild(modes.node);
  const close = el('button', 'preview-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = t('chat.preview.close');
  close.setAttribute('aria-label', t('chat.preview.close'));
  close.addEventListener('click', closePreview);
  head.appendChild(close);
  panel.appendChild(head);
}

/** 造动作行：复制路径 / 在文件管理器中打开。 */
function buildActions(panel: HTMLElement): void {
  const actions = el('div', 'preview-actions');
  const copy = el('button', 'preview-action', t('chat.preview.copyPath')) as HTMLButtonElement;
  copy.type = 'button';
  copy.addEventListener('click', () => copyPath(currentPath));
  actions.appendChild(copy);
  const open = el('button', 'preview-action', t('chat.preview.openInManager')) as HTMLButtonElement;
  open.type = 'button';
  open.addEventListener('click', () => openManager(currentPath));
  actions.appendChild(open);
  // W1545：流式进度（「已读 N/M 行」）。住在动作行里、**不在 body 里** ——
  // body 的顶层子节点是双视图标记（markDual 按 '> .preview-view' 匹配），
  // 往里插状态行会让 html 预览的视图标记错位。这里只改它的文本，不重建节点。
  streamNoteEl = el('span', 'preview-stream-note hidden');
  actions.appendChild(streamNoteEl);
  panel.appendChild(actions);
}

/** 只建一次：头（标题/路径/查看方式/关闭）+ 空 body + 动作行。 */
function buildPanel(): void {
  const h = el('div', 'preview-host hidden');
  const panel = el('div', 'preview-panel');
  buildHead(panel);
  bodyEl = el('div', 'preview-body rendered');
  panel.appendChild(bodyEl);
  buildActions(panel);
  h.appendChild(panel);
  document.body.appendChild(h);
  host = h;
}

function ensurePanel(): void {
  if (!host || !host.isConnected || !bodyEl) buildPanel();
}

/** 读服务端/会话内容；字符串 = 会话文本，null = 无内容（走降级）。 */
async function loadText(req: PreviewRequest): Promise<PreviewLoad | string | null> {
  if (req.url) return null;
  if (req.loadFull) {
    try {
      return await req.loadFull();
    } catch {
      return { degraded: t('chat.preview.degradeReadFailed') };
    }
  }
  if (req.load) {
    try {
      return await req.load();
    } catch {
      return null;
    }
  }
  return null;
}

/** 把已加载结果拆成 renderPreview 的入参。 */
function unpack(raw: PreviewLoad | string | null): { text: string | null; degraded?: string; badge?: string; truncated: boolean } {
  if (typeof raw === 'string') return { text: raw, truncated: false };
  if (raw === null) return { text: null, truncated: false };
  if ('degraded' in raw) return { text: null, degraded: raw.degraded, badge: raw.badge, truncated: false };
  return { text: raw.text, truncated: raw.truncated === true };
}

/** 一个视图的滚动容器（双视图下是视图节点自己；单视图下是 body）。 */
let viewEls: Record<PreviewView, HTMLElement | null> = { preview: null, source: null };

/** 这个顶层节点是哪个视图（增强遍可能已经把 pre 包进 .code-wrap，故按**后代**判）。 */
function viewKindOf(n: HTMLElement): PreviewView | null {
  if (n.classList.contains('preview-html') || n.querySelector('.preview-html-frame') !== null) return 'preview';
  if (n.classList.contains('preview-code') || n.querySelector('.preview-code') !== null) return 'source';
  return null;
}

/**
 * 双视图：给 body 的**顶层**子节点打 view-on / view-off（+ preview-view）。
 *
 * 必须在 runEnhancers **之后**调用：code-copy / code-extras 会把 `pre.preview-code`
 * 包进 `.code-wrap`，此时 body 的顶层子节点已经不是那个 pre 了 —— 在增强前打的标记
 * 会留在被包住的内层节点上，而 CSS 的 `> .preview-view` 匹配的是**顶层**，标记就失效。
 * （这正是本仓 W895-P2 踩过的「作用域 vs 目标自身」同一类坑。）
 */
function markDual(body: HTMLElement): void {
  viewEls = { preview: null, source: null };
  if (!dualView) return;
  for (const child of Array.from(body.children)) {
    const n = child as HTMLElement;
    const kind = viewKindOf(n);
    if (kind === null) continue;
    viewEls[kind] = n;
    n.classList.add('preview-view');
  }
  applyView();
}

/**
 * 把当前 view 落到**已存在**的视图节点上（只切 class + 还原滚动位，不碰 DOM 结构）。
 *
 * 单独抽出来是因为它有两个调用点：paint（新内容画完）与 switchView（用户点切换）。
 * 后者**必须**走这条轻路径 —— 重画会换掉 iframe 节点，等于重新加载预览文档。
 */
function applyView(): void {
  if (!dualView) return;
  for (const kind of ['preview', 'source'] as const) {
    const n = viewEls[kind];
    if (n === null) continue;
    n.classList.toggle('view-on', kind === view);
    n.classList.toggle('view-off', kind !== view);
  }
  const host = scrollHost(view);
  if (host !== null) host.scrollTop = scroll[view];
}

/**
 * 画内容（**单次 replaceChildren**，铁律 1）。
 *
 * dual = true 时两个视图**同时**建出来（见文件头注），CSS 只显示当前那个。
 */
function paint(req: PreviewRequest, body: HTMLElement): void {
  const raw = unpack(currentLoad);
  const base = { path: req.candidate.path, kind: req.candidate.kind, text: raw.text, url: req.url ?? null, degraded: raw.degraded, badge: raw.badge };
  const shown = renderPreview({ ...base, view });
  dualView = req.candidate.kind === 'html' && shown.degraded === null && raw.text !== null;
  const nodes: HTMLElement[] = [shown.node];
  if (dualView) nodes.push(renderPreview({ ...base, view: view === 'preview' ? 'source' : 'preview' }).node);
  body.classList.toggle('is-dual', dualView);
  body.replaceChildren(...nodes);
  // 预览也走**同一条增强缝**（此前只有 code 分支自己调 hljs，于是 markdown 文件里的
  // 围栏代码块、以及数学占位都永远不处理 —— 文件管理器里打开 .md 看不到高亮）。
  //
  // ★ 传 `body` 而不是 `content.node`：增强遍把参数当**作用域**用
  //   （container.querySelectorAll 只匹配后代、匹配不到容器自身）。
  //   代码文件预览时 content.node **就是** pre，于是 code-copy / code-extras 的
  //   querySelectorAll('pre') 永远返回空 —— 实测「高亮有了、复制按钮/行号/徽标没有」。
  runEnhancers(body);
  markDual(body); // ★ 必须在增强之后（见 markDual 注释）；内部会 applyView 还原滚动位
  body.classList.toggle('is-degraded', shown.degraded !== null);
  modes?.setVisible(dualView);
  if (!dualView) {
    const host = scrollHost(view);
    if (host !== null) host.scrollTop = scroll[view];
  }
  if (noteEl) {
    noteEl.textContent = raw.truncated ? t('chat.preview.truncated') : '';
    noteEl.classList.toggle('hidden', !raw.truncated);
  }
}

/** W1545 流式进度 / 上限提示（只改文本，不重建节点）。 */
function setStreamNote(text: string): void {
  if (streamNoteEl === null) return;
  streamNoteEl.textContent = text;
  streamNoteEl.classList.toggle('hidden', text === '');
}

/** 加载内容 → 画（带竞态守卫）。 */
async function resolveBody(req: PreviewRequest, my: number, body: HTMLElement): Promise<void> {
  // W1545: a segment provider wins for every kind except html. HTML is the one
  // kind whose renderer needs the WHOLE text up front (iframe srcdoc = the file
  // byte-for-byte; the source view is the same document), so it stays on the
  // one-shot path (a second 'read to EOF' request) even when a provider is given.
  if (req.stream !== undefined && req.candidate.kind !== 'html') {
    await streamInto(
      {
        body,
        path: req.candidate.path,
        kind: req.candidate.kind,
        isCurrent: () => my === seq,
        note: setStreamNote,
      },
      req.stream,
    );
    return;
  }
  const result = await loadText(req);
  if (my !== seq) return; // 竞态：晚到的加载结果丢弃，绝不覆盖当前文件
  currentLoad = result;
  paint(req, body);
}

/** 打开（或切换到）右侧覆盖式预览面板：头当帧更新，内容就绪时单次替换。 */
export function openPreview(req: PreviewRequest): void {
  const my = ++seq;
  ensurePanel();
  if (!host || !bodyEl || !titleEl || !pathEl) return;
  currentPath = req.candidate.path;
  currentLoad = null;
  // 新文件：回到默认查看方式（HTML 默认**预览**，理由见 renderers.ts 的分派注释），
  // 两个视图的滚动位一并归零 —— 否则会把上一个文件的滚动位置带过来。
  view = 'preview';
  scroll = { preview: 0, source: 0 };
  modes?.setView(view);
  modes?.setVisible(false); // 内容就绪前不显示（降级态没有两种看法）
  titleEl.textContent = basename(req.candidate.path);
  pathEl.textContent = req.candidate.path;
  pathEl.title = req.candidate.path;
  host.classList.remove('hidden');
  if (noteEl) {
    noteEl.textContent = '';
    noteEl.classList.add('hidden');
  }
  if (overlay === null) overlay = pushOverlay(closePreview);
  // W1545: the SHELL is painted this very frame (head + path + skeleton + actions),
  // BEFORE any read is awaited -- the panel used to wait for the whole first read
  // before painting anything, which is what made a big file's panel feel late. The
  // skeleton is swapped out only when the first real segment lands (rule 1).
  bodyEl.classList.remove('is-dual', 'is-degraded');
  bodyEl.classList.add('is-loading');
  const skeleton = el('div', 'preview-skeleton');
  for (let i = 0; i < 3; i += 1) skeleton.appendChild(el('div', 'preview-skeleton-line'));
  bodyEl.replaceChildren(skeleton);
  setStreamNote('');
  void resolveBody(req, my, bodyEl);
}

/** 关闭面板（Esc 由 overlays 层级栈调用本函数）。 */
export function closePreview(): void {
  seq += 1; // 使在飞的加载失效
  if (host) {
    host.classList.add('hidden');
    if (bodyEl) bodyEl.replaceChildren();
  }
  currentLoad = null;
  dualView = false;
  modes?.setVisible(false);
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

/** 是否打开（诊断/测试）。 */
export function previewIsOpen(): boolean {
  return host !== null && !host.classList.contains('hidden');
}

/** 当前查看方式（诊断/测试）。 */
export function previewView(): PreviewView {
  return view;
}
