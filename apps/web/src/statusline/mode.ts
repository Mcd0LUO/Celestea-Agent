// ============================================================================
// statusline/mode.ts — W788：会话工作方式的**徽标 + 切换弹层**。
//
//   权威依据：docs/modes-standard-vs-execution.md §3.2（statusline：会话标识格旁
//   加只读徽标「标准」/「执行」，点击弹层可切换）、§3.1（P1 切换端点契约）、
//   §6.5（能力位缺失 → 入口降级而不是报错）。
//
//   为什么单独一个模块：statusline.ts 只保留编排（轮询/快照合并/渲染编排），
//   与 W758 拆出 picker/ring/fields 同一纪律。本模块自带弹层生命周期
//   （module 级 popup 句柄，挂在 #statusline 上、向上弹出、Esc 只关栈顶一层），
//   与「模型 / 推理档位」那套同款交互与错误处理，但**不共用** picker 的
//   配置语义（那是 POST /api/config 的进程级热调面，mode 是会话级元数据）。
//
//   数据流向：mode 随既有**按会话**快照缓存一起走（Statusline.cache），
//   不从本模块另开一份缓存 —— 避免两会话徽标串台（设计 U7）。
// ============================================================================
import { api, ApiError, userErrorText } from '../api';
import type { SessionMode } from '../types';
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import { modeChoices, modeNotes, modeLabel } from '../ui/mode/copy';
import { t } from '../i18n'; // i18n P1-a

/** 能力位探测结果缓存时长（与 ui/contextview.ts 的能力位探测同款纪律）。 */
const CAP_TTL_MS = 60000;

let capState: 'unknown' | 'on' | 'off' = 'unknown';
let capAt = 0;

/**
 * 能力位探测：`capabilities.session_mode_tools === true` 才算可切换。
 * 字段缺失 / 能力位对象缺失（老服务）/ 请求失败 / 弹层在探测期间被关掉
 * 一律按不可用处理 —— 不报错、不崩溃（任务书 §4）。结果在 CAP_TTL_MS 内复用。
 */
export async function modeSwitchSupported(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && capState !== 'unknown' && now - capAt < CAP_TTL_MS) return capState === 'on';
  capAt = now;
  try {
    const h = await api.health();
    capState = h.capabilities?.session_mode_tools === true ? 'on' : 'off';
  } catch {
    capState = 'off';
  }
  return capState === 'on';
}

/**
 * W1513：工作方式徽标的**两枚风格化图标**（内联 SVG 常量，无用户输入参与拼接，
 * innerHTML 在这里没有注入面 —— 与 W765 的 THINK_CHEVRON_SVG 同一纪律）。
 *
 *   标准（standard）  = 逐步执行：点 + 线的清单，读作「一步一步调用工具」
 *   执行（execution） = 程序化批量：终端提示符 >_，读作「折叠进 run_code 程序」
 *
 * 尺寸/线宽对齐既有图标族（16 视图 + stroke 1.4 + 圆头 + currentColor），
 * 因此颜色跟随 .sl-mode 的 color，两态只换图标、不换几何。
 */
const MODE_ICON_STANDARD =
  '<svg class="sl-mode-ico sl-mode-ico-standard" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<path d="M2.4 4.2h.01M5.4 4.2h8.2M2.4 8h.01M5.4 8h8.2M2.4 11.8h.01M5.4 11.8h8.2" ' +
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>';
const MODE_ICON_EXECUTION =
  '<svg class="sl-mode-ico sl-mode-ico-exec" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
  '<path d="M3 4.6 6.4 8 3 11.4M8.6 11.6h4.4" ' +
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

/**
 * 徽标渲染（只改 class / 文本 / 标题，不重建 DOM：铁律 1/2/5）。
 *
 * W1513：可见内容从「文字 + 圆形胶囊」改为**图标**（用户要求）。图标骨架只在第一次
 * 渲染时建一次（此后每帧只切 class），语义文本移到 .sr-only —— 它不占位、仍在可访问
 * 性树里，因此 textContent 与无障碍名都保留（既有断言与读屏器都不受影响）。
 */
