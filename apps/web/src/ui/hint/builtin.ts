// ============================================================================
// ui/hint/builtin.ts — **内置的默认提示提供者**（W790 · item 4）
// ----------------------------------------------------------------------------
// 默认实现 = rail 已验证的 150ms 卡片（延迟在引擎里，内容在这里）：纯文本，
// 可选一个小标签（data-hint-tag）。它是普通提供者，没有任何特权 ——
// 注销掉它，全站提示就退回原生 title（这条退化路径被测例钉住）。
// ============================================================================
import { el } from '../../utils/dom';
import type { HintHandle, HintPlugin } from './registry';

/** 内置纯文本卡的提供者 id（diagnostics / 测试读它）。 */
export const TEXT_HINT_ID = 'hint-text-card';

function buildTextCard(target: HTMLElement, text: string): HTMLElement {
  const box = el('div', 'hint-card-text');
  const tag = (target.getAttribute('data-hint-tag') ?? '').trim();
  if (tag) box.appendChild(el('span', 'hint-card-tag', tag));
  box.appendChild(el('span', 'hint-card-body', text));
  return box;
}

/** 内置默认实现（priority 0：任何更专门的提供者都能压过它）。 */
export function textCardPlugin(): HintPlugin {
  return {
    id: TEXT_HINT_ID,
    priority: 0,
    claim(target, text): HintHandle | null {
      if (!text) return null;
      return { build: () => buildTextCard(target, text) };
    },
  };
}
