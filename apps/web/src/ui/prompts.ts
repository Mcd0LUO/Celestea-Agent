// ============================================================================
// ui/prompts.ts — 设置页「提示词」页（W245 契约，端点 404 优雅降级）：
//   分「全局 / 工作区」scope（工作区模式带工作区下拉）；列表每行：
//   名称 / 作用域徽章 / 默认 / 活跃（active_prompt 高亮）+ 编辑 / 设为默认 / 删除；
//   编辑弹窗：名称 + 各段覆盖编辑器（继承 checkbox + textarea）+ 变量帮助表；
//   新建入口（pane 头部按钮）。
//   GET /api/prompts?workspace= · POST /api/prompts (upsert) · /{id}/delete · /{id}/default。
//   第 11 轮铁律：列表刷新全部离屏构建 + 单次替换。
// ============================================================================
import { api, userErrorText } from '../api';
import { el, need } from '../utils/dom';
import type { PromptInfo, PromptSection } from '../types';
import { confirmDialog } from './confirm';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';

const boxEl = need<HTMLElement>('#settingsPrompts');
const wrapEl = need<HTMLElement>('#promptsWrap');

const VARIABLES: readonly [string, string][] = [
  ['{{model}}', '当前模型'],
  ['{{provider}}', '提供商'],
  ['{{base_url}}', 'API 地址'],
  ['{{workspace}}', '工作区名'],
  ['{{session}}', '会话标题'],
  ['{{tools}}', '工具清单'],
  ['{{context_window}}', '上下文窗口'],
  ['{{max_output_tokens}}', '最大输出 tokens'],
  ['{{date}}', '当前日期'],
];

let scope: 'global' | 'workspace' = 'global';
let curWs = ''; // 工作区模式下的工作区名
let sections: PromptSection[] = [];
let prompts: PromptInfo[] = [];
let activePrompt: string | null = null;

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeLabel(sc: string): string {
  return sc === 'global' ? '全局' : '工作区';
}

// ---- 列表 ----------------------------------------------------------------------

function renderList(): void {
  const off = document.createElement('div');
  if (!prompts.length) {
    off.appendChild(
      el('div', 'side-note', scope === 'global' ? '暂无全局提示词 · 点击「新建提示词」创建' : '该工作区暂无提示词 · 点击「新建提示词」创建'),
    );
    boxEl.replaceChildren(...off.childNodes);
    return;
  }
  const table = el('table', 'prompts-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['名称', '作用域', '状态', '操作']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const p of prompts) {
    const tr = el('tr');
    if (p.id === activePrompt) tr.classList.add('is-active');
    const tdName = el('td', 'prompts-td-name');
    tdName.appendChild(el('span', 'prompt-name', p.name || p.id));
    if (p.id === activePrompt) tdName.appendChild(el('span', 'prompt-badge active', '活跃'));
    tr.appendChild(tdName);
    tr.appendChild(el('td', 'prompts-td-scope', scopeLabel(p.scope)));
    const tdState = el('td', 'prompts-td-state');
    if (p.is_default) tdState.appendChild(el('span', 'prompt-badge def', '默认'));
    if (!p.is_default && p.id !== activePrompt) tdState.textContent = '—';
    tr.appendChild(tdState);
    const tdOps = el('td', 'prompts-td-ops');
    const edit = el('button', 'btn-mini', '编辑') as HTMLButtonElement;
    edit.type = 'button';
    edit.addEventListener('click', () => openEditor(p));
    const def = el('button', 'btn-mini', '设为默认') as HTMLButtonElement;
    def.type = 'button';
    def.disabled = !!p.is_default;
    def.addEventListener('click', () => {
      void api
        .setDefaultPrompt(p.id, scope === 'global' ? undefined : curWs || undefined)
        .then(() => {
          note('已设为默认：' + (p.name || p.id));
          void loadPrompts();
        })
        .catch((err: unknown) => note('设为默认失败：' + fmtErr(err)));
    });
    const del = el('button', 'btn-mini danger', '删除') as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => {
      void confirmDialog({
        title: '删除提示词',
        message: '确认删除提示词「' + (p.name || p.id) + '」？',
        okLabel: '删除',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void api
          .deletePrompt(p.id, scope === 'global' ? undefined : curWs || undefined)
          .then(() => {
            note('已删除：' + (p.name || p.id));
            void loadPrompts();
          })
          .catch((err: unknown) => note('删除失败：' + fmtErr(err)));
      });
    });
    tdOps.appendChild(edit);
    tdOps.appendChild(def);
    tdOps.appendChild(del);
    tr.appendChild(tdOps);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  off.appendChild(table);
  off.appendChild(el('div', 'prompts-note', '「活跃」= 当前会话正在使用的提示词 · 「默认」= 新建会话时的默认选项'));
  boxEl.replaceChildren(...off.childNodes);
}

