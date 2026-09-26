// ============================================================================
// ui/messages/dom-cap.ts — 消息容器的 **DOM 上限**（W1485）
// ----------------------------------------------------------------------------
// 症状（用户报障的第三层）：消息容器**没有任何裁剪**，一个跑了几百轮/几千条工具
// 调用的会话会把所有节点永久留在 DOM 里；刷新时 restore.ts 又同步渲染最近 200 条，
// 于是「刷新网页本身也被卡死」。
//
// 修法：只保留最近 MAX_DOM_COLS 条消息列（.mcol），超出的**从头部回收**。
//   · 为什么从头部回收：用户看的是尾部（最新消息），头部是离视口最远的一侧；
//   · 为什么阈值取「条数」而不是「高度」：条数可机械断言（真机 CDP 直接数
//     .mcol），高度依赖字体/换行/窗口宽度，同一份日志在不同窗口下会给出不同结论；
//   · 为什么不虚拟化：DSH 也**刻意不虚拟化**消息列表（稳定身份 + memo + 结构共享），
//     本仓没有那套结构共享，虚拟化会改变滚动几何、破坏 W1467 的贴底闩锁与 rail
//     的文档坐标口径 —— 收益不抵风险。有界回收是同一意图的保守版本。
//
// 副作用（如实记账）：
//   · 被回收的消息在**下次刷新**时会由 restoreSessionHistory 重新渲染（它本来就是
//     从服务端拉的最近 200 条）—— 所以「回收」不是数据丢失，只是视口外的 DOM；
//   · 若某条被回收的消息属于 rail 上的一轮，对应长条必须一起摘掉（否则它按空 rect
//     定位、缩在轨道顶端骗人）—— 见 railDropCols。
//
// ★ W1502 复核补的缺口（重要）：摘 DOM **不等于**释放内存。`ctx.ops` 是
//   `Map<toolCallId, ToolCardRef>`，而 ToolCardRef 持有卡片的 DOM 节点；原先
//   `prunePaneDom` 只 removeChild、从不碰 ops，于是被摘掉的卡片树仍被 Map 强引用
//   —— 绘制有界了，堆没有。更糟的是唯一会清 ops 的两个函数
//   （`resetMessages` / `resetToolCards`）在本仓**零调用者**（死代码），
//   所以 ops 只增不减。主会话独立复现（jsdom，每轮 100 条）：
//       r5: doc=600, ops=600      ← 到达上限
//       r6: doc=600, ops=700      ← DOM 不再增长
//       r11: doc=600, ops=1200    ← 但 ops 持续增长（堆泄漏）
//   修法：裁剪时同步删除「卡片已不在文档里」的 ops 条目（见 pruneToolCards）。
// ============================================================================
import type { SessionPane } from '../viewctx';
import { railDropCols } from '../rail';
// W9113（P1-3）：账本的减账入口。**只依赖账本模块**（不 import ui/messages.ts）——
// 否则 messages → assistant → dom-cap → messages 会成环，lint:arch 的 depcruise 会红。
import { addThinkRetained, retainedThinkChars } from './think-budget';

/**
 * 单容器保留的消息列上限。
 *
 * 取 600：真实会话里一条工具调用就是一条列（.mcol），一个 200 轮的会话轻易到
 * 1000+ 列；600 足够覆盖「往回翻几屏」的真实阅读需求，又把 DOM 规模钉在常数上。
 */
export const MAX_DOM_COLS = 600;
/**
 * 一次回收多少条的**下限**（批量回收，避免每来一条就动一次 DOM）。
 *
 * ★ W9113（P0-2）：这不再是**全部**的回收能力。实测（results/W9111.md §5/§6）：
 *   高速工具流下新增 900 列只要 3.6 秒，而「100 条/秒」要 9 秒才回收完 —— 名义上限
 *   600 要 5–10 秒才收敛，收敛期间 DOM 一路冲到 600+。回收速率是**绝对**的，与新增
 *   速率无关，这才是缺口。现在按超出量自适应（见 [pruneBatchFor]）。
 */
export const DOM_PRUNE_BATCH = 100;
/**
 * W9113：单次回收的**硬顶**。
 *
 * 取 600 = MAX_DOM_COLS。理由：一次扫描最多把「超出上限的量」全部回收掉，绝不多摘
 * —— 上限本身才是那个不该越过的线，单批比它还大没有意义，只会让一次扫描的
 * removeChild 循环变长（那本身就是本任务要消灭的同步工作量）。
 */
export const MAX_PRUNE_BATCH = 600;
/**
 * 两次扫描之间的最小间隔（ms）。裁剪是**安全阀**而不是每帧不变量：`querySelectorAll`
 * 要遍历容器里全部节点，在流式渲染（每 12ms 一次）里每 tick 都扫一遍是纯浪费。
 * 用时间窗把它摊薄；force=true 供恢复收尾与测试使用。
 */
