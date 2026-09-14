// ============================================================================
// ui/providers/panel.ts — 列表行的「就地内联编辑面板」（W256 第 26 轮）
//   （W748 从 ui/providers.ts 拆出；纯搬运，DOM/类名/文案/事件未改）。
//   面板 DOM 每个提供商行只构建一次，展开/收起只切 class + max-height 过渡
//   （铁律 4），禁止删除重建；层级栈句柄在列表整体刷新前统一释放。
// ============================================================================
import { api } from '../../api';
import type { ProviderInfo } from '../../types';
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { confirmDialog } from '../confirm';
import { buildProviderForm } from './form';
import { modelCount, refreshRow, renderStateCell, setMsg } from './rows';
import { fmtErr, getProviders, openPanels } from './state';
import type { ProviderListHost } from './types';

// ---- 行内联编辑面板（任务 2） ------------------------------------------------------

interface PanelState {
  tr: HTMLTableRowElement;
  panelTr: HTMLTableRowElement;
  inner: HTMLElement;
  open: boolean;
  overlay: OverlayHandle | null;
}

/** 当前列表里存活的面板状态（列表整体刷新时用于释放其层级栈句柄）。 */
const livePanels = new Set<PanelState>();

/** 列表重建前调用：摘掉旧面板的层级栈句柄，避免 Esc 需要多按几次。 */
export function releasePanels(): void {
  for (const st of livePanels) {
    if (st.overlay) {
      popOverlay(st.overlay);
      st.overlay = null;
    }
  }
  livePanels.clear();
}

/** 内容增高后重算 max-height（展开态若为 none 则无需处理）。 */
function syncPanelHeight(state: PanelState): void {
  if (!state.open) return;
  const h = state.inner.style.maxHeight;
  if (h === 'none' || h === '') return;
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
}

function expandPanel(state: PanelState): void {
  if (state.open) return;
  state.open = true;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.add(id);
  state.tr.classList.add('expanded');
  state.tr.setAttribute('aria-expanded', 'true');
  state.panelTr.classList.add('open');
  // 先量出内容高度再过渡（max-height 过渡，铁律 4：只切 class，不重建 DOM）
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
  state.overlay = pushOverlay(() => collapsePanel(state));
}

function collapsePanel(state: PanelState): void {
  if (!state.open) return;
  state.open = false;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.delete(id);
  if (state.overlay) {
    popOverlay(state.overlay);
    state.overlay = null;
  }
  // 展开完成时 maxHeight 已置 'none'：先固定当前高度并强制回流，再归零 → 收起动画生效
  if (state.inner.style.maxHeight === 'none') {
    state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
    void state.inner.offsetHeight;
  }
  state.panelTr.classList.remove('open');
  state.tr.classList.remove('expanded');
  state.tr.setAttribute('aria-expanded', 'false');
  state.inner.style.maxHeight = '0px';
}

function togglePanel(state: PanelState): void {
  if (state.open) collapsePanel(state);
  else expandPanel(state);
}

/** 构建一行提供商（数据行 + 正下方内联面板行）；面板 DOM 只构建一次。 */
export function renderProviderRow(
  host: ProviderListHost,
  p: ProviderInfo,
): { tr: HTMLTableRowElement; panelTr: HTMLTableRowElement } {
  const tr = el('tr', 'prov-row') as HTMLTableRowElement;
  tr.dataset.id = p.id;
  tr.title = '点击展开/收起内联编辑';
  tr.setAttribute('aria-expanded', 'false');
  if (p.is_default) tr.classList.add('is-default');

  const tdName = el('td', 'prov-td-name');
  tdName.appendChild(el('span', 'prov-name', p.name || p.id));
  tr.appendChild(tdName);
  tr.appendChild(el('td', 'prov-td-note', p.note ?? '—'));
  tr.appendChild(el('td', 'prov-td-fmt', p.request_format ?? '—'));
  tr.appendChild(el('td', 'prov-td-models', String(modelCount(p))));
  const tdState = el('td', 'prov-td-state');
  renderStateCell(tdState, p);
  tr.appendChild(tdState);

  const tdOps = el('td', 'prov-td-ops');
  const del = el('button', 'btn-mini danger', '删除') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // 删除不触发展开/收起
    const id = tr.dataset.id ?? '';
    const cur = getProviders().find((x) => x.id === id);
    void confirmDialog({
      title: '删除提供商',
      message: '确认删除提供商「' + (cur?.name || id) + '」？',
      okLabel: '删除',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void api
        .deleteProvider(id)
        .then(() => void host.loadProviders())
        .catch((err: unknown) => setMsg('删除失败：' + fmtErr(err)));
    });
  });
  tdOps.appendChild(del);
  tr.appendChild(tdOps);

  // ---- 内联面板行（该行正下方） ----
  const panelTr = el('tr', 'prov-panel-row') as HTMLTableRowElement;
  const td = el('td', 'prov-panel-td') as HTMLTableCellElement;
  td.colSpan = 6;
  const inner = el('div', 'prov-inline');
  td.appendChild(inner);
  panelTr.appendChild(td);

  const state: PanelState = { tr, panelTr, inner, open: false, overlay: null };
  livePanels.add(state);
  const refs = buildProviderForm(p, {
    onSaved: (payload) => {
      collapsePanel(state);
      void refreshRow(host, tr, payload.id);
    },
    onCancel: () => collapsePanel(state),
    onLayout: () => syncPanelHeight(state),
  });
  inner.appendChild(refs.root);

  // 展开完成 → 解除高度约束（内容随后增高不再被裁切）
  inner.addEventListener('transitionend', (e) => {
    if (e.target !== inner || e.propertyName !== 'max-height') return;
    if (state.open) inner.style.maxHeight = 'none';
  });

  // 点击行本体（非交互控件）→ 原地展开/收起
  tr.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('button, a, input, select, textarea, label')) return;
    togglePanel(state);
  });

  // 刷新后恢复展开态（无动画：直接落到位）
  if (openPanels.has(p.id)) {
    state.open = true;
    tr.classList.add('expanded');
    tr.setAttribute('aria-expanded', 'true');
    panelTr.classList.add('open');
    inner.style.maxHeight = 'none';
    state.overlay = pushOverlay(() => collapsePanel(state));
  }

  return { tr, panelTr };
}