function note(text: string): void {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.textContent = text;
}

// ---- 编辑/新建弹窗 -------------------------------------------------------------------

function openEditor(existing: PromptInfo | null): void {
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prompt-modal');
  card.appendChild(el('div', 'modal-card-title', existing ? '编辑提示词：' + (existing.name || existing.id) : '新建提示词'));

  // 变量帮助表
  const varsHelp = el('details', 'prompt-vars');
  const vs = document.createElement('summary');
  vs.textContent = '可用变量';
  varsHelp.appendChild(vs);
  const vt = el('table', 'prompt-vars-table');
  const vtb = el('tbody');
  for (const [v, d] of VARIABLES) {
    const r = el('tr');
    r.appendChild(el('td', 'prompt-var-code', v));
    r.appendChild(el('td', 'prompt-var-desc', d));
    vtb.appendChild(r);
  }
  vt.appendChild(vtb);
  varsHelp.appendChild(vt);
  card.appendChild(varsHelp);

  const nameRow = el('label', 'prov-field');
  nameRow.appendChild(el('span', 'prov-field-label', '名称'));
  const nameInput = el('input', 'cfg-input') as HTMLInputElement;
  nameInput.placeholder = '提示词名称';
  nameInput.value = existing?.name ?? '';
  nameRow.appendChild(nameInput);
  card.appendChild(nameRow);

  const status = el('div', 'ws-fs-status');
  card.appendChild(status);

  const secWrap = el('div', 'prompt-secs');
  card.appendChild(secWrap);
  if (!sections.length) {
    secWrap.appendChild(el('div', 'side-note', '暂不支持分段编辑，可直接保存整体提示词'));
  }
  // 覆盖编辑器：未覆盖段 = 继承；textarea 非空 = 覆盖。
  // P0-4 回填：编辑已存在提示词时，必须把该 prompt 的 section_overrides
  // 回填进对应段（取消「继承」并填入覆盖文本），保存时未改动的回填项
  // 原样提交 —— 否则保存会把旧覆盖全部清掉。
  // 语义（W246 裁定）：「继承」勾选 = 删除该段 override、恢复上层模板；
  // 不勾选 = 保留/新增覆盖；不勾选且文本为空 = 校验错误（不提交）。
  const rows: { sec: PromptSection; ta: HTMLTextAreaElement; inherit: HTMLInputElement }[] = [];
  for (const sec of sections) {
    const row = el('div', 'prompt-sec-row');
    const head = el('div', 'prompt-sec-head');
    head.appendChild(el('span', 'prompt-sec-name', sec.name || sec.id));
    head.appendChild(el('span', 'prompt-sec-scope', scopeLabel(sec.scope)));
    const inherit = el('input', 'prompt-inherit') as HTMLInputElement;
    inherit.type = 'checkbox';
    inherit.checked = true;
    const inheritLabel = el('label', 'prompt-inherit-label');
    inheritLabel.appendChild(inherit);
    inheritLabel.appendChild(el('span', null, '继承'));
    head.appendChild(inheritLabel);
    row.appendChild(head);
    const ta = el('textarea', 'prompt-sec-ta cfg-input') as HTMLTextAreaElement;
    ta.rows = 3;
    ta.disabled = true;
    ta.placeholder = '（继承自内置模板）';
    const ov = existing?.section_overrides?.[sec.id];
    if (ov !== undefined) {
      inherit.checked = false;
      ta.value = ov;
    }
    row.appendChild(ta);
    secWrap.appendChild(row);
    rows.push({ sec, ta, inherit });
    const sync = () => {
      ta.disabled = inherit.checked;
      ta.placeholder = inherit.checked ? '（继承自内置模板）' : '覆盖模板文本…';
      row.classList.toggle('inherited', inherit.checked);
    };
    inherit.addEventListener('change', sync);
    sync();
  }

  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const save = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  save.type = 'button';
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
  save.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.className = 'ws-fs-status err';
      status.textContent = '名称不能为空';
      nameInput.focus();
      return;
    }
    // 「继承」勾选 = 删除该段 override（提交时省略该 key）；不勾选 = 保留
    // 或新增覆盖。不勾选但文本为空是显式校验错误 —— 空文本与「清除覆盖」
    // 不允许隐式混淆。
    const overrides: Record<string, string> = {};
    if (!rows.length && existing?.section_overrides) {
      // 降级态（后端未返回段定义）：保留既有覆盖，保存不得误清空。
      Object.assign(overrides, existing.section_overrides);
    }
    for (const r of rows) {
      if (r.inherit.checked) continue;
      if (r.ta.value.trim() === '') {
        status.className = 'ws-fs-status err';
        status.textContent = '段「' + (r.sec.name || r.sec.id) + '」未填覆盖文本：请填写，或勾选「继承」以恢复上层模板';
        r.ta.focus();
        return;
      }
      overrides[r.sec.id] = r.ta.value;
    }
    save.disabled = true;
    save.textContent = '保存中…';
    void api
      .savePrompt({
        id: existing?.id ?? 'p' + Date.now().toString(36),
        name,
        section_overrides: overrides,
        // P0-4：全局 scope 省略 workspace；工作区 scope 传真实名称。
        workspace: scope === 'workspace' ? curWs || undefined : undefined,
      })
      .then((r) => {
        if (r.ok === false) {
          status.className = 'ws-fs-status err';
          status.textContent = '保存失败：' + userErrorText(r.error, '请检查填写内容');
          save.disabled = false;
          save.textContent = '保存';
          return;
        }
        close();
        // persist+prepare+swap 全部成功后才会走到这里（409/500 都会抛错），
        // 所以此时提示「已热应用」是真实语义。
        note('已保存：' + name);
        void loadPrompts();
      })
      .catch((err: unknown) => {
        status.className = 'ws-fs-status err';
        status.textContent = '保存失败：' + fmtErr(err);
        save.disabled = false;
        save.textContent = '保存';
      });
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  nameInput.focus();
}

