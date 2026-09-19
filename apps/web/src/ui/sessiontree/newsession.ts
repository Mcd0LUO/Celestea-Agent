// ============================================================================
// ui/sessions/newsession.ts — 新建会话弹窗 / 新建工作区（W243/W245/W514/W701）
//   （W748 从 ui/sessions.ts 拆出；纯搬运，DOM/类名/文案/降级重试逐字未改。）
//   创建成功后的「刷新侧栏」经 NewsessionHost 回调编排入口（避免循环 import）。
// ============================================================================
import { api, userErrorText } from '../../api';
import { S } from '../../state';
import type { OverlayHandle } from '../../utils/overlays';
import { popOverlay, pushOverlay } from '../../utils/overlays';
import { el } from '../../utils/dom';
import { openFsBrowser } from '../fsbrowser';
import { openSession } from '../restore';
import { note } from './live';
import { getWsList, setActiveSession } from './store';
import { modeChoices } from '../mode/copy';
import { buildCreateReq } from '../mode/create-req';
import { t } from '../../i18n';

/** 新建后需要重新载入侧栏（= 编排入口的 loadSessions）。 */
export interface NewsessionHost {
  loadSessions(): Promise<void>;
}

/** 新建会话弹窗：标题 + 选择工作区（presetWs 预选）+ 可选模型。
 *  创建成功 → 自动激活（POST /api/sessions/{id}/activate）→ 树刷新 + 活跃高亮
 *  + 聊天区切换到新会话（空历史 + 「以下为本次会话」分隔线）。
 *  任一步失败给出具体提示（W243 端点未就绪时优雅降级）。 */
/** 单行文本输入框的 type 白名单（Enter 提交只在这些控件上生效）。 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
]);

/**
 * Enter 提交判据（W789）：「弹窗内的**单行文本输入框** + 纯 Enter」。
 *   · Shift+Enter 不提交（保留「不误触」的语义）；
 *   · <select> 展开发挥选条目作用的 Enter、按钮上的 Enter 都不提交 —— 不做元素判型
 *     的话，键盘用户在「工作区 / 模型 / 工作方式」下拉里按 Enter 会被当成「创建」；
 *   · <textarea> 不算（多行输入框里 Enter 的默认语义是换行）。
 * 纯函数：只读事件字段，不碰 DOM，可在 node 里直接断言。
 */
export function isSubmitEnter(e: { key: string; shiftKey: boolean; target: unknown }): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  const t = e.target as { tagName?: unknown; type?: unknown } | null;
  if (!t || typeof t.tagName !== 'string' || t.tagName.toUpperCase() !== 'INPUT') return false;
  const raw = typeof t.type === 'string' ? t.type.toLowerCase() : 'text';
  return TEXT_INPUT_TYPES.has(raw === '' ? 'text' : raw);
}

