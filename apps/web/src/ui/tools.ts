// ============================================================================
// ui/tools.ts — 「通用设置」页内的工具列表区块（单一职责）：
//   GET /api/tools → 渲染 name + description 表格；接口缺失时优雅降级。
//   （聊天消息里的工具卡片与此无关，见 ui/toolcards.ts。）
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import type { ToolInfo } from '../types';

const boxEl = need<HTMLElement>('#settingsTools');
const countEl = need<HTMLElement>('#toolsCount');

function renderTools(tools: ToolInfo[] | undefined, container: HTMLElement): void {
  const arr = tools ?? [];
  countEl.textContent = String(arr.length);
  container.replaceChildren();
  if (!arr.length) {
    container.appendChild(el('div', 'side-note', '未获取到工具'));
    return;
  }
  const table = el('table', 'tools-table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', null, '名称'));
  hr.appendChild(el('th', null, '描述'));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const t of arr) {
    const tr = el('tr');
    const tdName = el('td', 'tools-name');
    tdName.textContent = String(t.name);
    tdName.title = String(t.name);
    tr.appendChild(tdName);
    const tdDesc = el('td', 'tools-desc');
    tdDesc.textContent = t.description ? String(t.description) : '—';
    tr.appendChild(tdDesc);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

/** 载入并渲染工具清单区块（打开设置页 / 点击刷新时调用）。
 *  第 11 轮：离屏构建 + 一次性替换（旧内容保留到新内容就绪，无「加载中…」空白帧）。 */
export function loadToolsSection(): Promise<void> {
  const off = document.createElement('div');
  return api
    .tools()
    .then((d) => {
      renderTools(d.tools, off);
      boxEl.replaceChildren(...off.childNodes);
    })
    .catch((err: unknown) => {
      countEl.textContent = '—';
      off.appendChild(el('div', 'side-note err', '工具列表暂不可用'));
      off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
      boxEl.replaceChildren(...off.childNodes);
    });
}

