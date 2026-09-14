// ============================================================================
// ui/grants/panel/position.ts — 面板落位与跟随重排（W751 任务 1a；W760 从 ../panel.ts 拆出）。
//
//   坐标每次都由 getBoundingClientRect() 现算，几何本身是纯函数（../geom.ts 的
//   panelGeom）；本模块只负责「取 rect → 交给纯函数 → 写回 style」与 resize/滚动的
//   跟随监听。W760 只搬家：间距、clamp 规则、监听选项（capture）逐字未改。
// ============================================================================
import { panelGeom, type RectLike, type SizeLike } from '../geom';
import { getPanelEl, getShieldButton } from '../state';

// ---- 面板落位（W751 任务 1a） --------------------------------------------------

/** 面板离开锚点/屏幕时要摘掉的监听（resize / 滚动）。 */
let detachPosition: (() => void) | null = null;

/** 锚点矩形 = 盾牌按钮；盾牌不可见（未就绪/被隐藏）时兜底为状态栏右端。 */
function anchorRect(): RectLike | null {
  const btn = getShieldButton();
  if (btn && btn.isConnected) {
    const r = btn.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  const host = document.getElementById('statusline');
  if (!host) return null;
  const sl = host.getBoundingClientRect();
  return {
    top: sl.top,
    right: sl.right,
    bottom: sl.top,
    left: sl.right,
    width: 0,
    height: 0,
  };
}

function viewportSize(): SizeLike {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

/**
 * 现算坐标并落位：面板下沿贴盾牌上沿（间距 8px）、右沿与盾牌对齐、左右 clamp 进视口、
 * 高度上限 = 盾牌上方可用空间 - 间距（超出则由面板内部滚动）。
 */
export function positionPanel(): void {
  const popup = getPanelEl();
  if (!popup) return;
  const anchor = anchorRect();
  if (!anchor) return;
  // 先清掉上一轮的内联上限，量到**自然**尺寸，再交给纯函数算落位与上限。
  popup.style.maxHeight = '';
  const natural: SizeLike = { width: popup.offsetWidth, height: popup.offsetHeight };
  const geom = panelGeom({ anchor, panel: natural, viewport: viewportSize() });
  popup.style.maxHeight = geom.maxHeight + 'px';
  popup.style.top = geom.top + 'px';
  popup.style.left = geom.left + 'px';
}

/**
 * 跟随重排：resize 与滚动（捕获，内层滚动容器也能收到）都重新落位 —— 选择「重新定位」
 * 而不是「关闭」：面板是跟随盾牌的一次性弹层，跟着盾牌走比突然消失更可预期。
 */
export function attachPosition(): void {
  detachPosition?.();
  let raf = 0;
  const onMove = () => {
    if (raf !== 0) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      positionPanel();
    });
  };
  window.addEventListener('resize', onMove);
  document.addEventListener('scroll', onMove, true);
  detachPosition = () => {
    if (raf !== 0) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    window.removeEventListener('resize', onMove);
    document.removeEventListener('scroll', onMove, true);
  };
}

export function detachPositionNow(): void {
  detachPosition?.();
  detachPosition = null;
}