export function newSessionDialog(host: NewsessionHost, presetWs?: string): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card');
  card.appendChild(el('div', 'modal-card-title', t('shell.new.title')));
  // W786：标题也走「左列标签 + 右列控件」的两列网格，与下面的工作区/模型/提示词行对齐
  const titleInput = el('input', 'cfg-input') as HTMLInputElement;
  titleInput.placeholder = t('shell.new.titlePlaceholder');
  const titleRow = el('label', 'prov-field');
  titleRow.appendChild(el('span', 'prov-field-label', t('shell.field.title')));
  titleRow.appendChild(titleInput);
  card.appendChild(titleRow);

  const wsSel = document.createElement('select');
  wsSel.className = 'cfg-input';
  const optRoot = document.createElement('option');
  optRoot.value = '';
  optRoot.textContent = t('shell.new.rootWorkspace');
  wsSel.appendChild(optRoot);
  for (const w of getWsList()) {
    const o = document.createElement('option');
    o.value = w.name;
    o.textContent = w.name;
    wsSel.appendChild(o);
  }
  if (presetWs) wsSel.value = presetWs;
  const wsRow = el('label', 'prov-field');
  wsRow.appendChild(el('span', 'prov-field-label', t('settings.scope.workspace')));
  wsRow.appendChild(wsSel);
  card.appendChild(wsRow);

  // 可选模型（W243 任务4 / W262）：跟随默认 + available.models
  // W262：与状态栏模型弹层消费同一份清单（provider store + 静态兜底目录，
  // 后端按 id 去重并给出 provider 显示名），标签沿用「提供商 · id（显示名）」。
  const modelSel = document.createElement('select');
  modelSel.className = 'cfg-input';
  const optDef = document.createElement('option');
  optDef.value = '';
  optDef.textContent = t('shell.new.followDefault');
  modelSel.appendChild(optDef);
  const modelRow = el('label', 'prov-field');
  modelRow.appendChild(el('span', 'prov-field-label', t('settings.field.model')));
  modelRow.appendChild(modelSel);
  card.appendChild(modelRow);
  void api
    .config()
    .then((d) => {
      const models = d.available?.models ?? [];
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id;
        const name = m.name || m.id;
        const provider = (m.provider ?? '').trim();
        o.textContent =
          (provider ? provider + ' · ' : '') + m.id + (name !== m.id ? '（' + name + '）' : '');
        modelSel.appendChild(o);
      }
      if (!models.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = t('shell.new.noModels');
        o.disabled = true;
        modelSel.appendChild(o);
      }
    })
    .catch(() => {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = t('shell.new.modelsUnavailable');
      o.disabled = true;
      modelSel.appendChild(o);
    });

  // 工作方式（W788 设计 §3.2 主入口）：标准模式 / 执行模式（PTC），默认标准。
  // 与上面三行同款两列网格（.prov-field + .prov-field-label，沿用 --field-label-w）。
  // 只有「执行模式」才随请求携带 mode（默认路径与今天的请求体逐字节一致，K8）。
  const modeSel = document.createElement('select');
  modeSel.className = 'cfg-input';
  for (const m of modeChoices()) {
    const o = document.createElement('option');
    o.value = m.value;
    o.textContent = m.label;
    modeSel.appendChild(o);
  }
  modeSel.value = 'standard';
  const modeRow = el('label', 'prov-field');
  modeRow.appendChild(el('span', 'prov-field-label', t('shell.field.mode')));
  modeRow.appendChild(modeSel);
  card.appendChild(modeRow);

  // 可选提示词（W245 任务2）：跟随默认 + 注册的 prompts（标注全局/工作区）；404 隐藏
  const promptRow = el('label', 'prov-field');
  promptRow.appendChild(el('span', 'prov-field-label', t('shell.field.prompt')));
  const promptSel = document.createElement('select');
  promptSel.className = 'cfg-input';
  const optPrompt = document.createElement('option');
  optPrompt.value = '';
  optPrompt.textContent = t('shell.new.followDefault');
  promptSel.appendChild(optPrompt);
  promptRow.appendChild(promptSel);
  promptRow.style.display = 'none';
  card.appendChild(promptRow);
  void api
    .prompts()
    .then((d) => {
      const ps = d.prompts ?? [];
      if (!ps.length) return; // 无注册提示词：保持隐藏
      for (const p of ps) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name + ' (' + (p.scope === 'global' ? t('settings.scope.global') : t('settings.scope.workspace')) + ')' + (p.is_default ? ' · ' + t('settings.tag.default') : '');
        promptSel.appendChild(o);
      }
      promptRow.style.display = ''; // 数据就绪才显示（404 保持隐藏）
    })
    .catch(() => {
      /* 404：提示词注册未开放，保持隐藏 */
    });

  const status = el('div', 'ws-fs-status');
  card.appendChild(status);
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', t('settings.action.cancel')) as HTMLButtonElement;
  cancel.type = 'button';
  const create = el('button', 'btn btn-accent', t('shell.action.create')) as HTMLButtonElement;
  create.type = 'button';
  // 任务 3：挂到 body 的弹窗打开时 push 自身 close，Esc 只关栈顶一层
  let overlay: OverlayHandle | null = null;
  const close = () => {
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  overlay = pushOverlay(close);
  cancel.addEventListener('click', close);
  create.addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) {
      status.className = 'ws-fs-status err';
      status.textContent = t('shell.new.titleRequired');
      titleInput.focus();
      return;
    }
    const ws = wsSel.value === '' ? null : wsSel.value;
    const model = modelSel.value === '' ? undefined : modelSel.value;
    const prompt = promptSel.value === '' ? undefined : promptSel.value;
    create.disabled = true;
    create.textContent = t('shell.new.creating');
    const mode = modeSel.value;
    // W788：请求体组装收口在纯函数（buildCreateReq），便于机械断言 mode 的携带规则
    const doCreate = (includeOptional: boolean) =>
      api.createSession(buildCreateReq({ workspace: ws, title, model, prompt, mode }, includeOptional));
    void doCreate(true)
      .catch((err: unknown) => {
        // 降级：服务不认新增的可选字段（model / mode）时（4xx）重试不带它们
        const e = err as { status?: number };
        const optional = model !== undefined || mode !== 'standard';
        if (optional && e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
          return doCreate(false);
        }
        throw err;
      })
      .then(async (r) => {
        if (r.ok === false) {
          throw new Error(userErrorText(r.error, t('shell.new.rejected')));
        }
        // 定位新会话 id（响应优先；缺失则按标题取最新）
        let id = r.id;
        if (!id) {
          try {
            const d = await api.sessions();
            const cands = (d.sessions ?? []).filter((x) => x.title === title);
            cands.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
            id = cands[0]?.id;
          } catch {
            id = undefined;
          }
        }
        if (!id) {
          status.className = 'ws-fs-status err';
          status.textContent = t('shell.new.createdRefresh');
          close();
          void host.loadSessions();
          return;
        }
        // W514：立即打开新会话视图（不等激活结果），激活在后台进行
        openSession(id, { kind: 'session', title });
        setActiveSession(id);
        S.selSession = id;
        note(t('shell.new.createdOpened', { title }));
        void api
          .activateSession(id)
          .then((ar) => {
            if (ar.ok === false) note(t('shell.tree.viewOpenActivateFailed'));
          })
          .catch((err: unknown) => {
            note(t('shell.tree.viewOpenFailed', { reason: userErrorText(err, t('shell.new.activateFailed')) }));
          });
        close();
        void host.loadSessions();
      })
      .catch((err: unknown) => {
        status.className = 'ws-fs-status err';
        status.textContent = t('shell.new.failed', { reason: err instanceof Error ? err.message : String(err) });
        create.disabled = false;
        create.textContent = t('shell.action.create');
      });
  });
  // W789：弹窗内单行文本输入框里按 Enter = 点「创建」。不复制第二份提交逻辑 ——
  // 直接触发 create 的 click（标题校验 / 可选字段 4xx 降级重试 / 创建中禁用都复用它）。
  card.addEventListener('keydown', (e) => {
    if (!isSubmitEnter(e)) return;
    e.preventDefault();
    if (!create.disabled) create.click();
  });
  actions.appendChild(cancel);
  actions.appendChild(create);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  titleInput.focus();
}

