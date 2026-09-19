// ============================================================================
// ui/permissions/editor.ts — 自定义预设编辑器（新建 / 编辑同一表单）。
//
//   字段：id（新建必填、编辑锁定）、label、五个开关、writeRoots（手输绝对路径或
//   目录选择器逐条添加/移除）、toolDeny（从 GET /api/tools 的当前工具名多选）。
//   提交走 actions（POST / PUT）：乐观插卡在 actions 里做；失败时把**服务端原因**
//   就地写在表单旁（.perm-editor-status），并把列表回滚到动作前。
//   铁律 1：整张表单离屏构建 + replaceChildren 单次挂载。
// ============================================================================
import { api } from '../../api';
import type { PermissionPreset } from '../../types/permission';
import { el } from '../../utils/dom';
import { pickDirectory } from '../fsbrowser';
import { createPreset, updatePreset, type ActionResult } from './actions';
import { PRESET_ID_RE, unsandboxedNoteText } from './copy';
import { t } from '../../i18n';

const MAX_ROOTS = 32;
const MAX_TOOLS = 64;
/** 提示语做成函数：语言切换后必须跟着变（不能固化在模块加载时）。 */
function idHint(): string {
  return t('settings.permissions.idHint');
}
function rootsHint(): string {
  return t('settings.permissions.rootsHint');
}
function toolsHint(): string {
  return t('settings.permissions.toolsHint');
}

export interface EditorHandlers {
  onSettled(result: ActionResult): void;
  onCancel(): void;
}

function textInput(value: string, placeholder: string): HTMLInputElement {
  const i = el('input', 'cfg-input') as HTMLInputElement;
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function miniButton(label: string, run: () => void): HTMLButtonElement {
  const b = el('button', 'btn-mini', label) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
}

/** 单控件字段（label 包裹，点标签即聚焦控件）。 */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', 'cfg-field');
  row.appendChild(el('span', 'cfg-label', label));
  row.appendChild(control);
  if (hint !== undefined && hint !== '') row.appendChild(el('span', 'cfg-hint', hint));
  return row;
}

/** 组合控件字段（div 包裹：内部有多个可点元素，不能整体当 label）。 */
function fieldBox(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = el('div', 'cfg-field');
  row.appendChild(el('span', 'cfg-label', label));
  const box = el('div', 'perm-field-body');
  box.appendChild(control);
  if (hint !== undefined && hint !== '') box.appendChild(el('span', 'cfg-hint', hint));
  row.appendChild(box);
  return row;
}

interface Switch {
  input: HTMLInputElement;
  row: HTMLElement;
}

function switchRow(label: string, checked: boolean, hint?: string): Switch {
  const input = el('input', 'perm-switch-input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  const row = el('label', 'perm-switch');
  row.appendChild(input);
  row.appendChild(el('span', 'perm-switch-label', label));
  if (hint !== undefined && hint !== '') row.appendChild(el('span', 'cfg-hint', hint));
  return { input, row };
}

// ---- writeRoots：逐条添加/移除（目录选择器 + 手输绝对路径） ---------------------

interface RootsEditor {
  el: HTMLElement;
  value(): string[];
}

function rootsEditor(initial: string[]): RootsEditor {
  const box = el('div', 'perm-roots-edit');
  const list = el('div', 'perm-roots-list');
  const roots = initial.slice(0, MAX_ROOTS);
  const redraw = (): void => {
    const off = document.createElement('div');
    for (const root of roots) {
      const row = el('div', 'perm-root-row');
      row.appendChild(el('code', 'perm-root', root));
      row.appendChild(miniButton(t('settings.action.remove'), () => {
        const i = roots.indexOf(root);
        if (i >= 0) roots.splice(i, 1);
        redraw();
      }));
      off.appendChild(row);
    }
    if (roots.length === 0) off.appendChild(el('div', 'side-note', t('settings.permissions.noExtraRootsAdded')));
    list.replaceChildren(...off.childNodes);
  };
  const add = (raw: string): void => {
    const path = raw.trim();
    if (path === '' || roots.includes(path) || roots.length >= MAX_ROOTS) return;
    roots.push(path);
    redraw();
  };
  const input = textInput('', t('settings.permissions.rootPlaceholder'));
  const addRow = el('div', 'perm-addrow');
  addRow.append(
    input,
    miniButton(t('settings.action.add'), () => {
      add(input.value);
      input.value = '';
    }),
    miniButton(t('settings.permissions.chooseDir'), () => {
      void pickDirectory(t('settings.permissions.chooseExtraDir'), rootsHint()).then((picked) => {
        if (picked !== null) add(picked);
      });
    }),
  );
  box.append(list, addRow);
  redraw();
  return { el: box, value: () => roots.slice() };
}

// ---- toolDeny：当前工具名多选（toolDeny 里已有的名字必须保留可选项） -----------

interface ToolsEditor {
  el: HTMLElement;
  value(): string[];
}

function toolRow(name: string, checked: boolean, chosen: Set<string>): HTMLElement {
  const input = el('input', 'perm-tool-input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => {
    if (input.checked) chosen.add(name);
    else chosen.delete(name);
  });
  const row = el('label', 'perm-tool');
  row.append(input, el('span', 'perm-tool-name', name));
  return row;
}

