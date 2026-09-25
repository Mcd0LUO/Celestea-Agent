// ============================================================================
// ui/messages/cadence.ts — W867：流式正文的**渲染节拍**状态（纯状态工厂，零 DOM）。
//
//   为什么单独成模块：这些字段与「什么时候重排一次」的策略强相关，读写方**只有**
//   ui/messages/assistant.ts 的 scheduleTextView / flushTextView / resetMessages；
//   把它们从 ui/viewctx.ts（模块体积棘轮盯着的文件）搬出来，字段语义一字未变。
//
//   deadline 的哨兵语义（W867 的核心）：**-Infinity = 「还没渲染过」** → 第一帧走
//   leading 立即渲染。用 0 会在页面刚加载的头十几毫秒里被当成「窗口内的后续帧」而被
//   推迟一个窗口（jsdom 测试与冷启动同一口径）。
//
// ----------------------------------------------------------------------------
// W1524：窗口从**固定 12ms** 改成**跟着上一次渲染的实测耗时自适应**。
//
//   实测到的缺陷（CDP 真机，1440×900，120 帧突发流，突发 4 帧 / 100ms）：
//     代码形态（未闭合围栏 → 尾部每拍重建 + hljs 每拍重高亮）下单次 renderTextView
//     实测 ≈12ms，而合并窗口也是 12ms —— 于是「渲染耗时 ≥ 窗口」时，下一次增量到达
//     时 now - deadline 已经 ≥ 窗口，**leading 分支再次命中**，窗口什么都合并不了。
//     LoAF 归因直接抓到：同一个 64ms 帧里有 4 个 invoker=EventSource.ontext 的脚本，
//     各 11.6~14.5ms —— 一个突发 4 帧 = 4 次同步全量渲染；全程 13 个长帧、最长 89.5ms、
//     长帧总时长 971ms。
//
//   修法（自限速 / self-pacing）：窗口 = clamp(上次渲染实测耗时 × RENDER_DUTY, 12ms, 50ms)。
//     乘 RENDER_DUTY(=2) 是关键：窗口**恰好等于**耗时时 leading 仍会每次命中（第一版就是
//     这么写的，实测 renders 164→168 纹丝不动，见 RENDER_DUTY 的注释）；乘 2 才把渲染
//     占空比钉在 ≤50%，突发里的连续重排被打散到不同帧。下限保证轻内容仍按 ~1 帧的节奏
//     出字（W867 的观感不变），上限保证最坏情况下用户也不会等超过 ~3 帧（50ms）。
//
//   这是**反馈控制**而不是又拍一个魔数：窗口由运行时实测得出，不假设渲染有多贵。
// ============================================================================

/** 每容器的文本段渲染节拍（字段名与取值语义与搬迁前逐字一致）。 */
export interface RenderCadence {
  /** 已排队的尾部渲染定时器（null = 没有排队；见 assistant.scheduleTextView）。 */
  timer: number | null;
  /** 上一次真正渲染的**开始**时刻；-Infinity = 从未渲染过（首帧立即渲染的判据）。 */
  deadline: number;
  /**
   * 上一次真正渲染的**实测耗时**（ms；0 = 从未渲染过）。
   *
   * W1524 新增。只用于算下一次的合并窗口 —— 它是「这台机器 + 这段内容」的真实代价，
   * 比任何写死的常数都准。取**最近一次**而不是峰值：内容变轻时窗口要立刻跟着变小，
   * 否则会白白多等（峰值保持会让一次慢渲染拖慢其后所有帧）。
   *
   * ★ 可选：既有的测试夹具（tests/w1485-background-freeze、tests/w1467-subcall-live-replay）
   *   自己拼 { timer, deadline } 字面量当容器用，把本字段设成必填会平白改坏它们。
   *   缺省 = 「没测到」→ 窗口取下限，与 W867 的固定窗口逐字等价（向后兼容而非降级）。
   */
  cost?: number;
}

/** 新容器的初始节拍：没有排队、从未渲染过、没有实测代价。 */
export function newRenderCadence(): RenderCadence {
  return { timer: null, deadline: Number.NEGATIVE_INFINITY, cost: 0 };
}

/**
 * 目标占空比的分母：**窗口 = 上次渲染耗时 × 2** ⇒ 主线程最多一半时间花在重排上。
 *
 * 为什么必须乘这个 2（而不是「窗口 = 耗时」）：窗口恰好等于耗时时，下一次增量到达的
 * 那一刻 now - deadline 刚好 ≈ 耗时 = 窗口 → leading 分支**再次命中**，窗口一次都合并不
 * 了。这不是理论推演，是实测：第一版取 clamp(cost, 12, 50)，code 形态下 renders 164→168
 * （纹丝不动），因为实测 cost ≈12ms 恰好等于下限 12ms。
 * 乘 2 之后「渲染 12ms → 下一次最早 24ms 后再渲染」，突发里排队的增量才有机会并进来。
 */
export const RENDER_DUTY = 2;

/**
 * 自适应窗口的上限（ms）。取 50 ≈ 3 帧：宁可让占空比偶尔超过 50%（渲染比 50ms 还贵
 * 时），也不让用户盯着不动的正文等更久。
 */
export const RENDER_WINDOW_MAX = 50;

/**
 * 合并窗口（ms）= clamp(上次渲染实测耗时 × RENDER_DUTY, 下限, 上限)。纯函数，便于单测与变异。
 *
 * @param costMs 上一次渲染的实测耗时（非有限值 / ≤0 一律按「没测到」处理 → 用下限）
 * @param floorMs 下限（= RENDER_DEBOUNCE，≈1 帧）
 * @param maxMs 上限（默认 RENDER_WINDOW_MAX）
 */
export function mergeWindow(costMs: number | undefined, floorMs: number, maxMs: number = RENDER_WINDOW_MAX): number {
  // undefined / NaN / Infinity / ≤0 一律按「没测到」处理 → 窗口取下限（W867 的等价行为）
  const measured = typeof costMs === 'number' && Number.isFinite(costMs) && costMs > 0 ? costMs : 0;
  const ceil = Math.max(floorMs, maxMs);
  return Math.min(Math.max(floorMs, measured * RENDER_DUTY), ceil);
}

/**
 * 距离「下一次允许渲染」还要等多久（ms；0 = 现在就可以渲染）。
 *
 * deadline 为 -Infinity（从未渲染）时恒返回 0 —— 首帧立即渲染的哨兵语义原样保留。
 */
export function waitFor(now: number, cadence: RenderCadence, floorMs: number): number {
  return Math.max(0, cadence.deadline + mergeWindow(cadence.cost, floorMs) - now);
}
