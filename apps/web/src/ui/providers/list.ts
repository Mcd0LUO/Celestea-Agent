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

export function renderProviders(container: HTMLElement, host: ProviderListHost): void {
  releasePanels(); // 旧行 DOM 即将被替换：先摘掉它们留在层级栈上的句柄
  container.replaceChildren();
  if (!getProviders().length) {
    container.appendChild(el('div', 'side-note', '暂无提供商 · 点击上方「添加提供商」创建'));
    return;
  }
  const table = el('table', 'prov-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['名称', '备注', '请求格式', '模型', '状态', '操作']) {
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
  head.appendChild(el('span', 'prov-default-title', '默认模型'));
  head.appendChild(el('span', 'prov-default-note', '切换后立即生效'));
  wrap.appendChild(head);
  const body = el('div', 'prov-default-body');
  body.appendChild(el('span', 'prov-default-label', '当前默认'));
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
    o.textContent = (getDefaultModel() ?? '') + '（当前默认，不在列表）';
    sel.appendChild(o);
  }
  sel.value = getDefaultModel() ?? '';
  const msg = el('span', 'prov-default-msg');
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    msg.textContent = '应用默认模型…';
    msg.className = 'prov-default-msg';
    void api
      .setDefaultModel(v)
      .then(() => {
        setDefaultModel(v);
        msg.textContent = '已切换默认模型';
        msg.className = 'prov-default-msg ok';
        void host.loadProviders();
      })
      .catch((err: unknown) => {
        msg.textContent = '切换失败：' + fmtErr(err);
        msg.className = 'prov-default-msg err';
        sel.value = getDefaultModel() ?? '';
      });
  });
  body.appendChild(sel);
  body.appendChild(msg);
  wrap.appendChild(body);
  container.appendChild(wrap);
}
