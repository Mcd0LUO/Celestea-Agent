// ============================================================================
// ui/providers.ts — 设置页「模型提供商」（W236 契约，端点缺失优雅降级）：
//   GET /api/providers 列表（名称/备注/请求格式/模型数/默认/has_key）
//   「添加提供商」→ 弹窗表单（名称/备注/API KEY/地址+请求测试/
//   请求格式/模型列表「获取模型」/单模型高级编辑）
//   第 26 轮（W256）：删除行内「编辑」按钮 —— 点击提供商行本体，在该行正下方
//   原地展开内联编辑面板（非弹窗）。面板 DOM 每个提供商行只构建一次，
//   展开/收起只切 class + max-height 过渡（铁律 4），禁止删除重建；
//   保存成功/取消后收起并局部刷新该行数据（不整表重建）。
//   POST /api/providers（upsert）· /test · /{id}/models/fetch · /{id}/delete
//   POST /api/providers/default（默认模型选择器，切换即热应用）
//   W261：单模型「推理强度」固定片（low/high/max）右侧「+」按钮 → 行内输入框
//   新增自定义档位（Enter/失焦确认、Esc 取消、重名去重提示）；自定义片与固定片
//   同 class 同行为，存量非标准档位也以选中片呈现于「+」左侧。
//
//   W748：按职责拆到 ./providers/*，本文件只保留**编排入口**（载入/装配/弹窗开关）
//   并原样再导出对外 API（import 路径与拆分前兼容）。拆分是纯搬家：无行为变更。
//     ./providers/types.ts     内部数据契约（EditorRefs / FormHooks / …）
//     ./providers/state.ts     模块级状态（providers / defaultModel / openPanels / boxEl）
//     ./providers/list.ts      列表表格 + 默认模型卡片
//     ./providers/rows.ts      行单元格 / 列表提示 / 单行局部刷新
//     ./providers/panel.ts     行内联编辑面板（展开/收起/恢复）
//     ./providers/form.ts      表单字段 + 请求测试 + 获取模型 + 保存
//     ./providers/modelrow.ts  单模型行（高级区 + 推理强度档位片）
//     ./providers/picker.ts    「获取模型」二级选择窗
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import { buildProviderForm } from './providers/form';
import { renderDefaultPicker, renderProviders } from './providers/list';
import { boxEl, fmtErr, setProviderData } from './providers/state';
import type { ProviderListHost } from './providers/types';

/** 列表渲染宿主：把编排入口（本文件的 loadProviders）传给子渲染，避免循环 import。 */
const HOST: ProviderListHost = {
  loadProviders: () => loadProviders(),
};

/** 载入并渲染提供商列表 + 默认模型卡片（增删改后调用）。
 *  第 11 轮：离屏构建 + 一次性替换（旧列表保留到新列表就绪，无「加载中…」空白帧）。 */
export async function loadProviders(): Promise<void> {
  const off = document.createElement('div');
  try {
    const d = await api.providers();
    setProviderData(d.providers ?? [], d.default_model ?? null);
  } catch (err) {
    off.appendChild(el('div', 'side-note err', '提供商列表暂不可用'));
    off.appendChild(el('div', 'side-note', fmtErr(err)));
    boxEl.replaceChildren(...off.childNodes);
    return;
  }
  renderProviders(off, HOST);
  renderDefaultPicker(off, HOST);
  boxEl.replaceChildren(...off.childNodes);
}

// ---- 「添加提供商」弹窗（编辑走行内联面板） -----------------------------------------

let closeAddModal: (() => void) | null = null;

function openEditor(): void {
  closeAddModal?.(); // 同一时刻只保留一个「添加提供商」弹窗

  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prov-modal');
  card.appendChild(el('div', 'modal-card-title', '添加提供商'));

  let overlay: OverlayHandle | null = null;
  const close = (): void => {
    if (closeAddModal === close) closeAddModal = null;
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  closeAddModal = close;

  const form = buildProviderForm(null, {
    onSaved: () => {
      close();
      void loadProviders();
    },
    onCancel: close,
  });
  card.appendChild(form.root);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  // 任务 3：挂到 body 的弹窗打开时 push 自身 close，Esc 只关栈顶一层
  overlay = pushOverlay(close);
  form.name.focus();
}

export function initProvidersSection(): void {
  need<HTMLButtonElement>('#btnAddProvider').addEventListener('click', () => openEditor());
}

// ---- 对外 API 兼容层（W748：import 路径与拆分前一致） ------------------------------

/** 内部数据契约的再导出（子模块的接口；拆分前这些类型是文件私有，故不属对外契约）。 */
export type { EditorRefs, FormHooks, ModelRow, ProviderListHost, ProviderPayload } from './providers/types';
