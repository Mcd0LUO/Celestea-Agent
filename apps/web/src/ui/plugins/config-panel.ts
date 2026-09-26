// ============================================================================
// ui/plugins/config-panel.ts — 插件行的**内联配置面板**（W9108）。
// ----------------------------------------------------------------------------
// 形状与交互照抄「模型提供商」的行内面板（ui/providers/panel.ts 的 renderProviderRow）：
//   · 面板 DOM 每行只构建**一次**，展开/收起只切 class + max-height 过渡；
//   · 展开时按内容实测高度写入 inner 的 max-height，过渡结束后置 'none'
//     （内容随后增高不再被裁切）—— 这就是 `onLayout` 那一步；
//   · 不重建列表、不整树重绘。
//
// ★ 渲染器**不认识任何具体插件**：它只按描述里的 kind（bool/enum/text/number）
//   机械分派。这条不变量由测试用「假 descriptor」钉住 —— 一旦有人写了
//   「按某个具体插件 id 分支」的代码，假 descriptor 的用例与源码扫描都会红
//   （所以本文件里连注释都不许出现任何插件 id 字面量）。
//
// ★ 没有可调项时如实呈现（`.plug-cfg-empty`），**不伪造控件**、不写「加载中」。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';
import { CONFIG_OFF, CONFIG_ON, defaultOf, type PluginConfigItem, type PluginConfigSpec, type PluginConfigValues } from '../../plugins/config';

/** 一个已展开/收起的面板（状态跟着行节点走）。 */
export interface PluginPanelState {
  /** 面板容器（`.plug-panel`，与行相邻）。 */
  panel: HTMLElement;
  /** 承载高度过渡的内层（`.plug-panel-inner`）。 */
  inner: HTMLElement;
  /** 展开/收起控件（`.plug-expand`）。 */
  toggle: HTMLButtonElement;
  open: boolean;
}

/** 配置项值变化的回调（由装配层接上 setClientPluginConfig）。 */
export type ConfigChange = (key: string, value: string) => void;

/** 取值：把某个控件当前的值读成字符串（布尔走 on/off 字面量）。 */
export function readControl(control: Element): string {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    return control.checked ? CONFIG_ON : CONFIG_OFF;
  }
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) return control.value;
  return '';
}

/** 一个控件节点（按 kind 机械分派；**不看插件 id**）。 */
function buildControl(item: PluginConfigItem, values: PluginConfigValues, onChange: ConfigChange): HTMLElement {
  const value = values[item.key] ?? defaultOf(item);
  if (item.kind === 'bool') {
    const input = el('input', 'plug-cfg-bool') as HTMLInputElement;
    input.type = 'checkbox';
    input.dataset['key'] = item.key;
    input.checked = value === CONFIG_ON;
    input.addEventListener('change', () => onChange(item.key, readControl(input)));
    return input;
  }
  if (item.kind === 'enum') {
    const select = el('select', 'plug-cfg-enum') as HTMLSelectElement;
    select.dataset['key'] = item.key;
    for (const option of item.options) {
      const o = el('option', null, t(option.labelKey)) as HTMLOptionElement;
      o.value = option.value;
      select.appendChild(o);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(item.key, select.value));
    return select;
  }
  const input = el('input', item.kind === 'number' ? 'plug-cfg-number' : 'plug-cfg-text') as HTMLInputElement;
  input.type = item.kind === 'number' ? 'number' : 'text';
  input.dataset['key'] = item.key;
  input.value = value;
  if (item.kind === 'number') {
    if (item.min !== undefined) input.min = String(item.min);
    if (item.max !== undefined) input.max = String(item.max);
    if (item.step !== undefined) input.step = String(item.step);
  } else if (item.maxLength !== undefined) {
    input.maxLength = item.maxLength;
  }
  input.addEventListener('change', () => onChange(item.key, input.value));
  return input;
}

