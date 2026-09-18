// ============================================================================
// ui/rail-doc.ts — W872：灵动选择条读**消息文档坐标**的唯一口径（零状态、纯取值）。
// ----------------------------------------------------------------------------
//   yDoc(轮) = 该轮消息列 rect.top − 消息区 rect.top + msgsEl.scrollTop + 半个高度
//   —— 「消息滚动内容坐标系」里的 Y：滚动不改它，只改视口。
//
// 中间判定（./rail-center.ts 的 railCenterHit）与超长会话的可见窗口（viewWindow）
// 共用这一套，保证「视口中央落在哪一根」与「只渲染视口附近条目」量的是同一根尺子：
// 视口中央 = msgsEl.scrollTop + railH / 2，与 yDoc 同坐标系。
//
// 为什么单独成模块（同 ./rail-geom.ts 的先例）：rail.ts 受模块体积棘轮约束，
// 这里只读 rect / scrollTop，不写 DOM、不留状态，可被直接断言。
// ============================================================================

/** 条目在可见窗口判定里需要的最小形状（ui/rail.ts 的 RailItem 是它的超集）。 */
export interface DocItem {
  startCol: HTMLElement;
}

/** 消息列中心在滚动内容里的 Y（rect 法，不依赖 offsetParent）。 */
export function docCenterY(msgsEl: HTMLElement, startCol: HTMLElement): number {
  const v = msgsEl.getBoundingClientRect();
  const c = startCol.getBoundingClientRect();
  return c.top - v.top + msgsEl.scrollTop + c.height / 2;
}

/** 超长会话：只取视口上下各 ~0.2 屏范围内的条目（跟随可见区域）。 */
export function viewWindow<T extends DocItem>(
  msgsEl: HTMLElement,
  railH: number,
  items: readonly T[],
): T[] {
  const st0 = msgsEl.scrollTop;
  const lo = st0 - railH * 0.2;
  const hi = st0 + railH * 1.2;
  return items.filter((it) => {
    const y = docCenterY(msgsEl, it.startCol);
    return y >= lo && y <= hi;
  });
}
