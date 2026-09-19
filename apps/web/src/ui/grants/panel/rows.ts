// ============================================================================
// ui/grants/panel/rows.ts — 逐项能力明细行（设计 §3.2；W760 从 ../panel.ts 拆出）。
//
//   一行 = 能力名 + 状态徽标 + 一句话影响 +（范围明细）+ 动作按钮；站点/工具类在未
//   授予时带输入框（草稿存 state.drafts）。文案里的范围值只作数据填入，句式是常量。
//   W760 只搬家：DOM 结构、类名、徽标文案、过期行措辞逐字未改。
// ============================================================================
import { el } from '../../../utils/dom';
import type { GrantEntry } from '../../../types';
import {
  permanentLabel,
  permanentText,
  ttlTempChoices,
  expiryParen,
  hhmm,
  isPermanentExpiry,
  listOf,
  scopeOf,
  type CapDef,
} from '../caps';
import { drafts, inlineError, tempOpen, ttlPick, type GrantsHost } from '../state';
import { maxTtlOf, tempDefaultTtl } from '../request';
import { activeFor, expiredFor } from './active';
import { netHostsIneffective } from './warnings';
import { t } from '../../../i18n';

/** 一行 = 能力名 + 状态徽标 + 一句话影响 + （范围明细）+ 动作按钮（§3.2）。 */
export function renderRow(def: CapDef, host: GrantsHost): HTMLElement {
  const active = activeFor(def.cap);
  const expired = expiredFor(def.cap);
  const row = el('div', 'grant-row' + (active === null && expired.length ? ' expired' : ''));
  row.dataset.cap = def.cap;

  const head = el('div', 'grant-row-head');
  head.appendChild(el('span', 'grant-row-name', def.label));
  head.appendChild(badgeFor(def, active, expired));
  if (def.cap === 'net_hosts' && netHostsIneffective()) {
    const mark = el('span', 'grant-badge', t('grants.rows.ineffective'));
    mark.title = t('grants.rows.ineffectiveTitle');
    head.appendChild(mark);
  }
  if (def.reserved === true) {
    // W819-8：预留能力位如实标注，且下面不再给「授予」入口。
    const mark = el('span', 'grant-badge', t('grants.rows.reserved'));
    mark.title = t('grants.rows.reservedTitle');
    head.appendChild(mark);
  }
  row.appendChild(head);

  row.appendChild(el('div', 'grant-impact', def.impact));
  if (def.extra) row.appendChild(el('div', 'grant-impact', def.extra));

  const scope = scopeOf(active);
  const values = listOf(scope.roots).concat(listOf(scope.hosts), listOf(scope.tools));
  if (active && values.length) {
    row.appendChild(el('div', 'grant-detail', detailFor(def, active, values)));
  }
  for (const g of expired) {
    const v = listOf(scopeOf(g).roots).concat(listOf(scopeOf(g).hosts), listOf(scopeOf(g).tools));
    row.appendChild(
      el('div', 'grant-detail', t('grants.rows.expiredPrefix', { what: v.length ? v.join(t('grants.copy.listSep')) : def.label })),
    );
  }

  if ((def.kind === 'hosts' || def.kind === 'tools') && !active && def.reserved !== true) {
    const box = el('div', 'grant-hosts-row');
    const input = el('input', 'grant-input cfg-input') as HTMLInputElement;
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder =
      def.kind === 'hosts' ? t('grants.rows.hostPlaceholder') : t('grants.rows.toolPlaceholder');
    input.value = drafts.get(def.cap) ?? '';
    input.addEventListener('input', () => {
      drafts.set(def.cap, input.value);
      inlineError.delete(def.cap);
      const err = row.querySelector<HTMLElement>('.grant-err');
      if (err) err.remove();
    });
    box.appendChild(input);
    row.appendChild(box);
  }

  const actions = el('div', 'grant-row-actions');
  if (active) {
    const rev = el('button', 'btn-mini', t('grants.rows.revoke')) as HTMLButtonElement;
    rev.type = 'button';
    rev.addEventListener('click', () => void host.revoke(def.cap));
    actions.appendChild(rev);
  } else if (def.reserved !== true) {
    // W773：主路径 = 直接授予（永久）。这一个按钮就发出 ttl_sec: 0，
    // 不再强迫用户先选时长；时长选项收在旁边的「临时授权…」次级入口里。
    const grant = el(
      'button',
      'btn-mini' + (def.danger ? ' grant-danger-btn' : ''),
      def.kind === 'dirs' ? t('grants.rows.chooseDir') : t('grants.rows.grant'),
    ) as HTMLButtonElement;
    grant.type = 'button';
    grant.title = t('grants.rows.grantTitle', { permanent: permanentText() });
    grant.addEventListener('click', () => {
      ttlPick.set(def.cap, 0); // 显式回到永久（用户此前可能在「临时」里选过时长）
      void host.startGrant(def);
    });
    actions.appendChild(grant);
    actions.appendChild(tempToggle(def, host));
    if (def.cap === 'unsandboxed') {
      actions.appendChild(el('span', 'grant-impact', t('grants.rows.onceOnly', { permanent: permanentText() })));
    }
  }
  row.appendChild(actions);
  if (!active && tempOpen.has(def.cap)) row.appendChild(tempBox(def, host));

  const err = inlineError.get(def.cap);
  if (err) row.appendChild(el('div', 'grant-err', err));
  return row;
}

