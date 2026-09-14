// ============================================================================
// ui/grants/panel/warnings.ts — 面板警示区（W757 新增；W760 从 ../panel.ts 拆出）。
//
//   服务端的 warnings 与 net_hosts_effective 一起，回答「我点的授权到底算不算数」：
//   警示区把 warnings 如实列出（复用 .grant-preview 样式族，刻意不抢眼），
//   netHostsIneffective() 供明细行标「当前部署下不生效」。字段缺失（旧服务）一律
//   当「没有」处理：不报错、不显示。W760 只搬家：文案与判定逐字未改。
// ============================================================================
import { el } from '../../../utils/dom';
import { listOf } from '../caps';
import { getData } from '../state';

/**
 * 警示区（W757）：把服务端返回的 `warnings` 如实列出来。
 *
 * 复用 `.grant-preview` 样式族（灰底细边）刻意不抢眼 —— 这是提示，不是错误；
 * 字段缺失（旧服务）或不是字符串数组时一律当「没有」处理：不报错、不显示。
 */
export function warningBox(): HTMLElement | null {
  const items = listOf(getData()?.warnings);
  if (items.length === 0) return null;
  const box = el('div', 'grant-preview');
  box.appendChild(el('span', 'grant-preview-label', '提示'));
  for (const text of items) box.appendChild(el('div', 'grant-impact', text));
  return box;
}

/** W757：站点清单在本部署下不生效时，在该行如实标记（不改变任何动作）。 */
export function netHostsIneffective(): boolean {
  return getData()?.net_hosts_effective === false;
}
