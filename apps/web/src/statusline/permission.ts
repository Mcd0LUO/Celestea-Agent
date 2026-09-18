// ============================================================================
// statusline/permission.ts — W858：会话权限档位的**徽标 + 选择弹层**。
//
//   徽标（#slPerm + #slPermBadge）显示当前聚焦会话生效的档位名；点开弹层列出
//   内置 + 自定义档，点选当帧就把徽标与「当前」标记改成目标档（乐观，W795 口径），
//   PUT 失败则回滚到原档并就地说明原因（弹层内 .sl-popup-status + 状态栏轻提示）。
//
//   与 ui/grants.ts 的盾牌是**两个概念**：盾牌管本会话的临时能力放宽（grants），
//   本模块管会话的基线档位（preset）。入口分列、互不合并（任务书明确要求）。
//
//   数据：档位清单走 ui/permissions/store 的共享缓存；当前档位走
//   GET /api/sessions/{id}/permission（按会话缓存）。无活动会话 → 入口隐藏
//   （不显示一个点不动的按钮）；档位清单没回来时弹层正文留空、不做占位文案。
//
//   装配：statusline.ts 只 new 一个 controller 并转发三个事件（attach / onSession /
//   onOutsideClick），徽标与弹层的状态都留在本模块（statusline.ts 的体积棘轮友好）。
// ============================================================================
import { ApiError, api, userErrorText } from '../api';
import type { PermissionPreset } from '../types/permission';
import { anchorOf, placeAnchoredPopup } from '../ui/anchor-popup';
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import { maxNote, riskNote } from '../ui/permissions/copy';
import {
  PERMISSIONS_CHANGED,
  allPresets,
  ensurePresets,
  findPreset,
  labelOf,
  snapshot,
} from '../ui/permissions/store';

/** 徽标视图（preset '' = 未解析/未知 ⇒ 入口隐藏）。 */
export interface PermissionView {
  preset: string;
  label: string;
}

/** 弹层宿主：挂载点 / 会话 / 当前档位 / 两个写回回调。 */
export interface PermissionHost {
  readonly root: HTMLElement;
  readonly sessionId: string;
  readonly currentPreset: string;
  /** 写回徽标视图（乐观与回滚共用；preset '' = 隐藏入口）。 */
  applyPermission(preset: string, label: string): void;
  setNote(text: string, ms: number): void;
}

/** statusline 装配用的控制器（本模块自持徽标/弹层状态）。 */
export interface PermissionController extends PermissionHost {
  /** 装上入口：#slPerm 缺失 = 本页面没有该入口（老骨架/其它测试夹具）。 */
  attach(): void;
  /** 聚焦会话变化：先按本会话缓存画一帧，再拉一次权威值。 */
  onSession(session: string): void;
  /** document 点击：点在弹层与徽标之外则收起（事件路径判定）。 */
  onOutsideClick(e: Event): void;
}

/** 回滚说明后缀（与 mode.ts 的「已恢复原设置」同款口径）。 */
const RESTORED = '（已恢复原档位）';

let popup: HTMLElement | null = null;
let overlay: OverlayHandle | null = null;
let host: PermissionHost | null = null;
let onChanged: (() => void) | null = null;
/** 触发键（#slPerm）：弹层落位的锚点。 */
let anchorEl: HTMLElement | null = null;
/** 跟随重排（resize / 滚动）的解绑器。 */
let detachFollow: (() => void) | null = null;

/**
 * W871：把弹层摆到触发键 #slPerm 的**上方**（panelGeom 现算，视口坐标 + fixed）。
 * 旧口径是相对 statusline 的固定左边距 14px —— 徽标在发送栏右端，面板必然弹到另一头。
 */
function placePopup(): void {
  if (popup === null) return;
  const anchor = anchorOf(anchorEl);
  if (anchor) placeAnchoredPopup(popup, anchor);
}

/** resize / 滚动（捕获：内层滚动容器也能收到）都重新落位；关闭时解绑。 */
function attachFollow(): void {
  detachFollow?.();
  let raf = 0;
  const onMove = (e: Event): void => {
    // 弹层**自身内部**的滚动不重新落位（与盾牌面板同口径：会打断用户正在进行的滚动）。
    if (popup && e.target instanceof Node && popup.contains(e.target)) return;
    if (raf !== 0) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      placePopup();
    });
  };
  window.addEventListener('resize', onMove);
  document.addEventListener('scroll', onMove, true);
  detachFollow = () => {
    if (raf !== 0) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    window.removeEventListener('resize', onMove);
    document.removeEventListener('scroll', onMove, true);
  };
}

