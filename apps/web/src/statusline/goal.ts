// ============================================================================
// statusline/goal.ts — A3：statusline 上的**目标徽标**（#slGoal，一眼可见）。
//   有目标才显示、显示目标开头若干字；点击弹一句完整目标（不打开任何新页面）。
//   数据真源 = ui/commands/goal.ts 的客户端缓存（服务端回声为准）。
// ============================================================================
import { need } from '../utils/dom';
import { goalOf, onGoalChange } from '../ui/commands/goal';
import { activePane } from '../ui/viewctx';
import { t } from '../i18n'; // i18n P1-a

const MAX = 24;
let badge: HTMLElement | null = null;
let btn: HTMLElement | null = null;

function render(): void {
  if (!btn || !badge) return;
  const pane = activePane();
  const g = pane ? goalOf(pane.id) : null;
  if (!g) {
    btn.classList.add('hidden');
    badge.textContent = '';
    btn.removeAttribute('title');
    return;
  }
  btn.classList.remove('hidden');
  const short = g.text.length > MAX ? g.text.slice(0, MAX) + '…' : g.text;
  badge.textContent = t('statusline.goalBadge', { text: short });
  btn.title = t('statusline.goalTitle', { text: g.text });
}

/** 装配目标徽标（幂等；statusline.start 之后调用一次）。 */
export function initGoalBadge(): void {
  if (!btn) {
    const host = document.getElementById('slGoal');
    if (!host) return;
    btn = host;
    badge = need<HTMLElement>('#slGoalBadge', host);
    btn.addEventListener('click', () => render()); // 点击至少刷新到最新
  }
  onGoalChange(render);
  render();
}

/** 切会话/目标变化后重画（statusline 的 setSession 会调）。 */
export function refreshGoalBadge(): void {
  render();
}
