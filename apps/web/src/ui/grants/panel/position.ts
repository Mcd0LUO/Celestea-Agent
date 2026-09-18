// ============================================================================
// ui/grants/panel/position.ts — 面板落位与跟随重排（W751 任务 1a；W760 从 ../panel.ts 拆出）。
//
//   坐标每次都由 getBoundingClientRect() 现算，几何本身是纯函数（../geom.ts 的
//   panelGeom）；本模块只负责「取 rect → 交给纯函数 → 写回 style」与 resize/滚动的
//   跟随监听。
//
//   W871：几何与「取 rect → 写 style」的适配器搬到 ../../anchor-popup.ts —— 会话档位
//   弹层（statusline/permission.ts）此前用的是另一套（.sl-popup 基类的
//   `bottom: calc(100% - 2px); left: 14px` 死坐标），触发键在右端时必然错位。
//   现在两处共用**同一套** panelGeom 适配器（不再有第二套落位算式），本模块只保留
//   盾牌特有的锚点选择（盾牌按钮 → 状态栏右缘兜底）与对外 API（调用点零改动）。
// ============================================================================
import { anchorOf, placeAnchoredPopup } from '../../anchor-popup';
import { getPanelEl, getShieldButton } from '../state';

// ---- 面板落位（W751 任务 1a） --------------------------------------------------

/** 面板离开锚点/屏幕时要摘掉的监听（resize / 滚动）。 */
let detachPosition: (() => void) | null = null;

/**
 * 现算坐标并落位：面板下沿贴盾牌上沿（间距 8px）、右沿与盾牌对齐、左右 clamp 进视口、
 * 高度上限 = 盾牌上方可用空间 - 间距（超出则由面板内部滚动）。
 *
 * W789 不变量：**绝不**清空内联 max-height（见 ../../anchor-popup.ts 的同名说明）。
 * W871：算式本身搬到 anchor-popup.ts 的 placeAnchoredPopup（与档位弹层共用）。
 */
export function positionPanel(): void {
  const popup = getPanelEl();
  if (!popup) return;
  // 锚点 = 盾牌按钮；盾牌不可见（未就绪/被隐藏）时兜底为状态栏右端。
  const anchor = anchorOf(getShieldButton());
  if (!anchor) return;
  placeAnchoredPopup(popup, anchor);
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