function badgeFor(def: CapDef, active: GrantEntry | null, expired: GrantEntry[]): HTMLElement {
  if (active) {
    const badge = el('span', 'grant-badge on', badgeText(def, active));
    return badge;
  }
  if (expired.length) return el('span', 'grant-badge expired', t('grants.rows.expired'));
  return el('span', 'grant-badge', t('grants.rows.notGranted'));
}

function badgeText(def: CapDef, g: GrantEntry): string {
  if (def.kind === 'hosts' || def.kind === 'tools') {
    const n = listOf(scopeOf(g)[def.kind === 'hosts' ? 'hosts' : 'tools']).length;
    return t('grants.rows.grantedCount', { n: n || 1 });
  }
  // W773：永久条目显示「永久」而不是时刻；有期限的仍显示到点时间。
  return isPermanentExpiry(g.expires_at)
    ? t('grants.rows.grantedPermanent', { permanent: permanentLabel() })
    : t('grants.rows.grantedUntil', { time: hhmm(g.expires_at as number) });
}

function detailFor(def: CapDef, g: GrantEntry, values: string[]): string {
  // W773：永久条目在明细里写「（永久，可随时撤销）」，不出现时刻。
  const exp = expiryParen(g.expires_at);
  switch (def.cap) {
    case 'write_roots':
      return t('grants.rows.detailWrite', { values: values.join(t('grants.copy.listSep')), exp });
    case 'read_roots':
      return t('grants.rows.detailRead', { values: values.join(t('grants.copy.listSep')), exp });
    case 'net_hosts':
      return values.join('、') + exp;
    case 'tool_extra':
      return values.join('、') + exp;
    default:
      return values.join('、') + exp;
  }
}

/** 「临时授权…」的开关（W773）：面板默认不展开时长选项，展开态记在 state.tempOpen。 */
function tempToggle(def: CapDef, host: GrantsHost): HTMLElement {
  const open = tempOpen.has(def.cap);
  const btn = el('button', 'btn-mini', open ? t('grants.rows.tempCollapse') : t('grants.rows.tempOpen')) as HTMLButtonElement;
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (open) tempOpen.delete(def.cap);
    else tempOpen.add(def.cap);
    host.renderPanel();
  });
  return btn;
}

/** 展开后的时长区：选一个时长 → 「按此时长授予」（此时才发出非 0 的 ttl_sec）。 */
function tempBox(def: CapDef, host: GrantsHost): HTMLElement {
  const box = el('div', 'grant-temp');
  box.appendChild(el('div', 'grant-impact', t('grants.rows.tempNote')));
  const line = el('div', 'grant-hosts-row');
  line.appendChild(ttlSelect(def));
  const go = el('button', 'btn-mini', t('grants.rows.tempGrant')) as HTMLButtonElement;
  go.type = 'button';
  go.addEventListener('click', () => void host.startGrant(def));
  line.appendChild(go);
  box.appendChild(line);
  return box;
}

/**
 * 时长选择器：**只出现在**「临时授权…」展开后（W773）——永久是默认路径，不经过这里。
 * 取值：本次展开里选过的时长优先，否则给该能力的常用档（30 分钟，按上限收敛）。
 */
function ttlSelect(def: CapDef): HTMLElement {
  const max = maxTtlOf(def);
  const sel = document.createElement('select');
  sel.className = 'cfg-input grant-ttl';
  const picked = ttlPick.get(def.cap);
  const cur = picked !== undefined && picked > 0 ? picked : tempDefaultTtl(def);
  let matched = false;
  for (const c of ttlTempChoices()) {
    if (c.sec > max) continue;
    const o = document.createElement('option');
    o.value = String(c.sec);
    o.textContent = c.label;
    if (c.sec === cur) matched = true;
    sel.appendChild(o);
  }
  if (!matched) {
    const fallback = Math.max(1, Math.min(cur, max));
    const o = document.createElement('option');
    o.value = String(fallback);
    o.textContent = t('grants.rows.minutes', { n: Math.max(1, Math.round(fallback / 60)) });
    sel.appendChild(o);
    sel.value = String(fallback);
  } else {
    sel.value = String(cur);
  }
  sel.addEventListener('change', () => ttlPick.set(def.cap, Number(sel.value)));
  return sel;
}
