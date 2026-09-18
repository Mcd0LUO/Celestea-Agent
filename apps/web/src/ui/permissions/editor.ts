// ============================================================================
// ui/permissions/editor.ts — 自定义预设编辑器（新建 / 编辑同一表单）。
//
//   字段：id（新建必填、编辑锁定）、label、四个开关、writeRoots（手输绝对路径或
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
import { PRESET_ID_RE, UNSANDBOXED_NOTE } from './copy';

const MAX_ROOTS = 32;
const MAX_TOOLS = 64;
const ID_HINT = '小写字母开头，只用小写字母、数字、下划线或连字符';
const ROOTS_HINT = '额外可写目录：工作区与工具根之外仍需写入的绝对路径';
const TOOLS_HINT = '勾选后该工具从本档会话的工具面移除';

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
      row.appendChild(miniButton('移除', () => {
        const i = roots.indexOf(root);
        if (i >= 0) roots.splice(i, 1);
        redraw();
      }));
      off.appendChild(row);
    }
    if (roots.length === 0) off.appendChild(el('div', 'side-note', '未添加额外可写目录'));
    list.replaceChildren(...off.childNodes);
  };
  const add = (raw: string): void => {
    const path = raw.trim();
    if (path === '' || roots.includes(path) || roots.length >= MAX_ROOTS) return;
    roots.push(path);
    redraw();
  };
  const input = textInput('', '绝对路径，例如 /srv/data');
  const addRow = el('div', 'perm-addrow');
  addRow.append(
    input,
    miniButton('添加', () => {
      add(input.value);
      input.value = '';
    }),
    miniButton('选择目录', () => {
      void pickDirectory('选择额外可写目录', ROOTS_HINT).then((picked) => {
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
      paint(names, names.length === 0 ? '未取到工具清单，可稍后重新载入' : '');
    })
    .catch(() => paint(initial, '工具清单暂不可用，可稍后重新载入'));
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
  const idCtl = textInput(preset?.id ?? '', '例如 deploy-docs');
  idCtl.disabled = !isNew;
  const labelCtl = textInput(preset?.label ?? '', '档位显示名');
  const net = switchRow('网络访问', preset?.network === true);
  const ws = switchRow('工作区可写', preset?.workspaceWritable === true);
  const tr = switchRow('工具根可写', preset?.toolRootsWritable === true);
  const unsb = switchRow('免沙箱（声明）', preset?.unsandboxed === true, UNSANDBOXED_NOTE);
  const roots = rootsEditor(preset?.writeRoots ?? []);
  const tools = toolsEditor(preset?.toolDeny ?? []);
  const status = el('div', 'perm-editor-status');
  const save = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  save.type = 'button';
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';

  const setStatus = (cls: string, text: string): void => {
    status.className = 'perm-editor-status' + (cls === '' ? '' : ' ' + cls);
    status.textContent = text;
  };
  const submit = (): void => {
    const id = idCtl.value.trim();
    if (id === '') return setStatus('err', '请填写预设 id');
    if (!PRESET_ID_RE.test(id)) return setStatus('err', '预设 id ' + ID_HINT);
    const next: PermissionPreset = {
      id,
      label: labelCtl.value.trim() || id,
      network: net.input.checked,
      workspaceWritable: ws.input.checked,
      toolRootsWritable: tr.input.checked,
      writeRoots: roots.value(),
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
    el('div', 'perm-editor-title', isNew ? '新建自定义预设' : '编辑自定义预设：' + (preset?.id ?? '')),
  );
  form.appendChild(field('预设 id', idCtl, isNew ? ID_HINT : '编辑时 id 不可改'));
  form.appendChild(field('显示名', labelCtl, '留空则用 id 作为显示名'));
  const switches = el('div', 'perm-switches');
  for (const s of [net, ws, tr, unsb]) switches.appendChild(s.row);
  form.appendChild(fieldBox('能力开关', switches));
  form.appendChild(fieldBox('额外可写目录', roots.el, ROOTS_HINT));
  form.appendChild(fieldBox('工具禁用', tools.el, TOOLS_HINT));
  const actions = el('div', 'cfg-actions');
  actions.append(save, cancel);
  form.appendChild(actions);
  form.appendChild(status);

  const off = document.createElement('div');
  off.appendChild(form);
  host.replaceChildren(...off.childNodes);
  host.classList.remove('hidden');
}
