// ============================================================================
// ui/grants/panel/shield.ts — 状态栏盾牌的三态渲染（设计 §3.1；W760 从 ../panel.ts 拆出）。
//
//   三态 = 未放宽 / 已放宽 N 项 / 有权限即将失效（EXPIRING_SEC 内）。类名与 title
//   文案逐字未改；盾牌按钮与徽标元素仍由 state.ts 持有（本模块只读不建）。
// ============================================================================
import { nowSec } from '../caps';
import { getShieldBadge, getShieldButton } from '../state';
import { EXPIRING_SEC, activeGrants } from './active';
import { t } from '../../../i18n';

// ---- 盾牌按钮（§3.1 三态） -----------------------------------------------------

export function renderShield(): void {
  const btn = getShieldButton();
  if (!btn) return;
  const active = activeGrants();
  const count = active.length;
  const expiring = active.some(
    (g) =>
      typeof g.expires_at === 'number' && g.expires_at > 0 && g.expires_at - nowSec() < EXPIRING_SEC,
  );
  btn.classList.toggle('granted', count > 0);
  btn.classList.toggle('has-expiring', count > 0 && expiring);
  const badge = getShieldBadge();
  if (badge) badge.textContent = count > 0 ? String(count) : '';
  btn.title =
    count === 0
      ? t('grants.shield.default')
      : expiring
        ? t('grants.shield.expiring')
        : t('grants.shield.granted', { n: count });
  btn.setAttribute('aria-label', btn.title);
}
