// ============================================================================
// ui/grants/panel.ts — 状态栏盾牌（三态）+ 权限面板：**对外 API 的兼容层**。
//
//   W760：570 行的上帝模块按职责拆到 ./panel/*，本文件只做原样再导出 ——
//   仓内既有 import 路径（`ui/grants.ts`、`./flow.ts`）与拆分前完全一致。
//   拆分是纯搬家：DOM 结构/类名/文案/事件/几何规则一字未改。
//     ./panel/shield.ts    盾牌三态渲染（设计 §3.1）
//     ./panel/body.ts      面板开/关/重绘（设计 §3.2；内容顺序见该文件头）
//     ./panel/quick.ts     快捷授权区（W751 任务 1c）
//     ./panel/warnings.ts  警示区 + net_hosts 不生效标记（W757）
//     ./panel/position.ts  面板落位与跟随重排（W751 任务 1a）
//     ./panel/rows.ts      逐项能力明细行
//     ./panel/phrase.ts    能力 → 用户语言的固定句式 + TTL 取值（flow.ts 直接用）
//     ./panel/active.ts    生效集只读视图（上述模块的公共依赖，单独一层避免成环）
//
//   面板 = 复用 statusline 的 .sl-popup 样式族 + utils/overlays 的 Esc 层级栈；
//   授予/撤销动作本身不在本目录（见 ./flow.ts），经 GrantsHost 回调触发。
//   锚点契约（给 statusline 侧）：锚点 = #slGrant（盾牌按钮）的视口矩形，经
//   state.getShieldButton() 取得；盾牌缺失/不可见时兜底用 #statusline 的右端。
//   **本目录不需要 statusline.ts 做任何改动**（index.html 里 #slGrant 已经存在）。
// ============================================================================
export { renderShield } from './panel/shield';
export { positionPanel } from './panel/position';
export { closePanel, openPanel, renderPanel, togglePanel } from './panel/body';
export { phraseFor } from './panel/phrase';
export { maxTtlOf, ttlOf } from './request';
export { presetTtlLabel } from './panel/quick';