export const PRUNE_INTERVAL_MS = 1000;
/**
 * W9113：超出量超过 [PRUNE_INTERVAL_TIGHTEN_ABOVE] 时把扫描间隔收紧到这个值（ms）。
 *
 * 为什么是 100ms 而不是每帧：`querySelectorAll` 遍历全容器是真实成本，扫描本身不能
 * 变成每帧不变量（见上面那条注释的取舍）。100ms ≈ 6 帧一次 —— 足够把「超出 300+ 列」
 * 这种紧急状态在 ~1 秒内收敛（10 次扫描 × 600 条/次），又不会把扫描塞进每一帧。
 */
export const PRUNE_INTERVAL_TIGHT_MS = 100;
/** 超出量超过多少就收紧扫描间隔（条）。取 300 = MAX_DOM_COLS 的一半。 */
export const PRUNE_INTERVAL_TIGHTEN_ABOVE = 300;

/**
 * W9113（P0-2）：单批回收量 = clamp(excess, DOM_PRUNE_BATCH, MAX_PRUNE_BATCH)。
 *
 * 纯函数（便于单测与变异）。三个性质：
 *   · 超出量**小** → 仍守 [DOM_PRUNE_BATCH] 下限（一次摘一批，不逐条动 DOM）；
 *   · 超出量**大** → 单批跟着超出量涨（新增多快、回收就多快），这正是缺口所在；
 *   · 任何情况不超过 [MAX_PRUNE_BATCH]（一次扫描的同步工作量有界）。
 */
export function pruneBatchFor(excess: number): number {
  if (!Number.isFinite(excess) || excess <= 0) return DOM_PRUNE_BATCH;
  return Math.min(MAX_PRUNE_BATCH, Math.max(DOM_PRUNE_BATCH, Math.floor(excess)));
}

/**
 * W9113（P0-2）：两次扫描之间的间隔（ms）—— 超出量大时收紧到 [PRUNE_INTERVAL_TIGHT_MS]。
 *
 * 判据用**上一次**的超出量（调用方在扫描前无法知道本次超出多少，而扫描前先做一次
 * querySelectorAll 恰恰是节流要避免的成本）。上一次超了 ⇒ 这一次提前扫；收敛后
 * 自动回到常规间隔，不会常驻高频扫描。
 */
export function pruneIntervalFor(lastExcess: number): number {
  return lastExcess > PRUNE_INTERVAL_TIGHTEN_ABOVE ? PRUNE_INTERVAL_TIGHT_MS : PRUNE_INTERVAL_MS;
}

/** 上次扫描时刻（每容器一份；容器被 GC 时随之消失）。 */
const lastRun = new WeakMap<SessionPane, number>();
/** 上次扫描看到的超出量（决定下一次扫描的间隔；见 [pruneIntervalFor]）。 */
const lastExcess = new WeakMap<SessionPane, number>();

