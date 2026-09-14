// ============================================================================
// ui/providers/rows.ts — 列表行单元格 / 列表提示 / 单行局部刷新
//   （W748 从 ui/providers.ts 拆出；纯搬运，行为不变）。
// ============================================================================
import { api } from '../../api';
import type { ProviderInfo } from '../../types';
import { el } from '../../utils/dom';
import { boxEl, getProviders, openPanels, setProviderData } from './state';
import type { ProviderListHost } from './types';

export function modelCount(p: ProviderInfo): number {
  return p.models?.length ?? 0;
}

/** 状态单元格内容（默认 / 已配 Key 徽章）：离屏构建后单次替换。 */
export function renderStateCell(td: HTMLElement, p: ProviderInfo): void {
  const off = document.createElement('div');
  if (p.is_default) off.appendChild(el('span', 'prov-badge', '默认'));
  if (p.has_key) off.appendChild(el('span', 'prov-badge key', '已配 Key'));
  if (!p.is_default && !p.has_key) off.textContent = '—';
  td.replaceChildren(...off.childNodes);
}

/** 用最新数据就地刷新一行（不重建表格，不丢内联面板 DOM）。 */
export function applyRowCells(tr: HTMLTableRowElement, p: ProviderInfo): void {
  const oldId = tr.dataset.id ?? '';
  tr.dataset.id = p.id;
  if (oldId !== p.id && openPanels.delete(oldId)) openPanels.add(p.id);
  tr.classList.toggle('is-default', p.is_default === true);
  const nameEl = tr.querySelector<HTMLElement>('.prov-name');
  if (nameEl) nameEl.textContent = p.name || p.id;
  const noteEl = tr.querySelector<HTMLElement>('.prov-td-note');
  if (noteEl) noteEl.textContent = p.note ?? '—';
  const fmtEl = tr.querySelector<HTMLElement>('.prov-td-fmt');
  if (fmtEl) fmtEl.textContent = p.request_format ?? '—';
  const modelsEl = tr.querySelector<HTMLElement>('.prov-td-models');
  if (modelsEl) modelsEl.textContent = String(modelCount(p));
  const stateEl = tr.querySelector<HTMLElement>('.prov-td-state');
  if (stateEl) renderStateCell(stateEl, p);
}

/** 列表级提示行（.prov-list-msg）。 */
export function setMsg(text: string, cls = ''): void {
  const m = boxEl.querySelector<HTMLElement>('.prov-list-msg');
  if (!m) return;
  m.textContent = text;
  m.className = 'prov-list-msg' + (cls ? ' ' + cls : '');
}

/** 保存成功后局部刷新该行数据（仅这一行，其余行与面板 DOM 不动）。 */
export async function refreshRow(
  host: ProviderListHost,
  tr: HTMLTableRowElement,
  id: string,
): Promise<void> {
  try {
    const d = await api.providers();
    setProviderData(d.providers ?? [], d.default_model ?? null);
    const p = getProviders().find((x) => x.id === id);
    if (!p) {
      void host.loadProviders(); // 改名/被删：整体双缓冲刷新兜底
      return;
    }
    applyRowCells(tr, p);
  } catch {
    void host.loadProviders(); // 局部刷新失败：双缓冲整体刷新兜底
  }
}
