// ============================================================================
// ui/messages/frame-budget.ts — W9113：SSE 帧 → UI 的**帧内预算**（纯状态，零 DOM）
// ----------------------------------------------------------------------------
// 症状（W9111 真机 CDP 实测，见 results/W9111.md §5/§6 P0-1）：每 step 3 帧
// （tool + tool_result + text）、间隔 4–6 ms 时，出现 **7.9–9.4 秒的单帧冻结**，
// 期间页面完全无响应。LoAF 归因：一个帧里挤了 **584 个** EventSource 回调
// （ontool 4196ms + ontext 3239ms + ontool_result 1546ms）。
//
// 根因：帧内回调**串行**执行，每个回调都要写 DOM 并强制一次同步布局
// （autoscroll 写 scrollTop = scrollHeight、prunePaneDom 的 querySelectorAll、
// renderTextView 的读写）。Chromium 无法在中途让出，于是 N 个回调被合并成一个
// N×cost 的帧。**改动前没有任何「每帧预算」或「事件合并」机制。**
//
// 修法（自限速，与 ./cadence.ts 同一思路）：一帧里最多内联处理 K 个事件，其余按
// **原顺序**排到后续帧。
//
// ★ K 是**事件数**上限，不是「本帧已花的毫秒数」上限。这是本模块最重要的一条设计
//   约束，第一版在这里翻过车，必须写清楚：
//
//   第一版把 K 写成「每次 push 都用刚测到的**那一个**事件的耗时代入」。在负载高的
//   机器上，jsdom 里一个事件能测出 ~5ms → K 立刻掉到 2 —— 于是「同一个同步循环里
//   投递的 14 个事件」只有 2 个落地、其余排队。而 W867 / W895-R 的门禁是**同一调用
//   栈内**读结果的（它们编码的正是「事件到达即渲染」这条既有契约），于是同一份代码
//   在本机全绿、在负载机上 4 条红：**行为取决于机器快慢**，这是不可接受的。
//
//   修法 = 把控制周期钉成**一帧**：
//     · 帧开始时冻结 K，帧内**不**随新测量变化；
//     · K 的唯一输入是**上一帧的每事件均值**（不是一个事件的瞬时值）；
//     · 帧内只记「处理了几个」，不做任何与当前耗时挂钩的早退。
//   冻结之后，一帧的 K 只取决于它**之前**那一帧的真实代价 —— 快机器与慢机器在同一个
//   输入序列上给出同一个调度决策。cadence.ts 的「窗口 = 上一次渲染耗时」是同一条
//   反馈控制，同一个控制周期；帧内改 K 等于在一个控制周期里改控制器增益，只会震荡。
//
// ★ 为什么「保序」是硬不变量：一旦本帧有任何事件被排队，其后**所有**事件都必须排队
//   （见 push 的第一个判据）。否则「工具卡」会排到它的「工具结果」之后 —— 卡片先建、
//   结果先回填，DOM 顺序与事件顺序分叉。
//
// ★ 为什么前 K 个事件仍然**同步**执行（而不是一律丢进下一帧）：这是「近似立即」的既有
//   契约（W867 的门禁按「同一调用栈内可见」计）。只有**超出预算**的尾部才排队 ——
//   正常速率（一帧几个事件）与改动前逐字等价，只有病态突发才被切开。
//
// ★ 事件**只延后，绝不丢弃**：queue 只增（push）只减（帧内 shift 执行），没有任何
//   丢弃分支。W895-R「实时 ↔ 重放逐字一致」这条硬契约就是这条性质的机械兜底。
//
// ★ 为什么不在 SseClient 里做（transport 层）：预算管的是**UI 工作量**，而 SseClient
//   的契约是「解析 + 分发」。放在 chat.ts 的接线层，才能保证同一条总线上的
//   status/text/thinking/tool/tool_result/done 共用一个队列（跨事件名保序）。
// ============================================================================

/**
 * 一个动画帧里最多花多少毫秒处理事件。
 *
 * 取 12：≈ 60fps 帧预算（16.7ms）的三分之二，剩下的留给样式/布局/绘制。
 * 与 cadence.ts 的 RENDER_DEBOUNCE 同为「下限」性质的常数，实际 K 由实测代价反推。
 */
export const FRAME_BUDGET_MS = 12;

/**
 * 单帧事件数**硬顶**。
 *
 * 为什么需要它：代价测量有下限（performance.now 的分辨率、单次事件真的 <0.1ms），
 * 只按时间反推的话「一帧 5000 个 0.001ms 的事件」仍然会被放行。硬顶把「一帧的
 * 回调数量」也钉在常数上 —— W9111 实测的病态帧是 584 个回调，64 是它的十分之一。
 */
export const MAX_EVENTS_PER_FRAME = 64;

/**
 * 纯函数：给定「每事件的实测代价」，一帧内最多内联处理多少个事件。
 *
 * @param costMs 上一帧的每事件均值（非有限值 / ≤0 一律按「没测到」处理 → 用硬顶）
 */
export function frameAllowance(
  costMs: number | undefined,
  budgetMs: number = FRAME_BUDGET_MS,
  maxPerFrame: number = MAX_EVENTS_PER_FRAME,
): number {
  const measured = typeof costMs === 'number' && Number.isFinite(costMs) && costMs > 0 ? costMs : 0;
  if (measured === 0) return maxPerFrame; // 没测到 → 不限流（与改动前等价）
  return Math.min(maxPerFrame, Math.max(1, Math.floor(budgetMs / measured)));
}

