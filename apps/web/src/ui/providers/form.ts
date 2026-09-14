// ============================================================================
// ui/providers/form.ts — 提供商表单 DOM 构建（弹窗「添加」与行内联「编辑」复用）
//   W748 从 ui/providers.ts 拆出；纯搬运，DOM 结构/类名/文案/事件一行未改。
//   字段与操作行在本模块；单模型行见 ./modelrow，二级选择窗见 ./picker。
// ============================================================================
import { api, userErrorText } from '../../api';
import { el } from '../../utils/dom';
import type { ProviderInfo, ProviderModelSpec } from '../../types';
import { addModelRow } from './modelrow';
import { openModelPicker } from './picker';
import { fmtErr } from './state';
import type { EditorRefs, FormHooks, ProviderPayload } from './types';

const FORMATS: readonly { value: string; label: string }[] = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
];
function buildPayload(e: EditorRefs): ProviderPayload {
  // 未编辑的空行（点了「+ 添加模型」但没填 id/名称）直接跳过，
  // 否则保存/获取模型会被后端 "each model needs a non-empty id" 拒绝。
  const models: ProviderModelSpec[] = e.rows
    .filter((r) => r.id.value.trim() !== '' || r.name.value.trim() !== '')
    .map((r) => ({
      id: r.id.value.trim(),
      name: r.name.value.trim() || r.id.value.trim(),
      // W258 任务 3：档位片多选 → 数组（后端契约不变）
      reasoning_efforts: r.efforts.values(),
      context_window: numOrNull(r.ctx),
      max_output_tokens: numOrNull(r.maxOut),
    }));
  const key = e.key.value.trim();
  return {
    // W262: 编辑既有记录时沿用原始 id；仅新建时由名称派生。
    id: e.originalId ?? e.name.value.trim(),
    name: e.name.value.trim(),
    note: e.note.value.trim(),
    base_url: e.url.value.trim(),
    request_format: e.format.value,
    ...(key !== '' ? { api_key: key } : {}),
    models,
  };
}

