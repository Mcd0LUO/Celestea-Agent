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

// ---- W9113：列 → 保留正文长度的登记（供 dom-cap 的摘列回收减账） ----------------
//
// 为什么这份登记住在账本模块：`dom-cap.ts` 摘思考列时要**按列**把保留量减回去，
// 而「列 → 思考段」的映射本来在 ui/messages.ts 的 thinkFolds 里。让 dom-cap 去
// import ui/messages.ts 会形成 messages → assistant → dom-cap → messages 的**循环
// 依赖**（lint:arch 的 depcruise 会红）。所以只把「需要多少字符」这一面对外开放：
// 登记用结构类型，ThinkSegDom 天然满足，不需要把整个零件类型搬过来。

/** 账本只需要知道「这一段现在保留了多少字符」。 */
export interface ThinkLedgerEntry {
  /** 保留的思考正文（W1505 起它的长度上限就是 THINK_RENDER_LIMIT）。 */
  text: string;
}

/** root（.mcol）→ 该思考段的保留量来源（随节点一起被 GC）。 */
const ledgerEntries = new WeakMap<HTMLElement, ThinkLedgerEntry>();

/** 登记一个已构建的思考段（buildThinkSeg 里调一次；同 root 幂等覆盖）。 */
export function registerThinkSeg(root: HTMLElement, entry: ThinkLedgerEntry): void {
  ledgerEntries.set(root, entry);
}

/**
 * 该列当前**保留**的思考正文字符数（0 = 不是思考列，或正文已被回收）。
 *
 * W9113：摘列时用它把账本减回去 —— 与 pruneToolCards 的「节点归属」判据对称。
 */
export function retainedThinkChars(root: HTMLElement): number {
  return ledgerEntries.get(root)?.text.length ?? 0;
}
