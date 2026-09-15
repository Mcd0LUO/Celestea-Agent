// ============================================================================
// ui/sessiongone.ts — 会话**离开当前会话集合**（被删除 / 被归档）后的收尾（W792）。
//
//   为什么需要：会话消失后，前端有三处状态可能还指着它 ——
//     · `S.selSession`（发给模型的「当前会话」标识、权限面板的落点）；
//     · 会话树的 active 高亮（store 的 activeSession + 行上的 .active/.sel，
//       以及 Worker 组的 .ws-worker-row.active）；
//     · 视图容器 `.sess-pane[data-session=<id>]`（连同它的草稿 / 滚动位 / 工具卡）。
//   本模块把这三处一次清干净；statusline / 会话条 / 输入框等 chrome 由 viewctx 的
//   pane-change 广播被动同步（activatePane 里已发），此处不额外重复。
//
//   口径（用户裁决 + W794 后端落地）：
//     · 活动与否只是**状态标记**，不做任何保护性拒绝（后端允许直接删活动会话）；
//     · 会话消失后**不自动切到「最近会话」** —— 那等于替用户做选择、也掩盖了
//       「你刚删/归档的正是当前会话」；焦点回到无语义的 LOCAL 空态（见 dropPane）。
//   纯 DOM + 状态清理：零网络（不触发任何列表重载，成功路径保持「静默」）。
// ============================================================================
import { S } from '../state';
import { $$ } from '../utils/dom';
import { getActiveSession, setActiveSession } from './sessiontree/store';
import { dropPane } from './viewctx';

/** 可能带 active/sel 高亮的行（会话树叶子 + Worker 组行，两者都用 data-id）。 */
const HIGHLIGHT_SEL = '.sess-leaf, .ws-worker-row';

/**
 * 收尾一个已消失的会话（删除 / 归档成功后调用）。
 *   `id` 为空（无语义 LOCAL 容器）时是 no-op。
 */
export function forgetSession(id: string): void {
  if (id === '') return;
  if (S.selSession === id) S.selSession = null; // 选中态
  if (getActiveSession() === id) setActiveSession(null); // store 的 active（树重绘的真源）
  dropPane(id); // 视图态（含草稿/滚动位/工具卡），聚焦时回到 LOCAL 空态
  // 残留高亮：别的树副本（设置页也有一棵）可能还挂着这个 id 的行 —— 只切 class，不重建树
  for (const n of $$<HTMLElement>(HIGHLIGHT_SEL)) {
    if (n.dataset.id === id) n.classList.remove('active', 'sel');
  }
}

/** 批量版：只对**真的消失了**的 id 调用（批量删除部分失败时别误伤失败项）。 */
export function forgetSessions(ids: readonly string[]): void {
  for (const id of ids) forgetSession(id);
}