export function renderModeBadge(node: HTMLElement, mode: unknown): void {
  const text = modeLabel(mode);
  const label = node.querySelector<HTMLElement>('.sl-mode-sr');
  if (label === null) {
    // 首次渲染：图标 + 视觉隐藏的语义文本（只建一次，之后不再动结构）。
    node.innerHTML = MODE_ICON_STANDARD + MODE_ICON_EXECUTION + '<span class="sl-mode-sr sr-only"></span>';
  }
  const sr = node.querySelector<HTMLElement>('.sl-mode-sr');
  if (sr !== null) sr.textContent = text;
  node.classList.toggle('hidden', text === '');
  node.classList.toggle('exec', mode === 'execution');
  node.title = text === '' ? '' : t('statusline.mode.badgeTitle', { mode: text });
  // 无障碍名跟着两态走（图标本身 aria-hidden，语义只在 title + sr-only 上）。
  if (text === '') node.removeAttribute('aria-label');
  else node.setAttribute('aria-label', text);
}

// ---- 切换请求（三态分类） ------------------------------------------------------

/**
 * 切换结果：`ok` 成功；`busy` = 轮次进行中（409，冻结文案）；`unsupported` =
 * 该部署无此端点（404/405，老服务）；`invalid` = 取值被拒（400/422）；
 * `error` = 其它失败（文案来自 api 层的统一措辞，不透传服务端原文）。
 */
export type ModeSwitchOutcome =
  | { kind: 'ok'; mode: SessionMode }
  | { kind: 'busy' }
  | { kind: 'unsupported' }
  | { kind: 'invalid' }
  | { kind: 'error'; text: string };

/**
 * `POST /api/sessions/{id}/mode`。会话 id 未解析（旧单会话容器）→ 不发无主请求。
 * 只有 200 且服务**回声**了目标模式才算成功：ok:false 的 200 也算失败
 * （不假装成功）。
 */
export async function requestModeSwitch(
  session: string,
  mode: SessionMode,
): Promise<ModeSwitchOutcome> {
  if (session === '') return { kind: 'error', text: t('statusline.sessionNotReady') };
  try {
    const r = await api.setSessionMode(session, mode);
    if (r.ok === false || r.mode !== mode) return { kind: 'error', text: t('statusline.switchFailedRetry') };
    return { kind: 'ok', mode };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) return { kind: 'busy' };
      if (err.status === 404 || err.status === 405) return { kind: 'unsupported' };
      if (err.status === 400 || err.status === 422) return { kind: 'invalid' };
    }
    return { kind: 'error', text: t('statusline.switchFailed', { reason: userErrorText(err, t('statusline.retryLater')) }) };
  }
}

// ---- 弹层（与 picker 同款形态：向上弹出 + Esc 层级栈 + 离屏构建单次替换） --------

/** 弹层宿主（Statusline 实现）：根元素、当前会话、快照里的 mode 与两个回调。 */
export interface ModeHost {
  /** 弹层挂载点（#statusline 元素）。 */
  readonly root: HTMLElement;
  /** 当前聚焦会话 id（'' = 未解析）。 */
  readonly sessionId: string;
  /** 快照里的工作方式（'' = 未知）。 */
  readonly currentMode: string;
  /** 切换成功后把 mode 写回快照（statusline 负责再渲染徽标）。 */
  applyMode(mode: SessionMode): void;
  setNote(text: string, ms: number): void;
}

let popup: HTMLElement | null = null;
let overlay: OverlayHandle | null = null;
let host: ModeHost | null = null;

export function closeModePopup(): void {
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
  if (popup !== null) {
    popup.remove();
    popup = null;
  }
  host = null;
}

/**
 * 点击外部/别的弹层时的判定：这次点击是否落在工作方式弹层内。
 *
 * W795 为什么用**事件路径**而不是 `popup.contains(node)`：乐观切换会**当帧重绘**清单
 * （被点的那一项正是要被标成「当前」的那一项），重绘把它从 DOM 上摘了下来，
 * 于是 `contains()` 对同一个节点返回 false —— 一次本意「点在里面」的点击会被误判成
 * 「点了外面」，弹层在请求发出前就被收起（真机 Blink 实测：409 时弹层不再留在屏幕上）。
 * `composedPath()` 在事件派发时就固定了路径，不受随后的重绘影响。
 * 兼容路径：环境没有 composedPath 时退回 contains()（旧行为）。
 */
export function modePopupHit(e: Event): boolean {
  if (popup === null) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const target = e.target;
  return path.some((n) => n === popup) || (target instanceof Node && popup.contains(target));
}