function detachFollowNow(): void {
  detachFollow?.();
  detachFollow = null;
}

/** 只改文本 / class / 标题，不重建 DOM（铁律 1/2/5）。 */
function paintBadge(button: HTMLElement | null, badge: HTMLElement | null, view: PermissionView | null): void {
  if (button === null) return;
  const known = view !== null && view.preset !== '';
  button.classList.toggle('hidden', !known);
  const label = known ? view.label || view.preset : '';
  if (badge !== null && known) badge.textContent = label;
  button.title = known ? '会话权限档位：' + label + '（点击切换）' : '会话权限档位';
  button.setAttribute('aria-label', known ? '会话权限档位 ' + label : '会话权限档位');
}

/** 装配入口：root = #statusline；sessionOf = 当前聚焦会话；note = 状态栏轻提示。 */
export function createPermissionController(
  root: HTMLElement,
  sessionOf: () => string,
  note: (text: string, ms: number) => void,
): PermissionController {
  let button: HTMLElement | null = null;
  let badge: HTMLElement | null = null;
  let session = '';
  const cache = new Map<string, PermissionView>();

  const paint = (): void => paintBadge(button, badge, cache.get(session) ?? null);

  const ctrl: PermissionController = {
    root,
    get sessionId() {
      return session;
    },
    get currentPreset() {
      return cache.get(session)?.preset ?? '';
    },
    applyPermission(preset: string, label: string) {
      if (preset === '') cache.delete(session);
      else cache.set(session, { preset, label });
      paint();
    },
    setNote: (text, ms) => note(text, ms),
    attach() {
      button = root.querySelector<HTMLElement>('#slPerm');
      badge = root.querySelector<HTMLElement>('#slPermBadge');
      if (button === null) return;
      session = sessionOf();
      button.addEventListener('click', () => togglePermissionPopup(ctrl));
      paint();
    },
    onSession(next: string) {
      session = next;
      paint();
      if (button !== null) void refreshPermission(ctrl);
    },
    onOutsideClick(e: Event) {
      if (permissionPopupHit(e)) return;
      if (button !== null && button.contains(e.target as Node)) return;
      closePermissionPopup();
    },
  };
  return ctrl;
}

/**
 * 拉取当前会话的档位（onSession 调用）。竞态守卫：结果回来时会话已切换则丢弃。
 * 404/405 = 该部署没有这个能力 → 入口隐藏；网络不可达（status 0）保留上次视图。
 */
export async function refreshPermission(h: PermissionHost): Promise<void> {
  const asked = h.sessionId;
  if (asked === '') {
    h.applyPermission('', '');
    return;
  }
  try {
    const [r] = await Promise.all([api.sessionPermission(asked), ensurePresets().catch(() => null)]);
    if (asked !== h.sessionId) return;
    if (r.ok === false || typeof r.preset !== 'string' || r.preset === '') {
      h.applyPermission('', '');
      return;
    }
    h.applyPermission(r.preset, labelOf(r.preset));
  } catch (err) {
    if (asked !== h.sessionId) return;
    if (err instanceof ApiError && err.status !== 0) h.applyPermission('', '');
  }
}

// ---- 弹层（与 picker / mode 同款：向上弹出 + Esc 层级栈 + 离屏构建单次替换） -----

