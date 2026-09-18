// ============================================================================
// ui/rail-center.ts — 灵动选择条的**中间判定**（W872 · 视口中间指示）
// ----------------------------------------------------------------------------
// 用户要的能力：「**轨道条带上标记出视口中间对应的位置**」—— 常驻指示「我现在读到
// 哪一轮 / 哪几轮在视口里」。
//
// 坐标口径（唯一真源；rail.ts 只提供取值、不参与算）：
//   · 轨道内容坐标 yDoc —— 与 ui/rail.ts 的 docCenterY 逐字同一套：
//         yDoc(轮) = 该轮消息 rect.top − 消息区 rect.top + msgsEl.scrollTop + 半个高度
//     即「消息滚动内容坐标系」里的 Y（滚动不改它，只改视口）。
//   · 视口中央在**同一坐标系**里的值 yMid = scrollTop + 视口高 / 2
//     （消息区视口 = 轨道几何，见 ui/rail.ts 的 layout()：railTop/railH 直接取自它）。
//   · 命中 = 与 yMid 距离最近的**那一根长条**（唯一的「中间判定」）。为什么不做
//     「条间空隙不算命中」的第二套判定：本仓的吸附半径（rail-geom.railHitRadius）是
//     **指针**命中口径，与滚动位置无关；这里只回答「视口中央离哪一轮最近」，多一套
//     空隙规则只会让常驻指示时有时无。
//
// 指示线的位置：在 doc 坐标里**在相邻两根之间线性插值**后落到轨道坐标（轨道条带是
//   整段会话的示意图 —— 超长会话只渲染视口附近条目，此时按可见条目的覆盖范围插值）。
//   条与条之间的空隙如实显示，不做任何吸附/偏移。
//
// 端点兜底（视口中央落在第一轮之前 / 最后一轮之后，例如刚进页、滚到底）：
//   线**夹在首/末条心**（不像素级外推、不消失、不越出轨道），并置 clamped = true
//   —— rail.ts 据此清掉「居中」态（此时没有哪一轮真的在视口中央）并把线降一档对比。
//   位置随内容连续变化，所以端点态不会来回抖动。
//
// 性能口径：本模块**零 DOM、零状态**（纯函数）。滚动/重排时由 rail.ts 的既有 rAF
//   节流每帧调用一次，只写一个 transform 值 + 一个类（不重建 DOM、不写几何）。
// ============================================================================

/** 一根长条在中间判定里的输入：轨道内条心 + 消息滚动内容坐标里的条心。 */
export interface RailCenterItem {
  /** layout() 算出的条心（相对轨道顶，px）。 */
  y: number;
  /** 同一根条在消息滚动内容坐标里的条心（yDoc，见文件头）。 */
  yDoc: number;
}

/** 中间判定结果（rail.ts 用它写 DOM：一条线 + 一个「居中」类）。 */
export interface RailCenterHit<T> {
  /** 命中的条目（null = 端点之外 / 没有条可判）。 */
  item: T | null;
  /** 指示线位置，相对轨道顶（px）。 */
  y: number;
  /** 视口中央是否落在端点之外（true 时 item = null，线停在首/末条心）。 */
  clamped: boolean;
  /** 命中的轮次序号（1 起，含折叠条时的可见序号）；-1 = 无命中。 */
  round: number;
}

/**
 * 视口中间判定。items **必须按时间自上而下**（= rail.ts 的 shown 顺序）。
 * yMid = 消息滚动内容坐标里的视口中央。
 */
export function railCenterHit<T extends RailCenterItem>(
  items: readonly T[],
  yMid: number,
): RailCenterHit<T> | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return null;
  // 端点之外：线夹在首/末条心（如实停在端点，不消失、不越界）
  if (yMid < first.yDoc) return { item: null, y: first.y, clamped: true, round: -1 };
  if (yMid > last.yDoc) return { item: null, y: last.y, clamped: true, round: -1 };
  // 最近的一根 = 命中（同距取靠上的一根，避免边界上左右横跳）
  let best = first;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const d = Math.abs(yMid - it.yDoc);
    if (d < bestD) {
      bestD = d;
      best = it;
      bestI = i;
    }
  }
  // 线位置：在相邻两根之间按 doc 坐标线性插值（落在条心上时就是条心）
  let a = first;
  let b = last;
  for (const it of items) if (it.yDoc <= yMid) a = it;
  for (const it of items) {
    if (it.yDoc >= yMid) {
      b = it;
      break;
    }
  }
  const span = b.yDoc - a.yDoc;
  const t = span > 0 ? (yMid - a.yDoc) / span : 0;
  return { item: best, y: a.y + t * (b.y - a.y), clamped: false, round: bestI + 1 };
}

/**
 * 中间指示线的悬停文案（用户语言，无实现细节词）。
 * fold > 0 = 命中的是「更早 N 轮已折叠」那根折叠条。
 */
export function railCenterLabel(hit: RailCenterHit<unknown>, fold = 0): string {
  if (hit.clamped) return '视口中间 · 在这几轮之外';
  if (fold > 0) return '更早的 ' + fold + ' 轮（视口中间）';
  return '第 ' + hit.round + ' 轮附近（视口中间）';
}
