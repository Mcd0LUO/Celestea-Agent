// ============================================================================
// ui/providers/list.ts — 提供商列表表格 + 默认模型卡片（W236/W256/W262）
//   （W748 从 ui/providers.ts 拆出；纯搬运，DOM/类名/文案/事件未改）。
//   列表整体重建 = 离屏构建 + 一次性替换（铁律 1/2）：重建前先释放旧面板句柄。
// ============================================================================
import { api } from '../../api';
import { el } from '../../utils/dom';
import { releasePanels, renderProviderRow } from './panel';
import { fmtErr, getDefaultModel, getProviders, setDefaultModel } from './state';
import type { ProviderListHost } from './types';
import { t } from '../../i18n';

export function renderProviders(container: HTMLElement, host: ProviderListHost): void {
  releasePanels(); // 旧行 DOM 即将被替换：先摘掉它们留在层级栈上的句柄
  container.replaceChildren();
  if (!getProviders().length) {
    container.appendChild(el('div', 'side-note', t('settings.providers.empty')));
    return;
  }
  const table = el('table', 'prov-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of [t('settings.field.name'), t('settings.providers.note'), t('settings.providers.requestFormat'), t('settings.field.model'), t('settings.field.status'), t('settings.field.actions')]) {
    hr.appendChild(el('th', null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const p of getProviders()) {
    const row = renderProviderRow(host, p);
    tbody.appendChild(row.tr);
    tbody.appendChild(row.panelTr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export function renderDefaultPicker(container: HTMLElement, host: ProviderListHost): void {
  const wrap = el('div', 'prov-default-card');
  const head = el('div', 'prov-default-head');
  head.appendChild(el('span', 'prov-default-title', t('settings.providers.defaultModel')));
  head.appendChild(el('span', 'prov-default-note', t('settings.providers.defaultNote')));
  wrap.appendChild(head);
  const body = el('div', 'prov-default-body');
  body.appendChild(el('span', 'prov-default-label', t('settings.providers.currentDefault')));
  const sel = document.createElement('select');
  sel.className = 'cfg-input prov-default-sel';
  const known = new Set<string>();
  for (const p of getProviders()) {
    for (const m of p.models ?? []) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = (p.name || p.id) + ' / ' + m.id;
      known.add(m.id);
      sel.appendChild(o);
    }
  }
  if (getDefaultModel() !== null && !known.has(getDefaultModel() ?? '')) {
    const o = document.createElement('option');
    o.value = getDefaultModel() ?? '';
    o.textContent = t('settings.providers.defaultNotInList', { model: getDefaultModel() ?? '' });
    sel.appendChild(o);
  }
  sel.value = getDefaultModel() ?? '';
  const msg = el('span', 'prov-default-msg');
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    msg.textContent = t('settings.providers.applyingDefault');
    msg.className = 'prov-default-msg';
    void api
      .setDefaultModel(v)
      .then(() => {
        setDefaultModel(v);
        msg.textContent = t('settings.providers.defaultApplied');
        msg.className = 'prov-default-msg ok';
        void host.loadProviders();
      })
      .catch((err: unknown) => {
        msg.textContent = t('settings.providers.switchFailed', { reason: fmtErr(err) });
        msg.className = 'prov-default-msg err';
        sel.value = getDefaultModel() ?? '';
      });
  });
  body.appendChild(sel);
  body.appendChild(msg);
  wrap.appendChild(body);
  container.appendChild(wrap);
}
