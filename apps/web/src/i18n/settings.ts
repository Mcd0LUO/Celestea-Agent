// ============================================================================
// i18n/settings.ts — 设置页「通用偏好」pane 的内容 + 语言字段 + 静态 DOM 填充。
// ----------------------------------------------------------------------------
//   用户要求：语言切换要有**独立一页**（不是挂在「通用配置」顶部）。
//   本模块只放**真正全局**的界面偏好；会话级设置（模型/档位/权限档）不在这里。
//   语言字段的标签走 t()；切换语言后由 installI18nSettings 统一重画本页文案
//   （不重建 pane、不重新请求——设置页铁律 7）。
// ============================================================================
import { el } from '../utils/dom';
import { getLocale, localeLabel, onLocaleChange, setLocale, t, type Locale } from './index';
import { applyDocumentLang, applyI18n } from './dom';

/**
 * 切换语言后**整页重载**（方案 A）。
 *   本架构无框架、大量模块在渲染期调用 t()，逐模块订阅重画极易漏（statusline/会话树/
 *   侧栏/工具卡都没有订阅）。重载后所有模块从 localStorage 读到新语言重新渲染，**必然完整**。
 *   放在 change 处理器里而非 setLocale() 内部：setLocale() 的单测不受影响。
 *   代价：重载会丢滚动位置 / 已开面板；会话状态在服务端，重载后由既有恢复路径还原。
 */
let reloadImpl: () => void = (): void => {
  try {
    location.reload();
  } catch {
    /* 非浏览器环境（单测 jsdom）：忽略 */
  }
};

/** 仅供测试：替换整页重载实现（默认 location.reload()；jsdom 的 reload 不可重定义）。 */
export function setReloadImpl(fn: () => void): void {
  reloadImpl = fn;
}

function reloadPage(): void {
  reloadImpl();
}

/** 已挂载的语言字段（语言切换时逐个重画标签，不重建 DOM）。 */
const fields = new Set<HTMLElement>();
let installed = false;

function buildField(): HTMLElement {
  const wrap = el('div', 'cfg-field i18n-field');
  wrap.appendChild(el('span', 'cfg-label', t('common.language')));
  const select = el('select', 'cfg-input') as HTMLSelectElement;
  for (const loc of ['zh', 'en'] as Locale[]) {
    const opt = el('option', null, localeLabel(loc)) as HTMLOptionElement;
    opt.value = loc;
    select.appendChild(opt);
  }
  select.value = getLocale();
  select.addEventListener('change', () => {
    const next = select.value as Locale;
    if (next === getLocale()) return;
    setLocale(next);
    reloadPage();
  });
  wrap.appendChild(select);
  wrap.appendChild(el('span', 'cfg-hint', t('common.language.hint')));
  fields.add(wrap);
  return wrap;
}

function paint(wrap: HTMLElement): void {
  const label = wrap.querySelector('.cfg-label');
  const hint = wrap.querySelector('.cfg-hint');
  const select = wrap.querySelector('select');
  if (label) label.textContent = t('common.language');
  if (hint) hint.textContent = t('common.language.hint');
  if (select instanceof HTMLSelectElement) select.value = getLocale();
}

/** 建语言字段（标签走 t()）。 */
export function languageField(): HTMLElement {
  return buildField();
}

/** 当前是否有语言字段已挂载（诊断/测试）。 */
export function languageFieldMounted(): boolean {
  for (const w of fields) if (w.isConnected) return true;
  return false;
}

/**
 * 「通用偏好」pane 内容：**只收真正全局**的界面偏好。
 * 目前只有语言（见报告：其余候选要么是单主题/拖拽态，要么是会话级）。
 * 离屏构建 + 单次替换；由 showPane 的 paneLoaded 保证切回不重建。
 */
export function mountGeneralPane(container: HTMLElement): void {
  const off = document.createElement('div');
  off.appendChild(buildField());
  container.replaceChildren(...Array.from(off.childNodes));
}

/**
 * 装配：填充静态 [data-i18n] 文案，并在语言切换时重画它们与已挂载的语言字段。
 * 幂等（多次调用只订阅一次）。
 */
export function installI18nSettings(): void {
  if (installed) return;
  installed = true;
  paintStaticDom();
  onLocaleChange(() => {
    paintStaticDom();
    for (const w of fields) if (w.isConnected) paint(w);
  });
}

/** 静态 DOM 的整页重画：data-i18n* 文案 + `<html lang>`。 */
function paintStaticDom(): void {
  applyI18n(document);
  applyDocumentLang(document);
}
