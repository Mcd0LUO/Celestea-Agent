// ============================================================================
// ui/messages/think-budget.ts — W1512：会话级**思考文本预算**（纯状态，零 DOM）
// ----------------------------------------------------------------------------
// 为什么单段上限不够（W1505 只堵了一半）：THINK_RENDER_LIMIT 管一段，而**段数无界**
// —— 每步（工具调用之间）flush 一段。真实 Chromium 实测每 tick（重写正文 +
// autoscroll）的代价：
//
//   | 容器内思考文本 | 折叠态 | 展开态（流式期间的常态）|
//   |----------------|--------|------------------------|
//   |  6.3 MB (100段)| 0.28ms |  21.0 ms               |
//   | 18.8 MB (300段)| 0.30ms |  52.9 ms               |
//   | 37.5 MB (600段)| 0.48ms | **104.8 ms**           |
//
// 折叠态便宜是因为 CSS 是 display:none（不参与布局）；而 W752 让**流式段自动展开**，
// 于是每个 SSE 增量都付一次全容器布局 —— 105 ms 的同步布局 × 每节拍 = 主线程钉死，
// 正是用户报的「长思考块仍会卡死」。
//
// 本模块只持有**账本**（每容器保留了多少字符）；回收动作（折起 + 释放正文）需要 DOM
// 零件，留在 ui/messages.ts。拆开也顺手满足前端模块体积门禁（该门禁按原始行数计，
// 注释同样计费）。
// ============================================================================

/**
 * 单个会话容器里所有思考段**保留**的文本总量上限（字符）。
 *
 * 取 256 K（约 4 个满段）：远超用户真正会读的量（真实日志 155 个思考段只有 1 个超过
 * 64 K），同时把展开态每 tick 压在约 1 ms 量级（21 ms @ 6.3 MB 的线性外推）。
 * 按**段数**记账会让长段失控，所以按字符。
 */
export const THINK_CONTAINER_LIMIT = 262144;

/** container 到已保留思考字符数的账本（只增只减，不重算）。 */
const thinkBudget = new WeakMap<HTMLElement, number>();

/** 已保留量（预算判定 + 测试观测）。 */
export function thinkRetained(container: HTMLElement): number {
  return thinkBudget.get(container) ?? 0;
}

/** 记一笔保留量（新增或回收后调用）。 */
export function addThinkRetained(container: HTMLElement, delta: number): void {
  thinkBudget.set(container, Math.max(0, (thinkBudget.get(container) ?? 0) + delta));
}

/** 是否已超预算（调用方据此决定要不要回收）。 */
export function thinkOverBudget(container: HTMLElement): boolean {
  return thinkRetained(container) > THINK_CONTAINER_LIMIT;
}
