// ============================================================================
// statusline/optimistic.ts — W795：模型 / 推理档位**切换的乐观更新**（纯函数，零 DOM）。
//
//   为什么单独一层：两处入口（picker.ts 的弹层切换、statusline.ts 的 409 挂起重试）
//   都要问同样两个问题 ——「这一帧先画成什么」与「失败时退回什么」。两处各写一遍
//   必然分叉；这里只放这两个纯函数，DOM 与请求仍在各自调用方（本模块不 import 它们，
//   也就不可能成环）。
//
//   口径（W795 任务书）：能立即推出终态的交互**先画终态**，请求后台跑；失败回滚到
//   动作前的值并说明原因。乐观只改**显示**：状态栏快照本来就是「界面真源」，
//   服务端响应回来后仍由响应（d.model / d.reasoning_effort）覆盖，绝不假装成功。
// ============================================================================
import type { ConfigPatch, StatusSnapshot } from '../types';

/** 乐观切换的回滚基准：当前的模型与推理档位（null = 标准档/未设置）。 */
export function revertPointOf(current: {
  model: string;
  effort: string | null;
}): StatusSnapshot {
  return { model: current.model, reasoning_effort: current.effort };
}

/** 把补丁里**真正要改**的字段折成一份可立即渲染的快照（= 这次切换的终态）。 */
export function optimisticPatchView(patch: ConfigPatch): StatusSnapshot {
  const view: StatusSnapshot = {};
  if (patch.model !== undefined) view.model = patch.model;
  if (patch.reasoning_effort !== undefined) view.reasoning_effort = patch.reasoning_effort;
  return view;
}