/** 一个配置项行：标签 + 控件（+ 可选说明）。 */
function buildItem(item: PluginConfigItem, values: PluginConfigValues, onChange: ConfigChange): HTMLElement {
  const row = el('div', 'plug-cfg-item');
  const control = buildControl(item, values, onChange);
  const id = 'plugcfg-' + item.key;
  control.id = id;
  const label = el('label', 'plug-cfg-label', t(item.labelKey)) as HTMLLabelElement;
  label.htmlFor = id;
  row.appendChild(label);
  row.appendChild(control);
  if (item.hintKey !== undefined) row.appendChild(el('div', 'plug-cfg-hint', t(item.hintKey)));
  return row;
}

/**
 * 按描述机械渲染配置项（**空描述 = 如实空态**）。
 * 返回的面板内容随传入的 values 定初值；后续值变化由 applyValues 回填。
 */
export function renderConfigSpec(spec: PluginConfigSpec | undefined, values: PluginConfigValues, onChange: ConfigChange): HTMLElement {
  const box = el('div', 'plug-cfg');
  if (spec === undefined || spec.items.length === 0) {
    box.appendChild(el('div', 'plug-cfg-empty', t('settings.plugins.noConfig')));
    return box;
  }
  for (const item of spec.items) box.appendChild(buildItem(item, values, onChange));
  return box;
}

/** 把（规范化后的）值回填到控件上：保存成功/失败拨回原值时用。 */
export function applyValues(box: HTMLElement, values: PluginConfigValues): void {
  for (const node of Array.from(box.querySelectorAll('[data-key]'))) {
    const key = (node as HTMLElement).dataset['key'] ?? '';
    const value = values[key];
    if (value === undefined) continue;
    if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = value === CONFIG_ON;
    else if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) node.value = value;
  }
}

/** 内容增高后重算 max-height（展开态若已是 none 则无需处理）——同 providers 的 syncPanelHeight。 */
export function syncPanelHeight(state: PluginPanelState): void {
  if (!state.open) return;
  const h = state.inner.style.maxHeight;
  if (h === 'none' || h === '') return;
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
}

function expandPanel(state: PluginPanelState): void {
  if (state.open) return;
  state.open = true;
  state.toggle.setAttribute('aria-expanded', 'true');
  state.panel.classList.add('open');
  state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
}

function collapsePanel(state: PluginPanelState): void {
  if (!state.open) return;
  state.open = false;
  state.toggle.setAttribute('aria-expanded', 'false');
  // 展开完成时 maxHeight 已置 'none'：先固定当前高度并强制回流，再归零 → 收起动画生效
  if (state.inner.style.maxHeight === 'none') {
    state.inner.style.maxHeight = state.inner.scrollHeight + 'px';
    void state.inner.offsetHeight;
  }
  state.panel.classList.remove('open');
  state.inner.style.maxHeight = '0px';
}

export function togglePanel(state: PluginPanelState): void {
  if (state.open) collapsePanel(state);
  else expandPanel(state);
}

/**
 * 为一行插件建展开控件 + 相邻的内联面板（DOM 只构建一次）。
 *
 * 返回的 state 由调用方保存；`values` 是渲染初值（生效配置），`onChange` 是
 * 装配层接上的写入口。
 */
export function buildConfigPanel(
  label: string,
  spec: PluginConfigSpec | undefined,
  values: PluginConfigValues,
  onChange: ConfigChange,
): { state: PluginPanelState; toggle: HTMLButtonElement; panel: HTMLElement; content: HTMLElement } {
  const toggle = el('button', 'plug-expand') as HTMLButtonElement;
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', t('settings.plugins.expand', { label }));

  const panel = el('div', 'plug-panel');
  const inner = el('div', 'plug-panel-inner');
  const content = renderConfigSpec(spec, values, onChange);
  inner.appendChild(content);
  panel.appendChild(inner);

  const state: PluginPanelState = { panel, inner, toggle, open: false };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation(); // 展开控件不触发行本体的其它行为
    togglePanel(state);
  });
  // 展开完成 → 解除高度约束（内容随后增高不再被裁切）
  inner.addEventListener('transitionend', (e) => {
    if (e.target !== inner || (e as TransitionEvent).propertyName !== 'max-height') return;
    if (state.open) inner.style.maxHeight = 'none';
  });
  return { state, toggle, panel, content };
}
