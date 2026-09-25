// ============================================================================
// ui/grants/panel/shield.ts — 状态栏盾牌的三态渲染（设计 §3.1；W760 从 ../panel.ts 拆出）。
//
//   三态 = 未放宽 / 已放宽 N 项 / 有权限即将失效（EXPIRING_SEC 内）。类名与 title
//   文案逐字未改；盾牌按钮与徽标元素仍由 state.ts 持有（本模块只读不建）。
//
//   W1517（权限入口合并）：盾牌现在是**唯一的**权限入口，徽标区同时承载
//     · 授权计数（#slGrantBadge，本模块写）与
//     · 会话档位名（#slGrantTier，statusline/permission.ts 写）—— 同处一格，不做两行。
//   档位名只在档位**已解析**时参与 title/aria（免得「默认（仅工作区，无网络）」这句
//   与档位名互相矛盾）；档位未知（无活动会话/老服务没有档位端点）时 title 逐字沿用
//   合并前的三态文案。没有档位段（#slGrantTier 缺失）时行为与合并前完全一致。
// ============================================================================
import { nowSec } from '../caps';
import { getShieldBadge, getShieldButton, getShieldTier } from '../state';
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
  btn.title = shieldTitle(count, expiring, tierOf());
  btn.setAttribute('aria-label', btn.title);
}

/** 已解析的档位名（'' = 未解析：无活动会话 / 该部署没有档位端点 / 面板未装配）。 */
function tierOf(): string {
  return getShieldTier()?.textContent ?? '';
}

/**
 * 三态标题；档位已解析时补上「档位：X · 」前缀（同一个入口承载两个概念，标题必须
 * 两个都说，否则用户点了才发现里面还有档位）。
 */
function shieldTitle(count: number, expiring: boolean, tier: string): string {
  const base =
    count === 0
      ? t('grants.shield.default')
      : expiring
        ? t('grants.shield.expiring')
        : t('grants.shield.granted', { n: count });
  return tier === '' ? base : t('grants.shield.withTier', { tier, text: base });
}
