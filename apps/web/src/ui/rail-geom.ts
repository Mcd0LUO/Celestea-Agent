// ============================================================================
// ui/rail-geom.ts — W867：灵动选择条的**纯几何**（零 DOM、零状态、可单测）。
//
//   为什么单独成模块：rail.ts 是模块体积棘轮盯着的文件（登记上限只许降不许升），
//   而「长条多高 / 命中多远 / 描边多长」这三件事本来就是纯算术 —— 与 DOM 无关，
//   抽出来既让 rail.ts 回到上限内，也让这些常量与公式第一次可以被直接断言
//   （tests/w867-rail-hit.test.ts 用的是**公式**，不是魔数：改 HIT_SLOP 一个常量，
//   断言会跟着走）。
//
//   ★ 这里的每个数字都直接决定可见几何，改动前先读 rail.ts 的调用点注释。
// ============================================================================

/** 长条之间的间隙（px）。自然高 5 + 间隙 4 = 自然节距 9。 */
export const RAIL_GAP = 4;
/** 节距上下限（px）：自然 9；条数超出可用高时压到最密 4。 */
export const RAIL_PITCH_NATURAL = 5 + RAIL_GAP; // 9px
export const RAIL_PITCH_MIN = 4;
/** 轨道内上下留白（px）。 */
export const RAIL_PAD_Y = 8;
/**
 * 长条**长度**刻度（px）。用户第 6 条澄清：「是条太长，缩减 40%」⇒ 整条刻度 ×0.6：
 *   静止 7 → 4；吸附最长 110 → 66（= 110 × 0.6）。
 * 只动这两个常量：railW = min(RAIL_MAX_W, gw − 26) 与
 * railBarWidth 的插值式**一字未改**，于是「细条 → 展开」的全长度刻度整体缩短 40%。
 * 条高 / 节距（--barh / pitch / RAIL_GAP）**不动**：用户没要求条变细或变密。
 */
export const RAIL_BASE_W = 4;
export const RAIL_MAX_W = 66;
/** 满吸附（k ≥ 1）时的命中加成（px）；用户没要求改，保持原值。 */
export const RAIL_HIT_BOOST = 6;
/** 留白带宽档位（px）：<HIDE 整条隐藏；<NORMAL 走细档。 */
export const RAIL_GUTTER_NORMAL = 64;
export const RAIL_GUTTER_HIDE = 24;
/** 长条不透明度：静止 0.3 → 吸附 0.7。 */
export const RAIL_BASE_OPACITY = 0.3;

/**
 * W867：fisheye（吸附变长）作用半径。旧值 80px ≈ 9 条长条同时跟着变长 —— 鼠标离得
 * 还远就已经「粘」上（用户 6①：吸附距离太长）。收紧到 28px ≈ 3 条（自然节距 9px）。
 */
export const RAIL_FISHEYE_RANGE = 28;

/** 命中半径的「条上缓冲」（px）—— 指针落在长条本身 ±1px 才算命中。 */
const HIT_SLOP = 1;
/** 命中半径下限（px）—— 节距压到最密（RAIL_PITCH_MIN）时仍必须命中得到。 */
const HIT_MIN = 2;

/** 长条实际高度：节距减间隙，至少 2px（与 barH 同一口径）。 */
export function railBarHeight(pitch: number): number {
  return Math.max(2, pitch - RAIL_GAP);
}

/**
 * W867：hover 命中半径（px）。旧口径 'Math.max(pitch / 2, 8)' 在 pitch ∈ [4, 9] 上
 * **恒等于 8px**（pitch/2 ≤ 4.5 永远压不过那个 8 的下限）—— 相邻条心只隔一个 pitch，
 * 8px ≥ pitch/2 意味着条与条之间的空隙也全部算命中：鼠标只要落在条带里就一定吸附/弹预览
 * （用户 6①：吸附距离太长）。
 *
 * 新口径 = **落在长条上**：条半高 + 1px 缓冲，再夹进 [2, pitch/2]（上限保证不抢邻条，
 * 下限保证最密节距也点得中）。pitch=9 → 3.5px（旧 8px，缩短 56%）；pitch=4 → 2px。
 */
export function railHitRadius(pitch: number): number {
  const halfBar = railBarHeight(pitch) / 2;
  return Math.max(HIT_MIN, Math.min(halfBar + HIT_SLOP, pitch / 2));
}

/**
 * 留白带宽：.mcol 左缘 − #main 左缘（rect 由调用方传入 ⇒ 本模块零 DOM）。
 * 量不到 .mcol 时回落「主区宽 − 24」，与改动前逐字一致。
 */
