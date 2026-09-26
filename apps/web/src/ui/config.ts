// ============================================================================
// ui/config.ts — 「通用设置」页（左导航 + 右内容，取代原 #modal 弹层）：
//   导航页：「通用配置」（热调表单）/「工具」（清单表格）/「归档会话」（管理，W786）。
//   模型下拉用 available.models（value=id / label=name，缺失降级手输）；
//   effort 档位 + 「标准（清除）」；保存 POST /api/config（409/404/405/400 有提示）。
// ============================================================================
import { api, ApiError } from '../api';
import { loadConfigCached, revalidateConfig } from '../statusline/cfg-cache'; // W778：首屏走配置缓存
import { el, need } from '../utils/dom';
import { closeOverlaysAbove, popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { ConfigInfo, ConfigPatch } from '../types';
import { loadToolsSection } from './tools';
import { loadArchiveSection } from './archive/panel';
import { initProvidersSection, loadProviders } from './providers';
import { initPromptsSection, loadPrompts } from './prompts';
import { loadPermissionsSection } from './permissions';
import { loadPluginsSection } from './plugins'; // W859 设置页「插件」（客户端热开关 + 宿主只读）
import { installI18nSettings, mountGeneralPane } from '../i18n/settings'; // i18n：通用偏好 pane
import { mountUsagePane } from './usage/panel'; // W9103：使用统计 pane
import { t } from '../i18n';

const page = need<HTMLElement>('#settingsPage');
const box = need<HTMLElement>('#settingsConfig');
const statusHint = need<HTMLElement>('#settingsHint');

/** 引擎已知档位（后端未发布 available.efforts 时的降级选项）。 */
const EFFORT_FALLBACK: readonly string[] = ['low', 'high', 'max'];

// ---- 小部件 -------------------------------------------------------------------

const ctl = {
  select: (options: { value: string; label: string }[], current?: string | null): HTMLSelectElement => {
    const s = el('select', 'cfg-input');
    for (const o of options) {
      const opt = el('option', null, o.label) as HTMLOptionElement;
      opt.value = o.value;
      s.appendChild(opt);
    }
    const cur = current ?? '';
    if (cur !== '' && !options.some((o) => o.value === cur)) {
      // 当前值不在清单（如 pinned 具体版本）：保留为附加选项，避免误改
      const extra = el('option', null, cur + t('settings.suffix.current')) as HTMLOptionElement;
      extra.value = cur;
      s.appendChild(extra);
    }
    s.value = cur;
    return s;
  },
  text: (value: string, placeholder?: string, type = 'text'): HTMLInputElement => {
    const i = el('input', 'cfg-input') as HTMLInputElement;
    i.type = type;
    i.value = value;
    if (placeholder) i.placeholder = placeholder;
    return i;
  },
  num: (value: number | null | undefined, placeholder: string): HTMLInputElement => {
    const i = el('input', 'cfg-input') as HTMLInputElement;
    i.type = 'number';
    i.min = '0';
    i.placeholder = placeholder;
    if (value !== undefined && value !== null) i.value = String(value);
    return i;
  },
  field: (label: string, control: HTMLElement, hint?: string): HTMLElement => {
    const row = el('label', 'cfg-field');
    row.appendChild(el('span', 'cfg-label', label));
    row.appendChild(control);
    if (hint) row.appendChild(el('span', 'cfg-hint', hint));
    return row;
  },
};

function toNum(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// ---- 表单 ---------------------------------------------------------------------

function renderForm(cfg: ConfigInfo, statusWindow: number | null, container: HTMLElement): void {
  container.replaceChildren();
  const form = el('form', 'cfg-form');

  // W227 修复：available.models 是 {id,name,reasoning} 对象数组——
  // 选项 value=id、label=name（此前 map(String) 渲染成 "[object Object]"）。
  const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
  const efforts = Array.isArray(cfg.available?.efforts) ? cfg.available.efforts : [];

  const modelCtl: HTMLSelectElement | HTMLInputElement = models.length
    ? ctl.select(models.map((m) => ({ value: m.id, label: m.name })), cfg.model ?? null)
    : ctl.text(cfg.model ?? '', t('settings.config.modelName'));
  form.appendChild(ctl.field(t('settings.field.model'), modelCtl, models.length ? '' : t('settings.config.modelNameHint')));

  const effortOptions: { value: string; label: string }[] = [{ value: '', label: t('settings.config.effortStandard') }];
  for (const e of efforts.length ? efforts : EFFORT_FALLBACK) {
    effortOptions.push({ value: e, label: e });
  }
  const effortCtl = ctl.select(effortOptions, cfg.reasoning_effort ?? null);
  form.appendChild(ctl.field(t('settings.config.effort'), effortCtl, efforts.length ? t('settings.config.effortHint') : t('settings.config.effortManual')));

  const baseUrlCtl = ctl.text(cfg.base_url ?? '', 'https://…/v1');
  form.appendChild(ctl.field('Base URL', baseUrlCtl));

  const apiKeyCtl = ctl.text('', t('settings.config.apiKeyPlaceholder'), 'password');
  form.appendChild(ctl.field('API Key', apiKeyCtl, t('settings.config.apiKeyHint')));

  const ctxWin = cfg.context_window ?? cfg.context_window_tokens ?? statusWindow;
  const ctxCtl = ctl.num(ctxWin, t('settings.config.contextWindowPlaceholder'));
  form.appendChild(ctl.field(t('settings.field.contextWindow'), ctxCtl));

  const maxOutCtl = ctl.num(cfg.max_output_tokens ?? null, t('settings.config.noLimit'));
  form.appendChild(ctl.field(t('settings.field.maxOutputTokens'), maxOutCtl));

  const maxStepsCtl = ctl.num(cfg.max_steps ?? null, t('settings.config.notSet'));
  form.appendChild(ctl.field(t('settings.field.maxSteps'), maxStepsCtl));

  const sysCtl = el('textarea', 'cfg-input cfg-sys') as HTMLTextAreaElement;
  sysCtl.rows = 6;
  sysCtl.placeholder = t('settings.config.systemPromptPlaceholder');
  sysCtl.value = cfg.system_prompt ?? '';
  form.appendChild(ctl.field(t('settings.field.systemPrompt'), sysCtl, t('settings.config.systemPromptHint')));

  // ---- 操作行 ----
  const actions = el('div', 'cfg-actions');
  const saveBtn = el('button', 'btn btn-accent', t('settings.action.save')) as HTMLButtonElement;
  saveBtn.type = 'button';
  const reloadBtn = el('button', 'btn btn-soft', t('settings.action.reload')) as HTMLButtonElement;
  reloadBtn.type = 'button';
  actions.appendChild(saveBtn);
  actions.appendChild(reloadBtn);
  form.appendChild(actions);

  const status = el('div', 'cfg-status');
  form.appendChild(status);

  container.appendChild(form);

  // ---- 校验 + 保存 ----
  const parseNum = (ctl2: HTMLInputElement, name: string): number | null => {
    const n = toNum(ctl2.value);
    if (Number.isNaN(n)) {
      status.className = 'cfg-status err';
      status.textContent = t('settings.config.notAValidNumber', { name });
      throw new Error('bad number: ' + name);
    }
    return n;
  };

  const doSave = () => {
    status.className = 'cfg-status';
    status.textContent = '';
    const patch: ConfigPatch = {};

    const model = modelCtl.value.trim();
    if (model !== '' && model !== (cfg.model ?? '')) patch.model = model;
    const baseUrl = baseUrlCtl.value.trim();
    if (baseUrl !== '' && baseUrl !== (cfg.base_url ?? '')) patch.base_url = baseUrl;
    if (apiKeyCtl.value.trim() !== '') patch.api_key = apiKeyCtl.value.trim();
    patch.reasoning_effort = effortCtl.value === '' ? null : effortCtl.value;
    patch.context_window = parseNum(ctxCtl, t('settings.field.contextWindow'));
    patch.max_output_tokens = parseNum(maxOutCtl, t('settings.field.maxOutputTokens'));
    patch.max_steps = parseNum(maxStepsCtl, t('settings.field.maxSteps'));
    patch.system_prompt = sysCtl.value;

    saveBtn.disabled = true;
    saveBtn.textContent = t('settings.config.saving');
    void api
      .saveConfig(patch)
      .then((d) => {
        status.className = 'cfg-status ok';
        status.textContent = d.ok === false ? t('settings.config.saveFailedRetry') : t('settings.config.saved');
        if (d.ok !== false) window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        status.className = 'cfg-status err';
        const e = err as Error;
        if (err instanceof ApiError && err.status === 409) {
          status.textContent = t('settings.config.busySave');
        } else if (err instanceof ApiError && (err.status === 405 || err.status === 404)) {
          status.textContent = t('settings.config.unsupportedSave');
        } else {
          status.textContent = t('settings.config.saveFailed', { reason: e.message || String(err) });
        }
      })
      .finally(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = t('settings.action.save');
      });
  };

  const doReload = () => {
    // W778：「重新载入」是显式动作 → 强拉一次并刷新缓存（首屏才走缓存）。
    void loadConfig({ refresh: true });
  };

  saveBtn.addEventListener('click', doSave);
  reloadBtn.addEventListener('click', doReload);
}

/** 载入当前配置并渲染表单（含 status 补充窗口信息）。
 *  第 11 轮：离屏构建 + 一次性替换（旧表单保留到新表单就绪，无空白帧）。
 *  W778：`opts.refresh !== true` 时首屏走配置缓存（statusline/cfg-cache.ts）——
 *  从选择器切过模型后马上打开设置页不会再有二次等待；「重新载入」显式强拉。 */
export async function loadConfig(opts: { refresh?: boolean } = {}): Promise<void> {
  const off = document.createElement('div');
  let cfg: ConfigInfo;
  try {
    cfg = opts.refresh === true ? await revalidateConfig() : await loadConfigCached();
  } catch (err) {
    off.appendChild(el('div', 'side-note err', t('settings.config.unavailable')));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    box.replaceChildren(...off.childNodes);
    statusHint.textContent = '';
    return;
  }
  let statusWindow: number | null = null;
  try {
    const st = await api.status();
    statusWindow = st?.context_usage?.window ?? null;
  } catch {
    /* status 仅作窗口补充，缺失无碍 */
  }
  try {
    renderForm(cfg, statusWindow, off);
    // 说明性技术文案已按要求移除（不再暴露数据源/端点/实现细节）。
    statusHint.textContent = '';
    box.replaceChildren(...off.childNodes);
  } catch (err) {
    off.appendChild(el('div', 'side-note err', t('settings.config.unavailable')));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    box.replaceChildren(...off.childNodes);
    statusHint.textContent = '';
  }
}

// ---- 左导航 + 右内容 -----------------------------------------------------------

const PANES = ['general', 'config', 'tools', 'archive', 'providers', 'prompts', 'permissions', 'plugins', 'usage'] as const;
type PaneName = (typeof PANES)[number];

let currentPane: PaneName = 'config';

function paneEl(name: PaneName): HTMLElement {
  return need<HTMLElement>('.settings-pane[data-pane="' + name + '"]');
}

function navEl(name: PaneName): HTMLElement {
  return need<HTMLElement>('.settings-nav-item[data-page="' + name + '"]');
}

const paneLoaded: Partial<Record<PaneName, boolean>> = {};

/** 加载指定 pane 内容（双缓冲；仅在首次或强制刷新时重建，切回零重建）。 */
function loadPane(name: PaneName): void {
  if (name === 'general') {
    // 独立「通用偏好」页：语言等全局偏好（首次进入时挂载；切回零重建由 showPane 保证）。
    mountGeneralPane(need<HTMLElement>('#settingsGeneral'));
  } else if (name === 'config') {
    void loadConfig();
  } else if (name === 'tools') {
    void loadToolsSection();
  } else if (name === 'archive') {
    // W786：这一格不再复用侧边栏会话管理，改为「归档会话管理」（只列已归档会话）
    void loadArchiveSection(
      need<HTMLElement>('#settingsArchive'),
      need<HTMLElement>('#settingsArchiveCount'),
    );
  } else if (name === 'providers') {
    void loadProviders();
  } else if (name === 'prompts') {
    void loadPrompts();
  } else if (name === 'permissions') {
    // W858：「权限预设」（内置三档 + 自定义档 + 会话档位选择器的取数口）
    void loadPermissionsSection();
  } else if (name === 'usage') {
    // W9103：「使用统计」（摘要条 + 热力图 + 趋势图；数据来自已有的用量账本聚合）
    mountUsagePane();
  } else {
    // W859：「插件」（客户端插件热开关 + 服务端插件只读清单）
    void loadPluginsSection();
  }
}

function showPane(name: PaneName): void {
  currentPane = name;
  for (const n of PANES) paneEl(n).classList.toggle('active', n === name);
  for (const n of PANES) navEl(n).classList.toggle('active', n === name);
  // 第 11 轮：切页只切 class（无重建）；内容首次加载后缓存，切回零闪烁
  if (!paneLoaded[name]) {
    paneLoaded[name] = true;
    loadPane(name);
  }
}

/** 强制刷新当前 pane（「重新载入」按钮 / 打开设置页时配置页）。 */
function forceLoadPane(name: PaneName): void {
  loadPane(name);
}

function reloadCurrentPane(): void {
  forceLoadPane(currentPane);
}

// ---- 页面开关 ----------------------------------------------------------------

/** 设置页在层级栈中的句柄（打开时 push 底层 closeSettings）。 */
let settingsOverlay: OverlayHandle | null = null;

export function openSettings(): void {
  page.classList.remove('hidden');
  // 任务 3：设置页作为最底层压栈——其上的二级弹窗/内联面板先于它被 Esc 关闭
  if (!settingsOverlay) settingsOverlay = pushOverlay(closeSettings);
  // 打开时配置页强制刷新（热调可能被 statusline 快速切换等改变）
  forceLoadPane('config');
  showPane('config');
}

export function closeSettings(): void {
  // 任务 3：关闭设置页时连带收起它派生的仍在栈上的层（不留孤儿弹窗）
  if (settingsOverlay) {
    const h = settingsOverlay;
    settingsOverlay = null;
    closeOverlaysAbove(h);
    popOverlay(h);
  }
  page.classList.add('hidden');
}

/**
 * W9103：左下角设置入口的用户名。
 *   取数失败（未登录 401 / 老服务没有这个端点 / 网络不通）一律**不显示**用户名 ——
 *   只留图标 + 「设置」。刻意不编占位名（如「未登录」「访客」）：那句话在
 *   「端点不存在」与「确实没登录」两种情况下都是猜测，而这里没有区分它们的信息。
 *   只在**取到非空用户名**时才把 `.hidden` 摘掉（节点常驻，只切 class）。
 */
function loadSettingsUser(): void {
  const node = document.getElementById('settingsUser');
  if (!node) return;
  void api
    .authCheck()
    .then((r) => {
      const user = typeof r.user === 'string' ? r.user.trim() : '';
      if (user === '') return;
      node.textContent = user;
      // title 给完整名字（可见文本可能被单行截断）。
      node.title = user;
      node.classList.remove('hidden');
    })
    .catch(() => {
      /* 未登录 / 端点缺失：保持隐藏，不编名字 */
    });
}

export function initSettingsPage(): void {
  // W9103：设置入口从顶栏（原 #btnConfig，已删除）挪到左侧栏左下角。
  need<HTMLElement>('#btnSettingsEntry').addEventListener('click', openSettings);
  need<HTMLElement>('#btnSettingsClose').addEventListener('click', closeSettings);
  need<HTMLElement>('#btnSettingsReload').addEventListener('click', reloadCurrentPane);
  for (const n of PANES) {
    navEl(n).addEventListener('click', () => showPane(n));
  }
  // Esc 关闭统一由 utils/overlays 层级栈处理（任务 3：唯一 document Esc 监听）
  installI18nSettings(); // i18n：静态 data-i18n 文案 + 语言切换重画
  initProvidersSection(); // #btnAddProvider
  initPromptsSection(); // #btnNewPrompt + scope 切换
  loadSettingsUser(); // W9103：左下角入口的用户名（取不到就不显示）
}
