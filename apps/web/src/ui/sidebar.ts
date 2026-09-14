// ============================================================================
// ui/sidebar.ts — 侧栏布局：
//   1) 收起/展开（顶栏按钮，localStorage 持久）
//   2) 拖宽（与主区之间的分隔条，pointer 事件，min/max 约束，localStorage 持久）
//   3) W765：**移动端抽屉**（≤640px）——顶栏按钮变汉堡，侧栏改为覆盖式抽屉 + 遮罩，
//      点遮罩 / 按 Esc / 点某个会话行即关闭；桌面端的「收起/拖宽」语义与持久化完全不变。
//      （断点数值口径登记在 styles/responsive.css 顶部，二者必须一致。）
// ============================================================================
import { need } from '../utils/dom';

const STORAGE_COLLAPSED = 'celestea-studio.sidebar-collapsed';
const STORAGE_WIDTH = 'celestea-studio.sidebar-width';

export const SIDEBAR_DEFAULT = 316;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 560;

function clampWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

function readStoredCollapsed(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_COLLAPSED);
    // 未存过：窄屏默认收起，宽屏默认展开
    if (v !== null) return v === '1';
    return window.innerWidth < 880;
  } catch {
    return false;
  }
}

function readStoredWidth(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_WIDTH));
    return Number.isFinite(v) && v > 0 ? v : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function initSidebar(): void {
  const app = need<HTMLElement>('#app');
  const sidebar = need<HTMLElement>('#sidebar');
  const resizer = need<HTMLElement>('#sidebarResizer');
  const btn = need<HTMLButtonElement>('#btnSidebar');

  let collapsed = readStoredCollapsed();

  // W227 任务1：同步 --sidebar-w 供聊天列宽度动态跟随（.mcol max-width）
  const applyCollapsed = () => {
    app.classList.toggle('sidebar-collapsed', collapsed);
    app.style.setProperty('--sidebar-w', collapsed ? '0px' : sidebar.style.width || '316px');
    btn.textContent = collapsed ? '展开' : '收起';
    btn.title = collapsed ? '展开左侧面板' : '收起左侧面板';
  };
  const applyWidth = (w: number) => {
    const px = clampWidth(w) + 'px';
    sidebar.style.width = px;
    app.style.setProperty('--sidebar-w', px);
  };

  applyCollapsed();
  applyWidth(readStoredWidth());

  btn.addEventListener('click', () => {
    if (isMobileViewport()) return; // W765：移动端由 initDrawer 接管（汉堡开合）
    collapsed = !collapsed;
    try {
      localStorage.setItem(STORAGE_COLLAPSED, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    applyCollapsed();
  });

  // ---- 拖动分隔条（pointer 事件；自动捕获指针） ----
  let dragging = false;
  let startX = 0;
  let startW = 0;

  const persistWidth = () => {
    try {
      localStorage.setItem(STORAGE_WIDTH, String(Math.round(sidebar.getBoundingClientRect().width)));
    } catch {
      /* storage unavailable */
    }
  };

  resizer.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    applyWidth(startW + (e.clientX - startX));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    persistWidth();
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => {
    applyWidth(SIDEBAR_DEFAULT);
    persistWidth();
  });

  // ---- W765：移动端抽屉（汉堡开合；桌面端一切照旧） ------------------------------
  initDrawer(btn);
}

/** 移动端断点（与 styles/responsive.css 的 mobile 档一致）。 */
const MOBILE_QUERY = '(max-width: 640px)';

function isMobileViewport(): boolean {
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return window.innerWidth <= 640;
  }
}

/**
 * 抽屉：只在移动端生效。桌面端的 collapsed 状态（localStorage 持久）不参与抽屉判定，
 * 因此从桌面缩到手机、再放大回去，用户原来的收起/展开偏好不会被抽屉污染。
 */
function initDrawer(btn: HTMLButtonElement): void {
  const app = need<HTMLElement>('#app');
  const scrim = document.getElementById('sidebarScrim');
  let open = false;

  const apply = (): void => {
    app.classList.toggle('drawer-open', open);
    if (scrim) scrim.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    apply();
  };
  apply();

  btn.addEventListener('click', () => {
    if (!isMobileViewport()) return; // 桌面端走上面的收起/展开分支
    setOpen(!open);
  });
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) setOpen(false);
  });
  // 点会话行 = 已经选好了会话 → 收起抽屉（触摸端没有「鼠标移开」这一步）
  document.getElementById('sessionTree')?.addEventListener('click', (e) => {
    if (!open) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('.sess-leaf')) setOpen(false);
  });
  // 视口跨过断点（旋屏/缩放）→ 抽屉状态不跨端残留
  try {
    window.matchMedia(MOBILE_QUERY).addEventListener('change', (ev) => {
      if (!ev.matches) setOpen(false);
    });
  } catch {
    /* 旧浏览器没有 addEventListener 版 MediaQueryList：抽屉仍可点遮罩关闭 */
  }
}
