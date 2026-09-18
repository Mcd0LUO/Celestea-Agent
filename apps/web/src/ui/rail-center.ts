// ============================================================================
// ui/rail-center.ts — 灵动选择条的**中间判定**（W872 · 视口中间指示；W886 删线）
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
// W886：判定结果只表达为「命中条 .is-center + 该条的悬停文案」。W872 的那条视口
//   中间发丝指示线连同它的位置插值一并删除（用户否掉的是那条线本身，不是判定）——
//   本模块不再计算任何线位置，只回答「命中哪一根 / 是否在端点之外」。
//
// 端点兜底（视口中央落在第一轮之前 / 最后一轮之后，例如刚进页、滚到底）：
//   返回 item = null（rail.ts 据此清掉「居中」态：此时没有哪一轮真的在视口中央）。
//
// 性能口径：本模块**零 DOM、零状态**（纯函数）。滚动/重排时由 rail.ts 的既有 rAF
//   节流每帧调用一次，只切换一个类 + 写一次提示文案（不重建 DOM、不写几何）。
// ============================================================================

/** 一根长条在中间判定里的输入：消息滚动内容坐标里的条心。 */
export interface RailCenterItem {
  /** 同一根条在消息滚动内容坐标里的条心（yDoc，见文件头）。 */
  yDoc: number;
}

/** 中间判定结果（rail.ts 用它切换「居中」类与悬停文案）。 */
export interface RailCenterHit<T> {
  /** 命中的条目（null = 端点之外 / 没有条可判）。 */
  item: T | null;
  /** 视口中央是否落在端点之外（true 时 item = null）。 */
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
  // 端点之外：没有哪一根真的在视口中央（rail.ts 据此不标「居中」）
  if (yMid < first.yDoc) return { item: null, clamped: true, round: -1 };
  if (yMid > last.yDoc) return { item: null, clamped: true, round: -1 };
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
  return { item: best, clamped: false, round: bestI + 1 };
}

/**
 * 中间判定的悬停文案（用户语言，无实现细节词）。
 * fold > 0 = 命中的是「更早 N 轮已折叠」那根折叠条。
 * 注：W886 后端点之外（clamped）没有可挂文案的命中条，此分支保留给纯函数调用方。
 */
export function railCenterLabel(hit: RailCenterHit<unknown>, fold = 0): string {
  if (hit.clamped) return '视口中间 · 在这几轮之外';
  if (fold > 0) return '更早的 ' + fold + ' 轮（视口中间）';
  return '第 ' + hit.round + ' 轮附近（视口中间）';
}
