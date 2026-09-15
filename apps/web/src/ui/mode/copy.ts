// ============================================================================
// ui/mode/copy.ts — 会话工作方式的**面向用户文案**单一真源（W788）。
//
//   为什么单独一个文件（对齐 ui/grants/copy.ts 的先例）：这些句式被两个落点共用
//   （新建会话弹窗的「工作方式」下拉 / statusline 徽标与切换弹层），并且要能在
//   node 里被机械断言（tests/session-mode-dom.test.ts）。
//   纯常量 + 纯函数：零 DOM、零网络、零依赖（只有类型导入）。
//
//   权威依据：docs/modes-standard-vs-execution.md §3.2（入口位置与文案）、§8
//   （mode 值不直接暴露给用户，UI 只显示中文标签）。
// ============================================================================
import type { SessionMode } from '../../types';

/** value → 徽标短文（只读徽标只有「标准」/「执行」两个词，设计 §3.2）。 */
const BADGE: Record<SessionMode, string> = { standard: '标准', execution: '执行' };

/** 工作方式的完整中文名（新建会话下拉 / 切换弹层的选项文案）。 */
export const MODE_CHOICES: readonly { value: SessionMode; label: string }[] = [
  { value: 'standard', label: '标准模式' },
  { value: 'execution', label: '执行模式（PTC）' },
];

/** 缺省工作方式（与设计 §2.2「缺省 standard」一致）。 */
export const DEFAULT_MODE: SessionMode = 'standard';

/**
 * 徽标/标题用的短文。未知取值（包括缺失、旧服务不返回该字段、非法值）→ 空串：
 * 调用方据此**隐藏**入口而不是置灰报错（设计 §6.5 的能力位降级纪律）。
 */
export function modeLabel(mode: unknown): string {
  return mode === 'standard' || mode === 'execution' ? BADGE[mode] : '';
}

/** 完整中文名（未知 → 空串）。 */
export function modeTitle(mode: unknown): string {
  return MODE_CHOICES.find((o) => o.value === mode)?.label ?? '';
}

/**
 * 切换回执文案。
 *   applied     —— 200：不打断在飞轮次，**下一轮边界**生效（设计 §2.2 #2）
 *   busy        —— 409：**冻结文案**（设计 §3.1，与 /compact 同款纪律）
 *   unsupported —— 404/405：该部署未提供切换端点（老服务）→ 只读降级，
 *                  绝不假装成功（任务书 §4）
 *   invalid     —— 400/422：mode 取值被服务拒绝（UI 只提供合法值，属异常路径）
 */
export const MODE_NOTES = {
  applied: '将在会话下一轮生效',
  busy: 'turn 进行中，无法切换模式',
  unsupported: '当前版本不支持切换工作方式',
  invalid: '工作方式取值无效，请重新选择',
} as const;
