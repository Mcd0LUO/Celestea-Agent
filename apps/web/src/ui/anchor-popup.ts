// ============================================================================
// ui/anchor-popup.ts — 「贴着某个按钮上沿向上弹」的固定定位弹层（W871）。
//
//   为什么单独一个文件：W871 之前，同一个需求有两套写法 ——
//     · ui/grants/panel/position.ts（盾牌面板）：panelGeom 现算视口坐标 + position:fixed；
//     · statusline/permission.ts（会话档位弹层）：靠 .sl-popup 基类的
//       `bottom: calc(100% - 2px); left: 14px` 死坐标，而触发它的入口在发送栏
//       **右端** ⇒ 面板弹到另一头（1280×800 实测横向差 −780.45px，用户报「错位到左边」）。
//       （W1517：档位弹层已并入盾牌面板 —— 触发键就是唯一的盾牌入口 #slGrant，
//       落位仍走本模块的同一套适配器。）
//   本模块把前者抽成**唯一**的落位适配器（几何仍是 ui/grants/geom.ts 的纯函数
//   panelGeom —— 没有第二套算式），供两者共用。
//
//   几何契约（与 panelGeom 的注释一致，这里只做「取 rect → 算 → 写 style」）：
//     · 面板下沿 = 锚点上沿 − gap；上方空间不足则下移但不越过 margin；
//     · maxHeight = 锚点上方可用空间 − gap（超出交给面板内部滚动）；
//     · 水平右对齐锚点右缘，再 clamp 进 [margin, viewport.width − margin]。
//   所有输出都是**视口坐标**（配 position: fixed 使用），滚动/resize 时重算即可。
// ============================================================================
import { panelGeom, panelNaturalHeight, type RectLike, type SizeLike } from './grants/geom';

/** 面板内部的滚动容器；不存在（老结构/纯文本弹层）时返回 null。 */
function bodyOf(popup: HTMLElement): HTMLElement | null {
  return popup.querySelector<HTMLElement>('.sl-popup-body');
}

function viewportSize(): SizeLike {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
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

/** 锚点矩形：优先用触发键（可见时），否则退回状态栏右缘（老的兜底口径）。 */
export function anchorOf(btn: HTMLElement | null): RectLike | null {
  if (btn && btn.isConnected) {
    const r = btn.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  const host = document.getElementById('statusline');
  if (!host) return null;
  const sl = host.getBoundingClientRect();
  return { top: sl.top, right: sl.right, bottom: sl.top, left: sl.right, width: 0, height: 0 };
}

/**
 * 把已挂载的弹层摆到锚点上方（视口坐标，写内联 top/left/max-height）。
 *
 * W789 不变量（实测根因，改本函数前务必读）：**绝不**把内联 max-height 清空/写回空串 ——
 * 它是 .sl-popup-body 唯一的可滚动高度来源；清空的瞬间 body 溢出消失，浏览器把
 * body.scrollTop 夹回 0，而调用方挂在 scroll 捕获监听上，于是「滚一格 → 弹回顶部」。
 * 这里用 panelNaturalHeight 推算自然高度，并把写回后被动过的 scrollTop 还原。
 */
export function placeAnchoredPopup(popup: HTMLElement, anchor: RectLike): void {
  const geom = panelGeom({ anchor, panel: naturalSize(popup), viewport: viewportSize() });
  const body = bodyOf(popup);
  const keepTop = body ? body.scrollTop : 0;
  popup.style.maxHeight = geom.maxHeight + 'px';
  popup.style.top = geom.top + 'px';
  popup.style.left = geom.left + 'px';
  if (body && body.scrollTop !== keepTop) body.scrollTop = keepTop;
}