export function railGutterWidth(mainLeft: number, mainWidth: number, colLeft: number | null): number {
  if (colLeft === null) return Math.max(0, mainWidth - 24);
  return Math.max(0, colLeft - mainLeft);
}

/** 横向档位（留白带宽 → 轨道是否隐藏 / 是否细档 / 条带宽度与左缘）。 */
export interface RailLane {
  hidden: boolean;
  thin: boolean;
  left: number;
  width: number;
}

/** 留白带宽 → 横向档位。宽度/左缘算式与改动前逐字一致（纯搬家）。 */
export function railLane(gutter: number): RailLane {
  if (gutter < RAIL_GUTTER_HIDE) return { hidden: true, thin: false, left: 8, width: 0 };
  const thin = gutter < RAIL_GUTTER_NORMAL;
  const width = thin ? Math.max(6, gutter - 24) : Math.min(RAIL_MAX_W, gutter - 26);
  return { hidden: false, thin, left: 8, width };
}

/** 纵向节距：可用高 / 条数，夹在 [RAIL_PITCH_MIN, RAIL_PITCH_NATURAL]（纯搬家）。 */
/** 条数 × 最密节距是否装得下（装得下 = 全部显示，否则走视口窗口）。 */
export function railFitsAll(usable: number, count: number): boolean {
  return count * RAIL_PITCH_MIN <= usable;
}

export function railPitch(usable: number, count: number): number {
  const n = Math.max(1, count);
  return Math.max(RAIL_PITCH_MIN, Math.min(RAIL_PITCH_NATURAL, usable / n));
}

/**
 * fisheye 增益：距条心 d 时的吸附强度 ∈ [0, 1]（d ≥ range 即 0）。
 * 纯函数，rail.ts 的 setGrow / applyMove 共用同一口径。
 */
export function railGrow(distance: number, range: number = RAIL_FISHEYE_RANGE): number {
  if (!(range > 0)) return distance === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - distance / range));
}

/**
 * 长条宽度：静止 RAIL_BASE_W → 满吸附时按轨道可用宽插值；满吸附（k ≥ 1）再加命中加成。
 * 与 rail.ts 的 setGrow 逐字同式（纯搬家）。
 */
export function railBarWidth(grow: number, railW: number): number {
  const k = Math.max(0, Math.min(1, grow));
  return RAIL_BASE_W + k * Math.max(0, railW - RAIL_BASE_W) + (k >= 1 ? RAIL_HIT_BOOST : 0);
}

/** 长条不透明度：静止 → 吸附线性插值。 */
export function railBarOpacity(grow: number): number {
  const k = Math.max(0, Math.min(1, grow));
  return RAIL_BASE_OPACITY + (0.7 - RAIL_BASE_OPACITY) * k;
}

/** 预览卡宽度（px）—— rail.ts 的横向 clamp 与 styles/rail.css 的 width 共用同一值。 */
export const RAIL_CARD_W = 280;

/**
 * W871：预览卡的落位（**视口坐标**，纯函数）。
 *
 * 为什么做成纯函数：卡片宿主是 document.body、position: fixed（styles/rail.css），
 * 所以 style.top/left 必须直接是视口坐标 —— 而 railTop / railX / mainW 都在 #main 的
 * 坐标系里。真机实测的错法：直接把「相对 #main」的 left=88 写进 fixed 卡片，浏览器
 * 当成视口 x=88 ⇒ 卡片落到侧栏、与长条错开 242px。
 *
 * 输入：mainX/mainY = #main 视口左/上缘；mainW = #main 宽；railTop/railH/railX = 轨道
 * 在 #main 内的位置与尺寸；anchor 与 cardH = 长条的视口 rect 与卡片高。
 * 输出：{ top, left } —— 纵向夹进轨道（上下各留 4px），横向贴长条右侧 +8px、
 * 且不超过 mainX + mainW − RAIL_CARD_W。与 W238 的口径逐字一致（只换了坐标系）。
 */
export function railCardPlacement(input: {
  mainX: number;
  mainY: number;
  mainW: number;
  railTop: number;
  railH: number;
  railX: number;
  anchor: { top: number; right: number };
  cardH: number;
}): { top: number; left: number } {
  const relTop = input.anchor.top - input.mainY;
  const top = Math.max(input.railTop + 4, Math.min(relTop, input.railTop + input.railH - input.cardH - 4));
  const relLeft = Math.min(input.anchor.right - input.mainX + 8, input.mainW - RAIL_CARD_W);
  return { top: input.mainY + top, left: input.mainX + Math.max(input.railX + 4, relLeft) };
}
