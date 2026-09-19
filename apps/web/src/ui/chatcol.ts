// ============================================================================
// ui/chatcol.ts — W867：正文列宽（两侧与页面边距的距离）可拖动调节 + 持久化
// ----------------------------------------------------------------------------
// 几何真源（W12）：.sess-pane 的左右内边距 =
//   max(--sp-composer-side, (100% − --chat-col) / 2)（styles/views.css），
//   --chat-col = clamp(680px, 64%, 920px)（styles/tokens.css）⇒ 正文列居中、两侧留白对称。
// 本模块把拖动得到的宽度写进 :root 的 --chat-col-user；tokens.css 的 --chat-col 优先取它
//   （未设置 ⇒ 保持原 clamp 缺省）。只改这一个值 ⇒ 左右留白同步缩放，正是用户要的
//   「两侧与页面边距的距离可自由调节放缩」。
// 为什么写在 documentElement 而不是 #app：--chat-col 是在 :root 上由
//   var(--chat-col-user, …) **算出来**的自定义属性；自定义属性里的 var() 在声明所在元素
//   上求值（css-variables §3），写在 #app 上 :root 看不到 → 会静默失效。
// 持久化：celestea-studio.chat-col-width（与 sidebar 的 celestea-studio.* 同族）。
//   双击复位 = 删除键、回到缺省 clamp（不钉死一个「缺省 px」，窗口变宽时缺省仍会跟着长）。
// 窄屏降级：≤1024px 的 .sess-pane 内边距由 responsive.css 固定为 16/14（列宽在这一档本就
//   不生效），手柄同时 display:none，避免「能拖但没反应」的误导；回桌面档自动恢复。
// ============================================================================
import { el } from '../utils/dom';
import { t } from '../i18n';

/** 持久化键（命名空间与 sidebar 的 celestea-studio.* 一致）。 */
export const CHAT_COL_STORAGE_KEY = 'celestea-studio.chat-col-width';
/** 下限：再窄正文列不可读（与 .mcol 的 max-width clamp 下限同值）。 */
export const CHAT_COL_MIN = 560;
/** 上限：与 .mcol 的 max-width clamp 上限同值（更宽会被它收住 = 拖了没反应）。 */
export const CHAT_COL_MAX = 1400;
/** 列居中 ⇒ 列缘位移 = Δ宽 / 2；要让列缘跟手，宽度必须按位移的 2× 变。 */
const DRAG_SCALE = 2;
/** 键盘步进（px）：手柄可聚焦（role=separator），无鼠标也能调。 */
const KEY_STEP = 16;

/** 当前生效宽度（null = 用缺省 clamp）。 */
let value: number | null = null;

/** 夹到 [CHAT_COL_MIN, CHAT_COL_MAX] 的整数像素（非有限值的兜底在 readChatCol）。 */
export function clampChatCol(w: number): number {
  return Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, Math.round(w)));
}

/** 读持久化宽度：未存过 / 解析不出 / 非正数 → null（= 用缺省 clamp，不是「用 0」）。 */
export function readChatCol(): number | null {
  try {
    const raw = localStorage.getItem(CHAT_COL_STORAGE_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? clampChatCol(n) : null;
  } catch {
    return null;
  }
}

function persistChatCol(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(CHAT_COL_STORAGE_KEY);
    else localStorage.setItem(CHAT_COL_STORAGE_KEY, String(w));
  } catch {
    /* storage unavailable */
  }
}

/** 写入 :root：null = 移除覆盖（回到 tokens.css 的缺省 clamp）。 */
export function applyChatCol(w: number | null): void {
  const style = document.documentElement.style;
  if (w === null) style.removeProperty('--chat-col-user');
  else style.setProperty('--chat-col-user', clampChatCol(w) + 'px');
}

/** 当前生效宽度（null = 缺省；测试与诊断用）。 */
export function chatColValue(): number | null {
  return value;
}

/** 视觉列宽（拖动基准）：聚焦窗格里 .mcol 的实际宽度；量不到（空态/垫片）→ 下限。 */
function measureColumn(): number {
  const col =
    document.querySelector<HTMLElement>('.sess-pane:not([hidden]) .mcol') ??
    document.querySelector<HTMLElement>('.mcol');
  const w = col ? col.getBoundingClientRect().width : 0;
  return w > 0 ? clampChatCol(w) : CHAT_COL_MIN;
}

/** 设定宽度：save=false 只 apply（拖动中每帧落盘毫无意义）。 */
function setChatCol(w: number | null, save: boolean): void {
  value = w === null ? null : clampChatCol(w);
  applyChatCol(value);
  if (save) persistChatCol(value);
}

/** 拖动：pointer 事件 + 指针捕获（与 ui/sidebar.ts 的分隔条同一套写法）。 */
function bindDrag(grip: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startW = 0;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = value ?? measureColumn();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获不可用（旧浏览器 / 测试垫片）：指针移出元素后 pointermove 不再到达，仅影响手感 */
    }
    document.body.classList.add('resizing-col');
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setChatCol(startW + DRAG_SCALE * (e.clientX - startX), false);
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-col');
    persistChatCol(value); // 落盘一次（pointerup / pointercancel）
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => setChatCol(null, true)); // 双击复位到缺省
}

/** 键盘：← / → 各一步（16px），即刻落盘。 */
function bindKeys(grip: HTMLElement): void {
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP;
    setChatCol((value ?? measureColumn()) + step, true);
  });
}

/**
 * 装配（幂等；main.ts 在 #messages 就位后调用一次）。宿主缺失不抛（与 initRail 同口径）。
 * 幂等分两半：手柄只挂一次（不重复建 DOM / 不重复绑事件），但**每次都重放持久化值** ——
 * 重复调用等价于「重新读一次用户设置」，不会把宽度搞丢。
 */
export function initChatCol(): void {
  const host = document.getElementById('messages');
  if (!host || host.querySelector('.chatcol-resizer')) {
    setChatCol(readChatCol(), false);
    return;
  }
  const grip = el('div', 'chatcol-resizer');
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', t('shell.chatcol.label'));
  grip.title = t('shell.chatcol.hint');
  host.appendChild(grip);
  bindDrag(grip);
  bindKeys(grip);
  setChatCol(readChatCol(), false); // 恢复持久化值（null = 保持缺省 clamp）
}