/** 裁剪判定与执行（纯 DOM 操作 + rail 记账同步）。返回本次回收的条数。 */
export function prunePaneDom(ctx: SessionPane, force = false): number {
  const now = Date.now();
  // 间隔用「上一次的超出量」判定：必须在 querySelectorAll **之前**早退，否则节流形同虚设。
  if (!force && now - (lastRun.get(ctx) ?? 0) < pruneIntervalFor(lastExcess.get(ctx) ?? 0)) return 0;
  lastRun.set(ctx, now);
  const cols = Array.from(ctx.el.querySelectorAll<HTMLElement>('.mcol'));
  const excess = cols.length - MAX_DOM_COLS;
  lastExcess.set(ctx, Math.max(0, excess));
  if (excess <= 0) return 0;
  const doomed = cols.slice(0, Math.min(excess, pruneBatchFor(excess)));
  if (doomed.length === 0) return 0;
  // 先把长条记账摘干净（长条按列的 rect 定位，列没了它就没有意义），再摘节点。
  railDropCols(ctx, doomed);
  // ★ W9201（P0 修复）：**逐条按 doomed 数组删，不跨父边界**。
  //
  //   旧实现是「连续区间删除」：拿 `doomed[0].parentNode` 当唯一 parent、
  //   `doomed[last].nextSibling` 当 stop，沿 nextSibling 一路 removeChild。
  //   它隐含一条**从未被任何测试碰过**的假设：doomed 全在同一父节点下。
  //   而 W1467 的 run_code 子调用把 `.mcol` **嵌套**进父列的 `.toolcard-subs` 里
  //   （toolcards.ts:278 mountToolCard；restore-tool.ts:72 同构；tooltree.css:15
  //   的注释明写「可再嵌套」），于是 querySelectorAll 的**文档序**是
  //     [顶层父列 A, A 的子列…, 顶层列 B, …]
  //   回收边界一旦落在 A 的子列上：
  //     · 先删 A —— A 的整棵子树（含那些子列）随它一起离开容器；
  //     · `node = A.nextSibling` 已经是**顶层**的 B，而 `stop` 指向一个**已经不在
  //       容器里**的节点 ⇒ `node !== stop` 永远为真 ⇒ 一路删到 `node === null`。
  //   实测（jsdom，直接 import 真实 prunePaneDom；605 个 .mcol，其中一个顶层父列
  //   带 4 个 .toolcard-subs 子列）：childrenBefore=601 → pruned=5 → **childrenAfter=0**；
  //   扁平对照（无嵌套）601 → 600，不受影响。返回值仍是「正常」的条数（5）——
  //   调用方（assistant.ts:158 每节拍、restore.ts:288 收尾）完全无从察觉。
  //   逐条 remove() 与顺序无关、跨父安全，也不再需要 stop/parent 这两个前提。
  //
  //   代价（如实记账）：不再顺手清掉区间里的**非 .mcol 兄弟**（注释哨兵/分隔线）。
  //   本仓没有「每条消息都插一个非 .mcol 哨兵」的路径（.restore-fold / .live-sep
  //   都是每次恢复最多一个），所以这不是一个有界性问题；换来的是不再可能误删整容器。
  for (const col of doomed) col.remove();
  // W1502：**堆也要一起放**。ops 持有卡片的 DOM 节点，只 removeChild 不删 ops 会让
  // 被摘掉的卡片树继续被 Map 强引用（绘制有界、堆无界）。
  // ★ 必须在**摘完节点之后**调用：pruneToolCards 的判据是 `ctx.el.contains(anchor)`，
  //   节点还在容器里时它永远为真，提前调用等于空转（主会话写这段时先踩了一次）。
  const dropped = pruneToolCards(ctx);
  // W9113（P1-3）：思考列的账本也要一起减 —— 与上面 pruneToolCards 完全对称。
  // 改动前 dom-cap.ts 全文**没有任何** addThinkRetained 调用：摘掉思考列时账本不减，
  // 之所以实测没发散，只是因为 enforceThinkBudget 的回收会把账本**反向钳回** DOM 真实值
  // （闭环自纠）。那是副作用而不是记账正确：一旦回收条件放宽（例如只回收折叠段），
  // 账本就会单向偏高、新段被立刻误回收。这里把它变成不变式。
  pruneThinkBudget(ctx, doomed);
  // 返回值语义保持改动前不变（回收的**条数**）：思考列的减账量是字符数，与条数不同量纲，
  // 混进来会让调用方（如 `while (prunePaneDom(...) > 0)`）的读法失真。
  return doomed.length + dropped;
}

/**
 * W9113（P1-3）：摘掉思考列时把保留量从账本里减回去，返回**减掉的字符数**。
 *
 * 判据与 pruneToolCards 同一手法：按**列**（doomed 的 .mcol）而不是全局 querySelectorAll
 * —— 被摘掉的就是这批，逐列查登记表即可（O(doomed)，不遍历全容器）。
 * `retainedThinkChars` 读的是该段当前**还保留着**的正文长度：已被 enforceThinkBudget
 * 回收过的段是 0（正文已释放），此时无需重复减账 —— 这正是「只增只减、不重算」的账本语义。
 *
 * 为什么导出：它是这条不变式的**可观测面**（单测直接调，真机探针也可调）。
 */
export function pruneThinkBudget(ctx: SessionPane, doomed: HTMLElement[]): number {
  let released = 0;
  for (const col of doomed) {
    const chars = retainedThinkChars(col);
    if (chars === 0) continue;
    addThinkRetained(ctx.el, -chars);
    released += chars;
  }
  return released;
}

/**
 * W1502：摘掉「卡片已落在被回收区间里」的 ops 条目，返回删除数。
 *
 * 判定用**节点归属**而不是 id 记账：一个 ops 条目的 ref 可能挂在子卡片
 * （`.toolcard-subs`）上，用 id 反查列需要额外的父子映射；而「这个 ref 的任何一个
 * 节点是否还在文档里」是唯一准确的判据 —— 它在文档里就绝不能删（迟到 result 还要
 * 按 id 回填），不在就一定是本次（或更早）被摘掉的。
 *
 * 只增不删的 ops 是本仓 W1502 实测的堆泄漏来源（见文件头），这里给它配上删除路径。
 */
function pruneToolCards(ctx: SessionPane): number {
  if (ctx.ops.size === 0) return 0;
  let removed = 0;
  for (const [id, ref] of ctx.ops) {
    // ★ 判据必须是 `ctx.el.contains(anchor)`，**不能**用 `anchor.isConnected`：
    //   离屏会话（后台标签）的 pane.el 本身就不在文档里，isConnected 全为 false，
    //   用它会把后台会话的 ops 整批误删 —— 迟到 result 就再也回填不上了。
    //   `contains` 只问「还在不在这个会话容器里」，与 pane 是否离屏无关。
    const anchor = ref.card as unknown as Node;
    if (!ctx.el.contains(anchor)) {
      ctx.ops.delete(id);
      removed += 1;
    }
  }
  return removed;
}