export interface FrameBudgetStats {
  /** 本帧已内联处理的事件数。 */
  inlineThisFrame: number;
  /** 还在排队等下一帧的事件数。 */
  queued: number;
  /** 已经开始的帧数（诊断用）。 */
  frames: number;
  /** 本帧冻结的 K（诊断用）。 */
  cap: number;
}

export interface FrameBudgetOptions {
  budgetMs?: number;
  maxPerFrame?: number;
  /** 单调时钟（测试注入假时钟）。 */
  now?: () => number;
  /** 排一次「下一帧」（测试注入假调度器）。 */
  schedule?: (cb: () => void) => void;
}

export interface FrameBudget {
  /**
   * 投递一个回调。本帧还有预算 → **同一调用栈内执行**并返回 true；
   * 否则入队、排下一帧、返回 false（顺序与投递顺序一致；**永不丢弃**）。
   */
  push(run: () => void): boolean;
  /** 只读观测（测试与诊断）。 */
  stats(): FrameBudgetStats;
}

/**
 * 默认调度器：**宏任务**（setTimeout 0），不是 requestAnimationFrame。
 *
 * 三条理由，每条都对应一个真实的坑：
 *   ① 真正要消灭的是「**一个任务**里跑 584 个回调」。拆成多个宏任务，浏览器在任务
 *      边界上有真实的渲染机会 —— 每个批次被 K 钉住，与改动前的「一个 9 秒任务」是
 *      本质区别。rAF 只是把批次对齐到帧，而宏任务边界同样能拿到帧，且不依赖宿主实现。
 *   ② 隐藏标签页里 **rAF 不触发**：只用 rAF 会让队列一直积压，用户切回来时一次性
 *      补几百个事件 —— 那正是 W1485 修过的「切回即卡死」。宏任务被节流到 ≥1s 但
 *      **会**跑，队列因此始终有界。
 *   ③ 本仓测试与宿主用「排空宏任务」同步（W867 / W895-R 的门禁都是 `await flush()`
 *      即若干 setTimeout(0)）。rAF 在 jsdom 里挂在 ~16ms 定时器上，会让这套既有口径
 *      全部失效 —— 那不是「测试要改」，而是**新机制不该把可观测性从宿主手里拿走**。
 */
function defaultSchedule(cb: () => void): void {
  setTimeout(cb, 0);
}

/** 建一个帧内预算器（每条 SSE 总线一个；chat.ts 持有一个）。 */
export function createFrameBudget(opts: FrameBudgetOptions = {}): FrameBudget {
  const budgetMs = opts.budgetMs ?? FRAME_BUDGET_MS;
  const maxPerFrame = opts.maxPerFrame ?? MAX_EVENTS_PER_FRAME;
  const now = opts.now ?? ((): number => performance.now());
  const schedule = opts.schedule ?? defaultSchedule;

  const queue: Array<() => void> = [];
  /** 上一帧的**每事件实测均值**（0 = 还没测到）。下一帧 K 的唯一输入。 */
  let frameCost = 0;
  /** 本帧冻结的 K（只在帧开始时重算；帧内绝不改 —— 见模块头）。 */
  let cap = frameAllowance(0, budgetMs, maxPerFrame);
  /** 本帧已处理的事件数与累计耗时（只用于结算 frameCost）。 */
  let count = 0;
  let spent = 0;
  let scheduled = false;
  let frames = 0;

  function ensureScheduled(): void {
    if (scheduled) return;
    scheduled = true;
    schedule(onFrame);
  }

  /** 下一帧：先结算上一帧的实测代价并**冻结**本帧的 K，再按顺序吐出至多 K 个。 */
  function onFrame(): void {
    scheduled = false;
    frames += 1;
    // 结算上一帧：用**每事件均值**。取最近一帧而不是峰值 —— 内容变轻时 K 要立刻跟着
    // 变大，峰值保持会让一次慢事件拖慢其后所有帧（与 cadence.ts 取 cost 同一取舍）。
    if (count > 0) frameCost = spent / count;
    count = 0;
    spent = 0;
    cap = frameAllowance(frameCost, budgetMs, maxPerFrame);
    while (queue.length > 0 && count < cap) {
      const run = queue.shift() as () => void;
      const t0 = now();
      run();
      spent += now() - t0;
      count += 1;
    }
    if (queue.length > 0) ensureScheduled();
  }

  return {
    push(run: () => void): boolean {
      // ★ 保序硬不变量：已有积压 ⇒ 一律排队（不许插队到队首之前的事件前面）。
      // ★ 早退判据只有 `count >= cap`（本帧冻结的 K），**不含**任何与「刚刚那个事件
      //   花了多久」挂钩的项 —— 那正是第一版翻车的形状（见模块头）。
      if (queue.length > 0 || count >= cap) {
        queue.push(run);
        ensureScheduled();
        return false;
      }
      const t0 = now();
      run();
      spent += now() - t0;
      count += 1;
      return true;
    },
    stats(): FrameBudgetStats {
      return { inlineThisFrame: count, queued: queue.length, frames, cap };
    },
  };
}
