// ============================================================================
// ui/config.ts — 「通用设置」页（左导航 + 右内容，取代原 #modal 弹层）：
//   导航页：「通用配置」（热调表单）/「工具」（清单表格）/「会话」（管理）。
//   模型下拉用 available.models（value=id / label=name，缺失降级手输）；
//   effort 档位 + 「标准（清除）」；保存 POST /api/config（409/404/405/400 有提示）。
// ============================================================================
import { api, ApiError } from '../api';
import { loadConfigCached, revalidateConfig } from '../statusline/cfg-cache'; // W778：首屏走配置缓存
import { el, need } from '../utils/dom';
import { closeOverlaysAbove, popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { ConfigInfo, ConfigPatch } from '../types';
import { loadToolsSection } from './tools';
import { loadTreeInto as loadSessionTree } from './sessions';
import { initProvidersSection, loadProviders } from './providers';
import { initPromptsSection, loadPrompts } from './prompts';

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
      const extra = el('option', null, cur + '（当前）') as HTMLOptionElement;
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
    : ctl.text(cfg.model ?? '', '模型名称');
  form.appendChild(ctl.field('模型', modelCtl, models.length ? '' : '请手动填写模型名称'));

  const effortOptions: { value: string; label: string }[] = [{ value: '', label: '标准（清除）' }];
  for (const e of efforts.length ? efforts : EFFORT_FALLBACK) {
    effortOptions.push({ value: e, label: e });
  }
  const effortCtl = ctl.select(effortOptions, cfg.reasoning_effort ?? null);
  form.appendChild(ctl.field('推理档位', effortCtl, efforts.length ? '空 = 标准档' : '请手动填写档位'));

  const baseUrlCtl = ctl.text(cfg.base_url ?? '', 'https://…/v1');
  form.appendChild(ctl.field('Base URL', baseUrlCtl));

  const apiKeyCtl = ctl.text('', '留空则保持当前密钥不变', 'password');
  form.appendChild(ctl.field('API Key', apiKeyCtl, '不会读取或显示已保存的密钥明文'));

  const ctxWin = cfg.context_window ?? cfg.context_window_tokens ?? statusWindow;
  const ctxCtl = ctl.num(ctxWin, '默认 1M（1000000 tokens）');
  form.appendChild(ctl.field('上下文窗口', ctxCtl));

  const maxOutCtl = ctl.num(cfg.max_output_tokens ?? null, '未限制');
  form.appendChild(ctl.field('最大输出 tokens', maxOutCtl));

  const maxStepsCtl = ctl.num(cfg.max_steps ?? null, '未设置');
  form.appendChild(ctl.field('最大步数', maxStepsCtl));

  const sysCtl = el('textarea', 'cfg-input cfg-sys') as HTMLTextAreaElement;
  sysCtl.rows = 6;
  sysCtl.placeholder = '系统提示词（留空 = 保持默认）';
  sysCtl.value = cfg.system_prompt ?? '';
  form.appendChild(ctl.field('系统提示词', sysCtl, '发送给模型的指令前缀'));

  // ---- 操作行 ----
  const actions = el('div', 'cfg-actions');
  const saveBtn = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  saveBtn.type = 'button';
  const reloadBtn = el('button', 'btn btn-soft', '重新载入') as HTMLButtonElement;
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
      status.textContent = '「' + name + '」不是合法数字';
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
    patch.context_window = parseNum(ctxCtl, '上下文窗口');
    patch.max_output_tokens = parseNum(maxOutCtl, '最大输出 tokens');
    patch.max_steps = parseNum(maxStepsCtl, '最大步数');
    patch.system_prompt = sysCtl.value;

    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    void api
      .saveConfig(patch)
      .then((d) => {
        status.className = 'cfg-status ok';
        status.textContent = d.ok === false ? '保存失败，请重试' : '已保存';
        if (d.ok !== false) window.dispatchEvent(new Event('studio:config-saved'));
      })
      .catch((err: unknown) => {
        status.className = 'cfg-status err';
        const e = err as Error;
        if (err instanceof ApiError && err.status === 409) {
          status.textContent = '本轮对话仍在进行，请在结束后再保存。';
        } else if (err instanceof ApiError && (err.status === 405 || err.status === 404)) {
          status.textContent = '当前版本不支持在线保存配置，请升级后重试';
        } else {
          status.textContent = '保存失败：' + (e.message || String(err));
        }
      })
      .finally(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
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
    off.appendChild(el('div', 'side-note err', '配置暂不可用'));
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
    off.appendChild(el('div', 'side-note err', '配置暂不可用'));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    box.replaceChildren(...off.childNodes);
    statusHint.textContent = '';
  }
}

// ---- 左导航 + 右内容 -----------------------------------------------------------

const PANES = ['config', 'tools', 'sessions', 'providers', 'prompts'] as const;
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
  if (name === 'config') {
    void loadConfig();
  } else if (name === 'tools') {
    void loadToolsSection();
  } else if (name === 'sessions') {
    void loadSessionTree(
      need<HTMLElement>('#settingsSessions'),
      need<HTMLElement>('#settingsSessionCount'),
    );
  } else if (name === 'providers') {
    void loadProviders();
  } else {
    void loadPrompts();
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

export function initSettingsPage(): void {
  need<HTMLElement>('#btnConfig').addEventListener('click', openSettings);
  need<HTMLElement>('#btnSettingsClose').addEventListener('click', closeSettings);
  need<HTMLElement>('#btnSettingsReload').addEventListener('click', reloadCurrentPane);
  for (const n of PANES) {
    navEl(n).addEventListener('click', () => showPane(n));
  }
  // Esc 关闭统一由 utils/overlays 层级栈处理（任务 3：唯一 document Esc 监听）
  initProvidersSection(); // #btnAddProvider
  initPromptsSection(); // #btnNewPrompt + scope 切换
}
