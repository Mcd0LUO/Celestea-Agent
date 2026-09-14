// ============================================================================
// ui/grants/geom.ts — 权限面板的定位几何（W751 任务 1a）
//
//   为什么单独一个文件：面板位置必须是**可断言**的纯函数（零 import、零 DOM），
//   才能在 node 里直接加载跑边界用例（先例：ui/grants/caps.ts / security/scope-hash.ts）。
//   调用方（./panel.ts 的 positionPanel）只负责取三个 rect 和把结果写进 style。
//
//   几何契约（面板紧贴盾牌按钮上方）：
//     1) 垂直：面板下沿 = 锚点上沿 - gap；顶部空间不够时整体下移，但**不越过** margin。
//     2) 垂直上限：maxHeight = 锚点上方可用空间 - gap（面板自身滚动，不顶出屏幕）；
//        可用空间小于 minHeight 时取 minHeight（宁可压住盾牌，也绝不顶出屏幕顶部）。
//     3) 水平：面板右沿与锚点右沿对齐（盾牌在状态栏最右侧），再 clamp 进
//        [margin, viewport.width - margin]；面板比视口还宽时左对齐到 margin。
//   所有输出都是**视口坐标**（配 position: fixed 使用）——因此锚点、视口、面板尺寸
//   全部走 getBoundingClientRect() / 视口实测，滚动与 resize 时重算即可，不需要猜。
// ============================================================================

/** 视口坐标矩形（getBoundingClientRect() 的子集）。 */
export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

/** 面板落位结果（视口坐标；maxHeight 交给调用方写进 style）。 */
export interface PanelGeom {
  top: number;
  left: number;
  maxHeight: number;
}

/** 面板与盾牌之间留的间距（px）。 */
export const PANEL_GAP = 8;
/** 面板与视口边缘之间留的安全边距（px）。 */
export const PANEL_MARGIN = 8;
/** 面板高度的下限（px）：上方空间不足时也不缩到不可用。 */
export const PANEL_MIN_HEIGHT = 120;

/**
 * 面板几何：输入锚点 rect（盾牌按钮）+ 面板自然尺寸 + 视口尺寸，输出落位与高度上限。
 *
 * 纯函数：不读 DOM、不写样式、不依赖时间；同样的输入永远给同样的输出。
 */
export function panelGeom(input: {
  /** 锚点（盾牌按钮）的视口矩形。 */
  anchor: RectLike;
  /** 面板的**自然**尺寸（未受 max-height 限制时量到的宽高）。 */
  panel: SizeLike;
  /** 视口尺寸（window.innerWidth / innerHeight）。 */
  viewport: SizeLike;
  gap?: number;
  margin?: number;
  minHeight?: number;
}): PanelGeom {
  const gap = input.gap ?? PANEL_GAP;
  const margin = input.margin ?? PANEL_MARGIN;
  const minHeight = input.minHeight ?? PANEL_MIN_HEIGHT;

  const vw = Math.max(0, input.viewport.width);
  const panelW = Math.max(0, input.panel.width);

  // ① 高度上限 = 锚点上方可用空间 - 间距；不足下限时取下限（不出屏，宁可压住盾牌）。
  const availAbove = input.anchor.top - gap - margin;
  const maxHeight = Math.max(minHeight, availAbove);

  // ② 用**受限后**的实际高度落位：下沿贴锚点上沿 - gap，再保证不越过视口上边距。
  const height = Math.min(Math.max(0, input.panel.height), maxHeight);
  const top = Math.max(margin, input.anchor.top - gap - height);

  // ③ 右对齐锚点，再 clamp 进视口（左边界 margin / 右边界 vw - margin）。
  const maxLeft = Math.max(margin, vw - margin - panelW);
  const left = Math.max(margin, Math.min(input.anchor.right - panelW, maxLeft));

  return {
    top: Math.round(top),
    left: Math.round(left),
    maxHeight: Math.round(maxHeight),
  };
}