function numOrNull(i: HTMLInputElement): number | null {
  // W262: 支持 k / m 后缀（1k=1000，1m=1000000，1.5m=1500000，大小写与空格容错）
  const t = i.value.trim().toLowerCase().replace(/\s+/g, '');
  if (t === '') return null;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(t);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1;
  const n = Math.round(base * mult);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function buildProviderForm(p: ProviderInfo | null, hooks: FormHooks): EditorRefs {
  const root = el('div', 'prov-form');

  const status = el('div', 'prov-editor-status');
  root.appendChild(status);

  const field = (label: string, ctrl: HTMLElement): HTMLElement => {
    const row = el('label', 'prov-field');
    row.appendChild(el('span', 'prov-field-label', label));
    row.appendChild(ctrl);
    return row;
  };

  const name = el('input', 'cfg-input') as HTMLInputElement;
  name.placeholder = '提供商 id（字母/数字/下划线）';
  name.value = p?.name ?? '';
  root.appendChild(field('名称', name));

  const note = el('input', 'cfg-input') as HTMLInputElement;
  note.placeholder = '备注（可选）';
  note.value = p?.note ?? '';
  root.appendChild(field('备注', note));

  const key = el('input', 'cfg-input') as HTMLInputElement;
  key.type = 'password';
  key.placeholder = p ? '留空 = 保持现有 Key' : 'API Key';
  key.value = '';
  root.appendChild(field('API Key', key));

  const url = el('input', 'cfg-input') as HTMLInputElement;
  url.placeholder = 'https://…/v1';
  url.value = p?.base_url ?? '';
  const testBtn = el('button', 'btn btn-soft btn-mini', '请求测试') as HTMLButtonElement;
  testBtn.type = 'button';
  const urlRow = el('div', 'prov-urlrow');
  urlRow.appendChild(url);
  urlRow.appendChild(testBtn);
  root.appendChild(field('API 请求地址', urlRow));

  const format = document.createElement('select');
  format.className = 'cfg-input';
  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f.value;
    o.textContent = f.label;
    format.appendChild(o);
  }
  if (p?.request_format) {
    const known = FORMATS.some((f) => f.value === p.request_format);
    if (!known) {
      const o = document.createElement('option');
      o.value = p.request_format;
      o.textContent = p.request_format;
      format.appendChild(o);
    }
    format.value = p.request_format;
  }
  root.appendChild(field('请求格式', format));

  // ---- 模型列表 ----
  const modelsHead = el('div', 'prov-models-head');
  modelsHead.appendChild(el('span', 'prov-models-title', '模型'));
  const fetchBtn = el('button', 'btn btn-soft btn-mini', '获取模型') as HTMLButtonElement;
  fetchBtn.type = 'button';
  fetchBtn.title = '从服务商拉取可用模型（会先保存当前填写内容）';
  modelsHead.appendChild(fetchBtn);
  root.appendChild(modelsHead);
  const modelsBox = el('div', 'prov-models');
  root.appendChild(modelsBox);

  const e: EditorRefs = {
    root, name, note, key, url, format, modelsBox, status, rows: [], onLayout: hooks.onLayout,
    originalId: p?.id,
  };

  for (const m of p?.models ?? []) {
    addModelRow(e, m.id, m.name);
    const r = e.rows[e.rows.length - 1]!;
    // W258 任务 3：已有模型的 reasoning_efforts 映射到对应档位片选中
    r.efforts.set(m.reasoning_efforts ?? []);
    if (m.context_window != null) r.ctx.value = String(m.context_window);
    // W258 任务 2：max_output_tokens（最大输出 tokens）不回填 —— 留空即可，
    // 留空保存即写 null（后端 numOrNull），这是期望行为。
  }

  const addM = el('button', 'btn-mini', '+ 添加模型') as HTMLButtonElement;
  addM.type = 'button';
  addM.addEventListener('click', () => addModelRow(e));
  root.appendChild(addM);

  // ---- 操作 ----
  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const save = el('button', 'btn btn-accent', '保存') as HTMLButtonElement;
  save.type = 'button';

  testBtn.addEventListener('click', () => {
    status.className = 'prov-editor-status';
    status.textContent = '测试中…';
    void api
      .testProvider(buildPayload(e))
      .then((r) => {
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = '测试失败：' + userErrorText(r.error, '请检查请求地址与 Key');
          return;
        }
        status.className = 'prov-editor-status ok';
        status.textContent =
          '✓ 延迟 ' + (r.latency_ms ?? '—') + 'ms · 模型数 ' + (r.model_count ?? '—');
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = '测试失败：' + fmtErr(err);
      });
  });

  // 铁律 3：fetch 竞态守卫 —— 连点「获取模型」时，晚到的旧响应直接丢弃
  let fetchSeq = 0;
  fetchBtn.addEventListener('click', () => {
    const seq = ++fetchSeq;
    const id = name.value.trim();
    if (!id) {
      status.className = 'prov-editor-status err';
      status.textContent = '请先填写提供商名称（作为 id）';
      return;
    }
    status.className = 'prov-editor-status';
    status.textContent = '保存并获取模型中…';
    void api
      .saveProvider(buildPayload(e))
      .then(() => api.fetchProviderModels(id))
      .then((r) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃，不覆盖新状态
        if (r.ok === false || (r.ok === undefined && r.error)) {
          status.className = 'prov-editor-status err';
          status.textContent = '获取模型失败：' + userErrorText(r.error, '请检查请求地址与 Key');
          return;
        }
        // W258 任务 4：fetch 结果只缓存在局部变量（got），不自动写入表单
        const got = r.models ?? [];
        if (!got.length) {
          status.className = 'prov-editor-status';
          status.textContent = '未获取到任何模型';
          return;
        }
        const existing = new Set(e.rows.map((x) => x.id.value.trim()).filter(Boolean));
        status.className = 'prov-editor-status ok';
        status.textContent = '已获取 ' + got.length + ' 个模型 · 请勾选要添加的模型';
        // 二级选择窗：确认后才 addModelRow（已存在的跳过不重复加）
        openModelPicker(
          got.map((m) => ({ id: m.id, existing: existing.has(m.id) })),
          (picked) => {
            const fresh = picked.filter((mid) => !e.rows.some((x) => x.id.value.trim() === mid));
            for (const mid of fresh) addModelRow(e, mid, mid);
            status.className = 'prov-editor-status ok';
            status.textContent = fresh.length
              ? '已添加 ' + fresh.length + ' 个模型（共获取 ' + got.length + ' 个）· 请保存以生效'
              : '未选择模型（共获取 ' + got.length + ' 个）· 请保存以生效';
          },
        );
      })
      .catch((err: unknown) => {
        if (seq !== fetchSeq) return; // 旧响应：丢弃
        status.className = 'prov-editor-status err';
        status.textContent = '获取模型失败：' + fmtErr(err);
      });
  });

  save.addEventListener('click', () => {
    const payload = buildPayload(e);
    if (!payload.id) {
      status.className = 'prov-editor-status err';
      status.textContent = '名称（id）不能为空';
      return;
    }
    status.className = 'prov-editor-status';
    status.textContent = '保存中…';
    save.disabled = true;
    void api
      .saveProvider(payload)
      .then((r) => {
        if (r.ok === false) {
          status.className = 'prov-editor-status err';
          status.textContent = '保存失败：' + userErrorText(r.error, '请检查填写内容');
          save.disabled = false;
          return;
        }
        save.disabled = false;
        status.className = 'prov-editor-status ok';
        status.textContent = '已保存';
        hooks.onSaved(payload);
      })
      .catch((err: unknown) => {
        status.className = 'prov-editor-status err';
        status.textContent = '保存失败：' + fmtErr(err);
        save.disabled = false;
      });
  });

  cancel.addEventListener('click', () => hooks.onCancel());
  actions.appendChild(cancel);
  actions.appendChild(save);
  root.appendChild(actions);

  return e;
}
