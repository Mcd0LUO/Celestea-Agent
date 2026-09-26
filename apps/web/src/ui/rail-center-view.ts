// ============================================================================
// ui/rail-center-view.ts — W9106：灵动条「视口中间命中条」的**呈现**（W872 接线）
// ----------------------------------------------------------------------------
// 为什么单独成模块：ui/rail.ts 受模块体积棘轮约束（登记上限只许降不许升），而本轮
// 要给它加「条带预览零停留」（见 ui/rail.ts 的 railHintPlugin.delayMs）。这里把与
// 提示延迟**无关**的一整段（命中条的 .is-center 态与文案、以及它跨会话切换/重置时的
// 复位）纯搬家出来 —— 判定算式仍在 ./rail-center.ts（纯函数），本模块只负责「把判定
// 结果画到一个类 + 一条文案上」，几何一个字都不写。
//
// 语义与搬家前逐字一致：
//   · shown 按时间自上而下；端点之外（视口中央在首/末条之外）命中为 null ⇒ 没有条高亮；
//   · 只在命中的那一根**变化时**动 DOM（换条才摘旧高亮 + 复位旧文案）；
//   · 会话切换整批搬家前必须先摘掉旧高亮，否则切回该会话时会有两条 .is-center
//     （tests/rail-center.test.ts 的「整轨唯一」用例钉着这条）。
// ============================================================================
import { setHint } from './hint/card';
import { railCenterHit, railCenterLabel } from './rail-center';
import { docCenterY } from './rail-doc';
import type { RailItem } from './rail-state';

/** 上一帧命中的条（换条时才动类与文案）。 */
let centerItem: RailItem | null = null;

/** 同帧刷新「视口中央命中哪一轮」：只动一个类 + 一条文案，不重建 DOM、不改几何。 */
export function paintCenter(msgsEl: HTMLElement | null, railH: number, railW: number, shown: readonly RailItem[]): void {
  if (!msgsEl || railW <= 0) return; // 轨道被藏起（留白不足）时不判
  const hit = railCenterHit(shown.map((it) => ({ it, yDoc: docCenterY(msgsEl, it.startCol) })), msgsEl.scrollTop + railH / 2);
  const item = hit?.item?.it ?? null;
  if (item !== centerItem) {
    if (centerItem) {
      centerItem.el.classList.remove('is-center');
      setHint(centerItem.el, centerItem.hint); // 复位为常驻文案
    }
    if (item && hit) {
      item.el.classList.add('is-center');
      setHint(item.el, railCenterLabel(hit, item.fold));
    }
  }
  centerItem = item;
}

/**
 * 复位命中态。removeClass=true 时先摘掉旧高亮（会话切换、整批搬家之前用）；
 * false 时只丢引用（节点即将被清空/摘除，类随节点一起消失）。
 */
export function resetCenter(removeClass: boolean): void {
  if (removeClass && centerItem) centerItem.el.classList.remove('is-center');
  centerItem = null;
}
