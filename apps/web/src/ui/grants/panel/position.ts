// ============================================================================
// ui/grants/panel/position.ts — 面板落位与跟随重排（W751 任务 1a；W760 从 ../panel.ts 拆出）。
//
//   坐标每次都由 getBoundingClientRect() 现算，几何本身是纯函数（../geom.ts 的
//   panelGeom）；本模块只负责「取 rect → 交给纯函数 → 写回 style」与 resize/滚动的
//   跟随监听。W760 只搬家：间距、clamp 规则、监听选项（capture）逐字未改。
// ============================================================================
import { panelGeom, panelNaturalHeight, type RectLike, type SizeLike } from '../geom';
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

/** 面板内部的滚动容器（.sl-popup-body）；不存在（老结构）时返回 null。 */
function bodyOf(popup: HTMLElement): HTMLElement | null {
  return popup.querySelector<HTMLElement>('.sl-popup-body');
}

/**
 * 面板自然尺寸：**不清 max-height**，从当前受限布局推算高度（见 geom.ts 的
 * panelNaturalHeight —— 清空这一层会让内部滚动容器的 scrollTop 被夹回 0）。
 */
function naturalSize(popup: HTMLElement): SizeLike {
  const body = bodyOf(popup);
  return {
    width: popup.offsetWidth,
    height: panelNaturalHeight({
      panelHeight: popup.offsetHeight,
      bodyClientHeight: body ? body.clientHeight : 0,
      bodyScrollHeight: body ? body.scrollHeight : 0,
    }),
  };
}

/**
 * 现算坐标并落位：面板下沿贴盾牌上沿（间距 8px）、右沿与盾牌对齐、左右 clamp 进视口、
 * 高度上限 = 盾牌上方可用空间 - 间距（超出则由面板内部滚动）。
 *
 * W789：本函数**绝不**清空内联 max-height（那是 .sl-popup-body 唯一的滚动高度来源，
 * 清空会让它的 scrollTop 归零 → 滚轮每滚一格就被弹回顶部）。写回高度/位置也不会
 * 丢掉用户已经滚出来的位置：写完后校验一次 scrollTop，被浏览器夹掉就还原。
 */
export function positionPanel(): void {
  const popup = getPanelEl();
  if (!popup) return;
  const anchor = anchorRect();
  if (!anchor) return;
  const geom = panelGeom({ anchor, panel: naturalSize(popup), viewport: viewportSize() });
  const body = bodyOf(popup);
  const keepTop = body ? body.scrollTop : 0;
  popup.style.maxHeight = geom.maxHeight + 'px';
  popup.style.top = geom.top + 'px';
  popup.style.left = geom.left + 'px';
  if (body && body.scrollTop !== keepTop) body.scrollTop = keepTop;
}

/**
 * 跟随重排：resize 与滚动（捕获，内层滚动容器也能收到）都重新落位 —— 选择「重新定位」
 * 而不是「关闭」：面板是跟随盾牌的一次性弹层，跟着盾牌走比突然消失更可预期。
 */
export function attachPosition(): void {
  detachPosition?.();
  let raf = 0;
  const onMove = (e: Event) => {
    // W789：面板**自身内部**的滚动不触发重新落位 —— 内部滚动不移动锚点，而重排会
    // 打断用户正在进行的滚动（headless Blink 实测：滚轮滚到 120，随后被重置为 0）。
    // 注意 resize 事件的 target 是 window（不是 Node）：必须先判型再 contains。
    const target = e.target;
    const popup = getPanelEl();
    if (popup && target instanceof Node && popup.contains(target)) return;
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
