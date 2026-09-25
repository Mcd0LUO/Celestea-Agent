// ============================================================================
// ui/mode/copy.ts — 会话工作方式的**面向用户文案**单一真源（W788）。
//
//   为什么单独一个文件（对齐 ui/grants/copy.ts 的先例）：这些句式被两个落点共用
//   （新建会话弹窗的「工作方式」下拉 / statusline 徽标与切换弹层），并且要能在
//   node 里被机械断言（tests/session-mode-dom.test.ts）。
//   **全部导出改为函数**：文案走 i18n 的 t()，语言切换后必须跟着变（不能固化在模块加载时）。
//
//   权威依据：docs/modes-standard-vs-execution.md §3.2（入口位置与文案）、§8
//   （mode 值不直接暴露给用户，UI 只显示标签）。
// ============================================================================
import type { SessionMode } from '../../types';
import { t } from '../../i18n';

/** 徽标短文（只读徽标只有「标准」/「执行」两个词，设计 §3.2）。 */
export function modeLabel(mode: unknown): string {
  if (mode === 'standard') return t('mode.badge.standard');
  if (mode === 'execution') return t('mode.badge.execution');
  return '';
}

/** 缺省工作方式（与设计 §2.2「缺省 standard」一致）。 */
export const DEFAULT_MODE: SessionMode = 'standard';

/** 工作方式的完整名（新建会话下拉 / 切换弹层的选项文案）。 */
export function modeChoices(): readonly { value: SessionMode; label: string }[] {
  return [
    { value: 'standard', label: t('mode.choice.standard') },
    { value: 'execution', label: t('mode.choice.execution') },
  ];
}

/** 完整名（未知 → 空串）。 */
export function modeTitle(mode: unknown): string {
  return modeChoices().find((o) => o.value === mode)?.label ?? '';
}

/**
 * 切换回执文案 —— **只覆盖失败/降级**。
 *   busy        —— 409：**冻结文案**（设计 §3.1，与 /compact 同款纪律）
 *   unsupported —— 404/405：该部署未提供切换端点（老服务）→ 只读降级，
 *                  绝不假装成功（任务书 §4）
 *   invalid     —— 400/422：mode 取值被服务拒绝（UI 只提供合法值，属异常路径）
 *
 * W1520：原 applied（200 成功回执「将在会话下一轮生效」）已删除 —— 成功路径不再
 * 写状态栏提示（见 statusline/mode.ts 的 pickMode 注释：那条提示会撑爆 .sl-end
 * 右端集群，真机实测 44px → 245px）。**失败三项必须留**：那是诚实降级。
 */
export function modeNotes(): { busy: string; unsupported: string; invalid: string } {
  return {
    busy: t('mode.note.busy'),
    unsupported: t('mode.note.unsupported'),
    invalid: t('mode.note.invalid'),
  };
}