// ---- 加载主流程 ---------------------------------------------------------------------

/** 竞态守卫序号：scope/工作区切换或重复加载时，晚到的旧响应一律丢弃。 */
let loadSeq = 0;

export async function loadPrompts(): Promise<void> {
  const seq = ++loadSeq;
  const off = document.createElement('div');
  let resp;
  try {
    resp = await api.prompts(scope === 'workspace' ? curWs || undefined : undefined);
  } catch (err) {
    if (seq !== loadSeq) return; // 旧 scope 的失败结果，丢弃
    off.appendChild(el('div', 'side-note err', '当前版本不支持提示词管理'));
    off.appendChild(el('div', 'side-note', fmtErr(err)));
    boxEl.replaceChildren(...off.childNodes);
    return;
  }
  if (seq !== loadSeq) return; // 旧 scope 的结果不得覆盖新状态
  sections = resp.sections ?? [];
  prompts = resp.prompts ?? [];
  activePrompt = resp.active_prompt ?? null;
  renderList();
}

/** 装配（config.ts 调用一次；幂等）。 */
export function initPromptsSection(): void {
  const seg = el('div', 'prompts-scope');
  const g = el('button', 'prompts-scope-btn' + (scope === 'global' ? ' active' : ''), '全局') as HTMLButtonElement;
  g.type = 'button';
  const w = el('button', 'prompts-scope-btn' + (scope === 'workspace' ? ' active' : ''), '工作区') as HTMLButtonElement;
  w.type = 'button';
  const wsSel = document.createElement('select');
  wsSel.className = 'cfg-input prompts-ws-sel';
  wsSel.style.display = scope === 'workspace' ? '' : 'none';
  const setScope = (sc: 'global' | 'workspace') => {
    scope = sc;
    g.classList.toggle('active', sc === 'global');
    w.classList.toggle('active', sc === 'workspace');
    wsSel.style.display = sc === 'workspace' ? '' : 'none';
  };
  g.addEventListener('click', () => {
    setScope('global');
    void loadPrompts();
  });
  w.addEventListener('click', () => {
    setScope('workspace');
    void loadPrompts();
  });
  seg.appendChild(g);
  seg.appendChild(w);
  seg.appendChild(wsSel);
  wrapEl.appendChild(seg);

  // 工作区下拉（仅 workspace 模式显示）
  void api
    .workspaces()
    .then((d) => {
      const list = d.workspaces ?? [];
      wsSel.replaceChildren();
      for (const ws of list) {
        const o = document.createElement('option');
        o.value = ws.name;
        o.textContent = ws.name;
        wsSel.appendChild(o);
      }
      if (list.length) {
        curWs = list[0]!.name;
        wsSel.value = curWs;
        wsSel.disabled = false;
      } else {
        wsSel.disabled = true;
      }
    })
    .catch(() => {
      wsSel.disabled = true;
    });
  wsSel.addEventListener('change', () => {
    curWs = wsSel.value;
    void loadPrompts();
  });

  need<HTMLButtonElement>('#btnNewPrompt').addEventListener('click', () => openEditor(null));
  void loadPrompts();
}