/** 新建工作区：文件管理器弹窗（fs/browse 懒加载；缺失降级手输路径）。
 *  W701：浏览器本体已抽到 ui/fsbrowser.ts（与「提权 · 选择目录」共用同一体验）。 */
export function newWorkspaceDialog(host: NewsessionHost): void {
  openFsBrowser({
    title: t('shell.new.wsTitle'),
    note: t('shell.new.wsNote'),
    confirmLabel: t('shell.action.create'),
    busyLabel: t('shell.new.wsBusy'),
    fallbackNote: t('shell.new.wsFallback'),
    onPick: (path, ui) => {
      ui.setBusy(true);
      void api
        .createWorkspaceByPath(path)
        .then((r) => {
          if (r.ok === false) {
            ui.status.className = 'ws-fs-status err';
            ui.status.textContent = t('shell.new.wsRegisterFailed', { reason: userErrorText(r.error, t('shell.new.wsCheckPath')) });
            ui.setBusy(false);
            return;
          }
          note(t('shell.new.wsRegistered', { path }));
          ui.close();
          void host.loadSessions();
        })
        .catch((err: unknown) => {
          ui.status.className = 'ws-fs-status err';
          ui.status.textContent = t('shell.new.wsRegisterFailed', { reason: userErrorText(err, t('shell.new.wsCheckPath')) });
          ui.setBusy(false);
        });
    },
  });
}