/** 徽标点击：已开则关，未开则开（与模型/档位弹层的 toggle 语义一致）。 */
export function toggleModePopup(h: ModeHost): void {
  if (popup !== null) {
    closeModePopup();
    return;
  }
  openModePopup(h);
}

/**
 * 打开弹层：**先按可用渲染**（零等待、无任何占位文案），能力位探测返回不可用时
 * 再原地替换成只读态（铁律 1/3：不先清空，晚到的结果不与新状态打架）。
 */
export function openModePopup(h: ModeHost): void {
  closeModePopup();
  const p = el('div', 'sl-popup');
  p.setAttribute('role', 'menu');
  popup = p;
  host = h;
  h.root.appendChild(p);
  overlay = pushOverlay(() => closeModePopup());
  p.appendChild(el('div', 'sl-popup-title', t('statusline.mode.title')));
  const body = el('div', 'sl-popup-body');
  p.appendChild(body);
  renderModeList(body, h.currentMode, true);
  void modeSwitchSupported().then((can) => {
    if (can || popup !== p) return;
    renderModeList(body, h.currentMode, false);
  });
}

/** 清单渲染（离屏构建 + 单次替换，铁律 1）。`can=false` = 只读降级。 */
function renderModeList(body: HTMLElement, current: string, can: boolean): void {
  const off = document.createElement('div');
  for (const o of modeChoices()) off.appendChild(modeRow(o.value, o.label, o.value === current, can));
  const note = can ? t('statusline.mode.currentNote', { mode: modeLabel(current) || t('statusline.unknown') }) : modeNotes().unsupported;
  off.appendChild(el('div', 'sl-popup-note', note));
  body.replaceChildren(...off.childNodes);
}

/** 一行工作方式：当前项标注「当前」并禁用（点它没有意义）；只读态全部禁用。 */
function modeRow(value: SessionMode, label: string, current: boolean, can: boolean): HTMLElement {
  const b = el('button', 'sl-opt' + (current ? ' current' : '')) as HTMLButtonElement;
  b.type = 'button';
  b.appendChild(el('span', 'sl-opt-name', label));
  if (current) b.appendChild(el('span', 'sl-opt-tag', t('statusline.currentTag')));
  b.disabled = !can || current;
  b.addEventListener('click', () => {
    if (!can || current) return;
    void pickMode(value);
  });
  return b;
}

/**
 * 选中一项（W795 乐观更新）：
 *   点下去**同一帧**就把徽标与清单画成目标模式的终态（零占位文案），请求在后台跑；
 *   失败则把徽标退回原模式并说明原因 —— 三态（busy / unsupported / invalid）的分支
 *   与文案逐字未改，只是「进度占位」换成了「先画终态、失败回滚」。
 */
async function pickMode(mode: SessionMode): Promise<void> {
  const h = host;
  const p = popup;
  if (h === null || p === null) return;
  // 会话 id 未解析 ⇒ 必然失败的请求不发、也不先画终态（免得白闪一下）
  if (h.sessionId === '') {
    h.setNote(t('statusline.sessionNotReady'), 6000);
    return;
  }
  const prev = h.currentMode;
  const body = p.querySelector('.sl-popup-body');
  // 终态：徽标 = 目标模式，清单里目标项标「当前」并禁用
  h.applyMode(mode);
  if (body !== null) renderModeList(body as HTMLElement, mode, true);

  const out = await requestModeSwitch(h.sessionId, mode);
  if (out.kind === 'ok') {
    h.setNote(t('statusline.mode.switched', { note: modeNotes().applied }), 6000);
    closeModePopup();
    return;
  }
  // 失败回滚：徽标退回原模式（乐观的显示不许留在错的模式上）
  h.applyMode(prev as SessionMode);
  if (out.kind === 'unsupported') {
    // 老服务：只读降级（弹层留在屏幕上，把清单换成禁用态，不假装成功）
    if (body !== null) renderModeList(body as HTMLElement, prev, false);
  }
  const notes = modeNotes();
  const text =
    out.kind === 'busy'
      ? notes.busy
      : out.kind === 'unsupported'
        ? notes.unsupported
        : out.kind === 'invalid'
          ? notes.invalid
          : out.text;
  h.setNote(text, 6000);
  if (popup !== p) return; // 期间弹层被关掉/重开：只留状态栏提示
  p.appendChild(el('div', 'sl-popup-status err', text));
}
