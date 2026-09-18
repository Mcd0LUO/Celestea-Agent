// ============================================================================
// ui/messages/cadence.ts — W867：流式正文的**渲染节拍**状态（纯状态工厂，零 DOM）。
//
//   为什么单独成模块：这两个字段与「什么时候重排一次」的策略强相关，读写方**只有**
//   ui/messages/assistant.ts 的 scheduleTextView / flushTextView / resetMessages；
//   把它们从 ui/viewctx.ts（模块体积棘轮盯着的文件）搬出来，字段语义一字未变。
//
//   deadline 的哨兵语义（W867 的核心）：**-Infinity = 「还没渲染过」** → 第一帧走
//   leading 立即渲染。用 0 会在页面刚加载的头十几毫秒里被当成「窗口内的后续帧」而被
//   推迟一个窗口（jsdom 测试与冷启动同一口径）。
// ============================================================================

/** 每容器的文本段渲染节拍（字段名与取值语义与搬迁前逐字一致）。 */
export interface RenderCadence {
  /** 已排队的尾部渲染定时器（null = 没有排队；见 assistant.scheduleTextView）。 */
  timer: number | null;
  /** 上一次真正渲染的时刻；-Infinity = 从未渲染过（首帧立即渲染的判据）。 */
  deadline: number;
}

/** 新容器的初始节拍：没有排队、从未渲染过。 */
export function newRenderCadence(): RenderCadence {
  return { timer: null, deadline: Number.NEGATIVE_INFINITY };
}
