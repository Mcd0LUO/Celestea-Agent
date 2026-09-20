// ============================================================================
// ui/plugins/index.ts — 设置页「插件」一格的装配（W859）。
// ----------------------------------------------------------------------------
//   容器结构（离屏构建、单次替换）：
//     #settingsPlugins
//       .plug-bar（W895-L 插件库工具条：搜索 + 计数 + 全部开/关）
//       .plug-sec（客户端插件；W895-L 按**分类**分组）
//         .plug-cat-head（分类名 + 该类计数）
//         .plug-list > .plug-row[data-id]（开关 = 真注册/真注销，见 src/plugins/）
//       .plug-status 就地说明（切换结果 / 失败原因）
//       .plug-sec（服务端插件，只读）
//         .plug-host-list > .plug-host（名字 + 「服务端内置 · 进程内不可热拔插」）
//         或 .plug-empty（服务端未提供插件清单 —— 不伪造）
//   铁律：首屏不写「加载中」占位 —— 客户端一段同步画出终态；宿主一段在清单回来前
//   保持空（回来即画，失败画如实空态）。
//   W895-L：搜索/分类是**纯视图**——只过滤已画的 DOM，不重新取表、不重建记录。
// ============================================================================
import { userErrorText } from '../../api';
import {
  CLIENT_PLUGIN_CATEGORIES,
  categoryLabelKey,
  clientPlugins,
  isClientPluginOn,
  setClientPlugin,
  setClientPlugins,
  whenClientPluginsReady,
} from '../../plugins';
import type { ClientPluginDescriptor } from '../../plugins';
import { el, need } from '../../utils/dom';
import { fetchHostPlugins, type HostPluginRow } from './host';
import { t } from '../../i18n';

const HOST = '#settingsPlugins';
/** 宿主清单不可用（端点缺失/不可达/清单为空）时的如实空态。 */

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
    // W895-C1：写服务端是异步的；失败时回滚开关与真挂载状态（本函数已回滚）。
    void (async () => {
      const r = await setClientPlugin(d.id, want);
      if (!r.ok) input.checked = !want; // 回滚：真挂载状态确实没变
      status(r.text, r.ok);
    })();
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
  row.appendChild(el('span', 'plug-badge', t('settings.plugins.hostBadge')));
  return row;
}

/** 宿主一段的渲染（空列表 = 如实空态）。 */
function renderHost(box: HTMLElement, rows: HostPluginRow[]): void {
  const off = document.createElement('div');
  if (rows.length === 0) off.appendChild(el('div', 'plug-empty', t('settings.plugins.hostEmpty')));
  else for (const r of rows) off.appendChild(hostRow(r));
  box.replaceChildren(...off.childNodes);
}

// ---- W895-L：插件库视图（分类 + 搜索 + 批量） ---------------------------------

/** 命中搜索词？（大小写无关，匹配 label 与 hint —— 两者都是用户语言。） */
function matches(d: ClientPluginDescriptor, q: string): boolean {
  if (q === '') return true;
  const hay = (d.label + ' ' + d.hint).toLowerCase();
  return hay.includes(q.toLowerCase());
}

/**
 * 构建插件库：工具条（搜索 + 计数 + 全部开/关）+ 按分类分组的列表。
 *
 * 纯视图：搜索/分组只操作**已建好的**行节点，不重新取服务端表、不重建记录。
 * 每行仍是 .plug-row[data-id] + .plug-switch-input（既有测试与开关语义不变）。
 */
