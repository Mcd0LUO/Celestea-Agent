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
import { MODE_CHOICES, MODE_NOTES, modeLabel } from '../ui/mode/copy';

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

/** 徽标渲染（只改文本 / class / 标题，不重建 DOM：铁律 1/2/5）。 */
export function renderModeBadge(node: HTMLElement, mode: unknown): void {
  const text = modeLabel(mode);
  node.textContent = text;
  node.classList.toggle('hidden', text === '');
  node.classList.toggle('exec', text === '执行');
  node.title = text === '' ? '' : '工作方式：' + text + '模式（点击切换）';
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
  if (session === '') return { kind: 'error', text: '当前会话尚未就绪，请稍后再试' };
  try {
    const r = await api.setSessionMode(session, mode);
    if (r.ok === false || r.mode !== mode) return { kind: 'error', text: '切换失败，请稍后重试' };
    return { kind: 'ok', mode };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) return { kind: 'busy' };
      if (err.status === 404 || err.status === 405) return { kind: 'unsupported' };
      if (err.status === 400 || err.status === 422) return { kind: 'invalid' };
    }
    return { kind: 'error', text: '切换失败：' + userErrorText(err, '请稍后重试') };
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

/** 点击外部/别的弹层时的判定：该节点是否落在工作方式弹层内。 */
export function modePopupContains(node: Node): boolean {
  return popup !== null && popup.contains(node);
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
 * 打开弹层：**先按可用渲染**（零等待，不闪「加载中…」），能力位探测返回不可用时
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
  p.appendChild(el('div', 'sl-popup-title', '切换工作方式'));
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
  for (const o of MODE_CHOICES) off.appendChild(modeRow(o.value, o.label, o.value === current, can));
  const note = can ? '当前：' + (modeLabel(current) || '未知') + '模式 · 切换在会话下一轮生效' : MODE_NOTES.unsupported;
  off.appendChild(el('div', 'sl-popup-note', note));
  body.replaceChildren(...off.childNodes);
}

/** 一行工作方式：当前项标注「当前」并禁用（点它没有意义）；只读态全部禁用。 */
function modeRow(value: SessionMode, label: string, current: boolean, can: boolean): HTMLElement {
  const b = el('button', 'sl-opt' + (current ? ' current' : '')) as HTMLButtonElement;
  b.type = 'button';
  b.appendChild(el('span', 'sl-opt-name', label));
  if (current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
  b.disabled = !can || current;
  b.addEventListener('click', () => {
    if (!can || current) return;
    void pickMode(value);
  });
  return b;
}

/** 选中一项：切换中 → 成功/失败就地反馈，绝不假装成功。 */
async function pickMode(mode: SessionMode): Promise<void> {
  const h = host;
  const p = popup;
  if (h === null || p === null) return;
  const status = el('div', 'sl-popup-status busy', '切换中…');
  p.appendChild(status);
  const out = await requestModeSwitch(h.sessionId, mode);
  if (out.kind === 'ok') {
    h.applyMode(out.mode);
    h.setNote('已切换工作方式 · ' + MODE_NOTES.applied, 6000);
    closeModePopup();
    return;
  }
  if (out.kind === 'unsupported') {
    // 老服务：只读降级（弹层留在屏幕上，把清单换成禁用态，不假装成功）
    const body = p.querySelector('.sl-popup-body');
    if (body !== null) renderModeList(body as HTMLElement, h.currentMode, false);
  }
  const text =
    out.kind === 'busy'
      ? MODE_NOTES.busy
      : out.kind === 'unsupported'
        ? MODE_NOTES.unsupported
        : out.kind === 'invalid'
          ? MODE_NOTES.invalid
          : out.text;
  h.setNote(text, 6000);
  if (popup !== p) return; // 期间弹层被关掉/重开：只留状态栏提示
  status.className = 'sl-popup-status err';
  status.textContent = text;
}