function toolsEditor(initial: string[]): ToolsEditor {
  const box = el('div', 'perm-tools');
  const chosen = new Set(initial);
  const paint = (names: string[], note: string): void => {
    const off = document.createElement('div');
    const seen = new Set<string>();
    for (const name of names.slice(0, MAX_TOOLS)) {
      off.appendChild(toolRow(name, chosen.has(name), chosen));
      seen.add(name);
    }
    // 已有 toolDeny 但当前清单里没有的名字：保留为勾选项，绝不静默丢弃
    for (const name of initial) if (!seen.has(name)) off.appendChild(toolRow(name, true, chosen));
    if (note !== '') off.appendChild(el('div', 'side-note', note));
    box.replaceChildren(...off.childNodes);
  };
  paint(initial, '');
  void api
    .tools()
    .then((r) => {
      const names = (r.tools ?? [])
        .map((t) => t.name)
        .filter((n) => typeof n === 'string' && n !== '');
      paint(names, names.length === 0 ? t('settings.permissions.toolsNotLoaded') : '');
    })
    .catch(() => paint(initial, t('settings.permissions.toolsUnavailableReload')));
  return { el: box, value: () => Array.from(chosen).slice(0, MAX_TOOLS) };
}

// ---- 编辑器本体 ---------------------------------------------------------------

export function closeEditor(host: HTMLElement): void {
  host.classList.add('hidden');
  host.replaceChildren();
}

export function openEditor(
  host: HTMLElement,
  preset: PermissionPreset | null,
  handlers: EditorHandlers,
): void {
  const isNew = preset === null;
  const idCtl = textInput(preset?.id ?? '', t('settings.permissions.idPlaceholder'));
  idCtl.disabled = !isNew;
  const labelCtl = textInput(preset?.label ?? '', t('settings.permissions.labelPlaceholder'));
  const net = switchRow(t('settings.permissions.networkOn'), preset?.network === true);
  const ws = switchRow(t('settings.permissions.workspaceOn'), preset?.workspaceWritable === true);
  const tr = switchRow(t('settings.permissions.toolRootOn'), preset?.toolRootsWritable === true);
  const ap = switchRow(t('settings.permissions.allPathsOn'), preset?.allPaths === true, t('settings.permissions.allPathsRisk'));
  const unsb = switchRow(t('settings.permissions.unsandboxedDeclare'), preset?.unsandboxed === true, unsandboxedNoteText());
  const roots = rootsEditor(preset?.writeRoots ?? []);
  const tools = toolsEditor(preset?.toolDeny ?? []);
  const status = el('div', 'perm-editor-status');
  const save = el('button', 'btn btn-accent', t('settings.action.save')) as HTMLButtonElement;
  save.type = 'button';
  const cancel = el('button', 'btn btn-soft', t('settings.action.cancel')) as HTMLButtonElement;
  cancel.type = 'button';

  const setStatus = (cls: string, text: string): void => {
    status.className = 'perm-editor-status' + (cls === '' ? '' : ' ' + cls);
    status.textContent = text;
  };
  const submit = (): void => {
    const id = idCtl.value.trim();
    if (id === '') return setStatus('err', t('settings.permissions.saveIdRequired'));
    if (!PRESET_ID_RE.test(id)) return setStatus('err', t('settings.permissions.idInvalid', { hint: idHint() }));
    const next: PermissionPreset = {
      id,
      label: labelCtl.value.trim() || id,
      network: net.input.checked,
      workspaceWritable: ws.input.checked,
      toolRootsWritable: tr.input.checked,
      writeRoots: roots.value(),
      allPaths: ap.input.checked,
      unsandboxed: unsb.input.checked,
      toolDeny: tools.value(),
    };
    save.disabled = true;
    setStatus('', '');
    void (isNew ? createPreset(next) : updatePreset(next)).then((result) => {
      if (result.ok) {
        handlers.onSettled(result);
        return;
      }
      save.disabled = false;
      setStatus('err', result.text); // 服务端原因就地显示；坏档已被回滚
    });
  };
  save.addEventListener('click', submit);
  cancel.addEventListener('click', () => handlers.onCancel());

  const form = el('form', 'cfg-form perm-editor-form');
  form.appendChild(
    el('div', 'perm-editor-title', isNew ? t('settings.permissions.newTitle') : t('settings.permissions.editTitle', { id: preset?.id ?? '' })),
  );
  form.appendChild(field(t('settings.permissions.idField'), idCtl, isNew ? idHint() : t('settings.permissions.idLocked')));
  form.appendChild(field(t('settings.permissions.labelField'), labelCtl, t('settings.permissions.labelHint')));
  const switches = el('div', 'perm-switches');
  for (const s of [net, ws, tr, ap, unsb]) switches.appendChild(s.row);
  form.appendChild(fieldBox(t('settings.permissions.switches'), switches));
  form.appendChild(fieldBox(t('settings.permissions.extraRootsLabel'), roots.el, rootsHint()));
  form.appendChild(fieldBox(t('settings.permissions.toolsField'), tools.el, toolsHint()));
  const actions = el('div', 'cfg-actions');
  actions.append(save, cancel);
  form.appendChild(actions);
  form.appendChild(status);

  const off = document.createElement('div');
  off.appendChild(form);
  host.replaceChildren(...off.childNodes);
  host.classList.remove('hidden');
}