function buildLibrary(setStatus: (t: string, ok: boolean) => void): HTMLElement {
  const all = clientPlugins();
  const box = el('div', 'plug-lib');

  // 搜索（不写「加载中」；空结果画如实空态）
  const bar = el('div', 'plug-bar');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'plug-search-input';
  search.placeholder = t('settings.plugins.search');
  search.setAttribute('aria-label', t('settings.plugins.search'));
  bar.appendChild(search);

  const count = el('span', 'plug-count');
  const allOn = el('button', 'btn plug-bulk', t('settings.plugins.allOn')) as HTMLButtonElement;
  const allOff = el('button', 'btn plug-bulk', t('settings.plugins.allOff')) as HTMLButtonElement;
  allOn.type = 'button';
  allOff.type = 'button';
  bar.appendChild(count);
  bar.appendChild(allOn);
  bar.appendChild(allOff);
  box.appendChild(bar);

  // 分类分组（顺序由 descriptor 的封闭集决定）
  const groups: Array<{ cat: string; sec: HTMLElement; list: HTMLElement; head: HTMLElement }> = [];
  for (const cat of CLIENT_PLUGIN_CATEGORIES) {
    const sec = el('div', 'plug-cat');
    const head = el('div', 'plug-cat-head');
    head.appendChild(el('h6', 'plug-cat-title', t(categoryLabelKey(cat))));
    const n = el('span', 'plug-cat-count', '');
    head.appendChild(n);
    const list = el('div', 'plug-list');
    sec.appendChild(head);
    sec.appendChild(list);
    box.appendChild(sec);
    groups.push({ cat, sec, list, head: n });
  }

  const rows = new Map<string, { row: HTMLElement; d: ClientPluginDescriptor }>();
  for (const d of all) {
    const row = clientRow(d, setStatus);
    rows.set(d.id, { row, d });
    const g = groups.find((x) => x.cat === d.category);
    (g ?? groups[0]!).list.appendChild(row);
  }

  // 用**独占**的 class：`.plug-empty` 已被宿主一段的「清单不可用」占用 ——
  // 同一个选择器指两个概念会让两边都不可断言（既有测试立刻抓到了）。
  const empty = el('div', 'plug-nomatch', t('settings.plugins.empty'));
  empty.classList.add('hidden');
  box.appendChild(empty);

  /** 把当前过滤/计数/空态一次性应用到已存在的节点（不重建行）。 */
  const apply = (): void => {
    const q = search.value.trim();
    let shown = 0;
    let on = 0;
    for (const [, { row, d }] of rows) {
      const hit = matches(d, q);
      row.classList.toggle('hidden', !hit);
      if (hit) shown += 1;
      if (isClientPluginOn(d.id)) on += 1;
    }
    for (const g of groups) {
      const visible = Array.from(g.list.children).filter((c) => !c.classList.contains('hidden')).length;
      g.sec.classList.toggle('hidden', visible === 0);
      g.head.textContent = String(visible);
    }
    count.textContent = t('settings.plugins.count', { on: String(on), total: String(all.length) });
    empty.classList.toggle('hidden', shown !== 0);
  };

  search.addEventListener('input', apply);
  const bulk = (on: boolean) => {
    // 对**当前可见**的行批量（搜索过滤后只影响看到的那批，符合用户预期）。
    const ids = Array.from(rows.values()).filter((r) => !r.row.classList.contains('hidden')).map((r) => r.d.id);
    void (async () => {
      const r = await setClientPlugins(ids, on);
      // 无论成败都以**真实挂载状态**重画开关初值（失败时状态没变）。
      for (const [id, entry] of rows) {
        const input = entry.row.querySelector('.plug-switch-input') as HTMLInputElement | null;
        if (input) input.checked = isClientPluginOn(id);
      }
      apply();
      setStatus(r.text, r.ok);
    })();
  };
  allOn.addEventListener('click', () => bulk(true));
  allOff.addEventListener('click', () => bulk(false));

  apply();
  return box;
}

/** 载入并渲染这一格（config.ts 的 loadPane 调用；「重新载入」会再次调用）。 */
export async function loadPluginsSection(): Promise<void> {
  const host = need<HTMLElement>(HOST);
  // W895-C1：开关初值来自服务端启用表。先等「取表 + 对齐」落定再画一次终态 ——
  // 既不写「加载中」占位，也不会把服务端已关闭的组件显示成开。
  await whenClientPluginsReady();
  const status = el('div', 'plug-status');
  const setStatus = (t: string, ok: boolean): void => {
    status.className = 'plug-status' + (t === '' ? '' : ok ? ' ok' : ' err');
    status.textContent = t;
  };

  const clientSec = section(t('settings.plugins.clientTitle'), t('settings.plugins.clientNote'));
  clientSec.appendChild(buildLibrary(setStatus));
  clientSec.appendChild(status);

  const hostList = el('div', 'plug-host-list');
  const hostSec = section(t('settings.plugins.hostTitle'), t('settings.plugins.hostNote'));
  hostSec.appendChild(hostList);

  const off = document.createElement('div');
  off.append(clientSec, hostSec);
  host.replaceChildren(...off.childNodes);

  try {
    renderHost(hostList, await fetchHostPlugins());
  } catch (err) {
    // 端点缺失/不可达：只画一行如实空态，不弹错、不重试、不伪造清单
    renderHost(hostList, []);
    console.warn('[plugins] ' + userErrorText(err, t('settings.plugins.hostUnavailable')));
  }
}