export function closePermissionPopup(): void {
  if (onChanged !== null) {
    window.removeEventListener(PERMISSIONS_CHANGED, onChanged);
    onChanged = null;
  }
  detachFollowNow();
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

/** 点外部判定：用事件路径（乐观重绘会当帧换掉被点的行，contains 会误判）。 */
export function permissionPopupHit(e: Event): boolean {
  if (popup === null) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const target = e.target;
  return path.some((n) => n === popup) || (target instanceof Node && popup.contains(target));
}

export function togglePermissionPopup(h: PermissionHost): void {
  if (popup !== null) {
    closePermissionPopup();
    return;
  }
  openPermissionPopup(h);
}

export function openPermissionPopup(h: PermissionHost): void {
  closePermissionPopup();
  const p = el('div', 'sl-popup perm-popup');
  p.setAttribute('role', 'menu');
  popup = p;
  host = h;
  anchorEl = document.getElementById('slPerm');
  h.root.appendChild(p);
  overlay = pushOverlay(() => closePermissionPopup());
  p.appendChild(el('div', 'sl-popup-title', '会话权限档位'));
  const body = el('div', 'sl-popup-body');
  p.appendChild(body);
  renderPermissionMenu(body, h);
  // W871：落位在**挂载之后**现算（panelGeom 要量面板的 offsetWidth/offsetHeight；
  // 清单是当帧画出来的 ⇒ 这里量到的就是真实尺寸）。窄屏不改 JS 分支：触屏档由
  // responsive.css 的 .sl-popup.perm-popup 贴底抽屉规则（!important）覆盖内联坐标 ——
  // 与盾牌面板（ui/grants/panel/body.ts 无条件 positionPanel）逐字同口径，
  // 免得窗口在临界宽度改变时留下「算过/没算过」两种状态。
  placePopup();
  attachFollow();
  onChanged = () => {
    if (popup !== p) return;
    renderPermissionMenu(body, h);
    placePopup(); // 重画后高度变了，跟着重新落位
  };
  window.addEventListener(PERMISSIONS_CHANGED, onChanged);
  void ensurePresets()
    .then(() => {
      if (popup !== p) return;
      renderPermissionMenu(body, h);
      placePopup();
    })
    .catch(() => {
      /* 取不到清单：正文留空，不做占位文案 */
    });
}

function renderPermissionMenu(body: HTMLElement, h: PermissionHost): void {
  const off = document.createElement('div');
  for (const p of allPresets()) off.appendChild(presetRow(p, h));
  const risk = riskNote(findPreset(h.currentPreset));
  if (risk !== '') off.appendChild(el('div', 'sl-popup-note perm-risk', risk));
  const max = snapshot()?.max ?? '';
  if (max !== '') off.appendChild(el('div', 'sl-popup-note', maxNote(max)));
  if (h.sessionId === '') off.appendChild(el('div', 'sl-popup-note', '当前没有打开的会话，无法切换'));
  body.replaceChildren(...off.childNodes);
}

function presetRow(p: PermissionPreset, h: PermissionHost): HTMLElement {
  const current = p.id === h.currentPreset;
  const b = el('button', 'sl-opt' + (current ? ' current' : '')) as HTMLButtonElement;
  b.type = 'button';
  b.dataset.preset = p.id;
  b.appendChild(el('span', 'sl-opt-name', p.label || p.id));
  b.appendChild(el('span', 'sl-opt-val', p.id));
  if (current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
  b.disabled = current || h.sessionId === '';
  b.addEventListener('click', () => {
    if (!current && h.sessionId !== '') void pickPreset(p);
  });
  return b;
}

interface PickOutcome {
  ok: boolean;
  text: string;
}

/** PUT /api/sessions/{id}/permission：只有 422 透传服务端原因，其余走固定措辞。 */
async function requestPreset(session: string, preset: string): Promise<PickOutcome> {
  try {
    const r = await api.setSessionPermission(session, preset);
    if (r.ok === false) return { ok: false, text: '切换失败：服务拒绝了该档位' + RESTORED };
    if (typeof r.preset === 'string' && r.preset !== preset) {
      return { ok: false, text: '切换失败：服务未接受该档位' + RESTORED };
    }
    return { ok: true, text: '' };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404 || err.status === 405) {
        return { ok: false, text: '当前版本不支持切换会话权限档位' + RESTORED };
      }
      if (err.status === 422) {
        return { ok: false, text: '切换失败：' + (err.technical || '未知档位') + RESTORED };
      }
      return { ok: false, text: '切换失败：' + err.message + RESTORED };
    }
    return { ok: false, text: '切换失败：' + userErrorText(err, '请稍后重试') + RESTORED };
  }
}

/** 点选一档：当帧换徽标 + 「当前」标记；失败回滚并就地说明原因。 */
async function pickPreset(p: PermissionPreset): Promise<void> {
  const h = host;
  const box = popup;
  if (h === null || box === null) return;
  const prevId = h.currentPreset;
  const prevLabel = findPreset(prevId)?.label ?? prevId;
  const body = box.querySelector('.sl-popup-body');
  h.applyPermission(p.id, p.label || p.id);
  if (body !== null) renderPermissionMenu(body as HTMLElement, h);

  const out = await requestPreset(h.sessionId, p.id);
  if (out.ok) {
    h.setNote('已切换会话权限档位 · 下一轮生效', 6000);
    closePermissionPopup();
    return;
  }
  h.applyPermission(prevId, prevLabel);
  if (popup !== box) {
    h.setNote(out.text, 6000);
    return;
  }
  const again = box.querySelector('.sl-popup-body');
  if (again !== null) renderPermissionMenu(again as HTMLElement, h);
  box.appendChild(el('div', 'sl-popup-status err', out.text));
  h.setNote(out.text, 6000);
}
