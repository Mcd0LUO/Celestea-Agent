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
// ============================================================================
import type { SessionPane } from '../viewctx';
import { railDropCols } from '../rail';

/**
 * 单容器保留的消息列上限。
 *
 * 取 600：真实会话里一条工具调用就是一条列（.mcol），一个 200 轮的会话轻易到
 * 1000+ 列；600 足够覆盖「往回翻几屏」的真实阅读需求，又把 DOM 规模钉在常数上。
 */
export const MAX_DOM_COLS = 600;
/** 一次回收多少条（批量回收，避免每来一条就动一次 DOM）。 */
export const DOM_PRUNE_BATCH = 100;
/**
 * 两次扫描之间的最小间隔（ms）。裁剪是**安全阀**而不是每帧不变量：`querySelectorAll`
 * 要遍历容器里全部节点，在流式渲染（每 12ms 一次）里每 tick 都扫一遍是纯浪费。
 * 用时间窗把它摊薄；force=true 供恢复收尾与测试使用。
 */
export const PRUNE_INTERVAL_MS = 1000;

/** 上次扫描时刻（每容器一份；容器被 GC 时随之消失）。 */
const lastRun = new WeakMap<SessionPane, number>();

/** 裁剪判定与执行（纯 DOM 操作 + rail 记账同步）。返回本次回收的条数。 *//** 裁剪判定与执行（纯 DOM 操作 + rail 记账同步）。返回本次回收的条数。 */
export function prunePaneDom(ctx: SessionPane, force = false): number {
  const now = Date.now();
  if (!force && now - (lastRun.get(ctx) ?? 0) < PRUNE_INTERVAL_MS) return 0;
  lastRun.set(ctx, now);
  const cols = Array.from(ctx.el.querySelectorAll<HTMLElement>('.mcol'));
  const excess = cols.length - MAX_DOM_COLS;
  if (excess <= 0) return 0;
  const doomed = cols.slice(0, Math.min(excess, DOM_PRUNE_BATCH));
  if (doomed.length === 0) return 0;
  // 先把长条记账摘干净（长条按列的 rect 定位，列没了它就没有意义），再摘节点。
  railDropCols(ctx, doomed);
  // 连续区间删除：从首条到末条的下一个兄弟为止（中间的注释哨兵/分隔线一并清掉）。
  const first = doomed[0]!;
  const parent = first.parentNode;
  if (parent === null) return 0;
  const stop = doomed[doomed.length - 1]!.nextSibling;
  let node: Node | null = first;
  while (node !== null && node !== stop) {
    const next: Node | null = node.nextSibling;
    parent.removeChild(node);
    node = next;
  }
  return doomed.length;
}
