// ============================================================================
// ui/plugins/index.ts — 设置页「插件」一格的装配（W859）。
// ----------------------------------------------------------------------------
//   容器结构（离屏构建、单次替换）：
//     #settingsPlugins
//       .plug-sec（客户端插件）
//         .plug-list  > .plug-row[data-id]（开关 = 真注册/真注销，见 src/plugins/）
//         .plug-status 就地说明（切换结果 / 失败原因）
//       .plug-sec（服务端插件，只读）
//         .plug-host-list > .plug-host（名字 + 「服务端内置 · 进程内不可热拔插」）
//         或 .plug-empty（服务端未提供插件清单 —— 不伪造）
//   铁律：首屏不写「加载中」占位 —— 客户端一段同步画出终态；宿主一段在清单回来前
//   保持空（回来即画，失败画如实空态）。
// ============================================================================
import { userErrorText } from '../../api';
import { CLIENT_PLUGINS, isClientPluginOn, setClientPlugin } from '../../plugins';
import type { ClientPluginDescriptor } from '../../plugins';
import { el, need } from '../../utils/dom';
import { fetchHostPlugins, type HostPluginRow } from './host';

const HOST = '#settingsPlugins';
/** 宿主清单不可用（端点缺失/不可达/清单为空）时的如实空态。 */
const HOST_EMPTY = '服务端未提供插件清单';
/** 宿主插件逐项标注：只读，进程内拔不掉。 */
const HOST_BADGE = '服务端内置 · 进程内不可热拔插';

function section(title: string, note: string): HTMLElement {
  const sec = el('section', 'plug-sec');
  const head = el('header', 'plug-sec-head');
  head.appendChild(el('h5', 'plug-sec-title', title));
  head.appendChild(el('span', 'plug-sec-note', note));
  sec.appendChild(head);
  return sec;
}

/** 一行客户端插件 + 开关（开关初值 = 此刻真实挂载状态）。 */
function clientRow(d: ClientPluginDescriptor, status: (t: string, ok: boolean) => void): HTMLElement {
  const row = el('div', 'plug-row');
  row.dataset['id'] = d.id;
  const main = el('div', 'plug-row-main');
  main.appendChild(el('div', 'plug-row-label', d.label));
  main.appendChild(el('div', 'plug-row-hint', d.hint));
  row.appendChild(main);

  const wrap = el('label', 'plug-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'plug-switch-input';
  input.checked = isClientPluginOn(d.id);
  input.addEventListener('change', () => {
    const want = input.checked;
    const r = setClientPlugin(d.id, want);
    if (!r.ok) input.checked = !want; // 回滚：真挂载状态确实没变
    status(r.text, r.ok);
  });
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'plug-switch-track'));
  row.appendChild(wrap);
  return row;
}

/** 一行宿主插件（只读：没有开关，只有名字/版本/说明 + 不可热拔插标注）。 */
function hostRow(p: HostPluginRow): HTMLElement {
  const row = el('div', 'plug-host');
  row.dataset['name'] = p.name;
  const main = el('div', 'plug-row-main');
  const label = el('div', 'plug-row-label', p.name);
  if (p.version !== '') label.appendChild(el('span', 'plug-host-ver', p.version));
  main.appendChild(label);
  if (p.note !== '') main.appendChild(el('div', 'plug-row-hint', p.note));
  row.appendChild(main);
  row.appendChild(el('span', 'plug-badge', HOST_BADGE));
  return row;
}

/** 宿主一段的渲染（空列表 = 如实空态）。 */
function renderHost(box: HTMLElement, rows: HostPluginRow[]): void {
  const off = document.createElement('div');
  if (rows.length === 0) off.appendChild(el('div', 'plug-empty', HOST_EMPTY));
  else for (const r of rows) off.appendChild(hostRow(r));
  box.replaceChildren(...off.childNodes);
}

/** 载入并渲染这一格（config.ts 的 loadPane 调用；「重新载入」会再次调用）。 */
export async function loadPluginsSection(): Promise<void> {
  const host = need<HTMLElement>(HOST);
  const status = el('div', 'plug-status');
  const setStatus = (t: string, ok: boolean): void => {
    status.className = 'plug-status' + (t === '' ? '' : ok ? ' ok' : ' err');
    status.textContent = t;
  };

  const clientSec = section('客户端插件', '开关立即生效，重新打开页面后保持');
  const list = el('div', 'plug-list');
  for (const d of CLIENT_PLUGINS) list.appendChild(clientRow(d, setStatus));
  clientSec.appendChild(list);
  clientSec.appendChild(status);

  const hostList = el('div', 'plug-host-list');
  const hostSec = section('服务端插件', '只读清单');
  hostSec.appendChild(hostList);

  const off = document.createElement('div');
  off.append(clientSec, hostSec);
  host.replaceChildren(...off.childNodes);

  try {
    renderHost(hostList, await fetchHostPlugins());
  } catch (err) {
    // 端点缺失/不可达：只画一行如实空态，不弹错、不重试、不伪造清单
    renderHost(hostList, []);
    console.warn('[plugins] ' + userErrorText(err, '宿主插件清单暂不可用'));
  }
}
