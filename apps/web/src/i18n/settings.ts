// ============================================================================
// i18n/settings.ts — 设置页「语言」字段（切换入口，挂在 #settingsConfig 顶部）。
//   切换后只重画本字段自身的文案；**不重建会话**（onLocaleChange 只通知订阅者）。
// ============================================================================
import { el } from '../utils/dom';
import { getLocale, localeLabel, onLocaleChange, setLocale, t, type Locale } from './index';

let row: HTMLElement | null = null;

function build(): HTMLElement {
  const wrap = el('div', 'cfg-field i18n-field');
  wrap.appendChild(el('span', 'cfg-label', t('common.language')));
  const select = el('select', 'cfg-input') as HTMLSelectElement;
  for (const loc of ['zh', 'en'] as Locale[]) {
    const opt = el('option', null, localeLabel(loc)) as HTMLOptionElement;
    opt.value = loc;
    select.appendChild(opt);
  }
  select.value = getLocale();
  select.addEventListener('change', () => setLocale(select.value as Locale));
  wrap.appendChild(select);
  wrap.appendChild(el('span', 'cfg-hint', t('common.language.hint')));
  row = wrap;
  return wrap;
}

/** 建语言字段并订阅语言变化（只重画自己）。 */
export function languageField(): HTMLElement {
  const wrap = build();
  onLocaleChange(() => {
    const label = wrap.querySelector('.cfg-label');
    const hint = wrap.querySelector('.cfg-hint');
    if (label) label.textContent = t('common.language');
    if (hint) hint.textContent = t('common.language.hint');
  });
  return wrap;
}

/** 当前字段是否已挂载（诊断）。 */
export function languageFieldMounted(): boolean {
  return row !== null && row.isConnected;
}
