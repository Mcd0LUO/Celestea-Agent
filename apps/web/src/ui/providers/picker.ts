// ============================================================================
// ui/providers/picker.ts — 「获取模型」二级选择窗（W258 任务 4）
//   （W748 从 ui/providers.ts 拆出；纯搬运，行为不变）。
// ============================================================================
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';

export interface PickerItem {
  id: string;
  /** 表单里已存在该模型：列出但不可勾选（避免重复添加） */
  existing: boolean;
}

/** 同一时刻只保留一个选择窗（重复点「获取模型」不叠窗）。 */
let closeModelPicker: (() => void) | null = null;

/** 二级选择窗：列出上游模型清单，勾选后点「确认」才写入表单。
 *  - 独立挂 body 的 modal（scrim/card），打开与关闭都不碰下方表单（铁律 5）；
 *  - 清单离屏构建 + 单次替换，一次挂载（铁律 1：无空白帧 / 无闪烁）；
 *  - pushOverlay(close)：Esc 先关本窗（层级栈栈顶），再关下层内联面板/弹窗。 */
export function openModelPicker(
  items: readonly PickerItem[],
  onConfirm: (picked: string[]) => void,
): void {
  closeModelPicker?.(); // 单例：旧的（若有）先关
  const scrim = el('div', 'modal-scrim');
  const card = el('div', 'modal-card prov-picker');
  card.appendChild(el('div', 'modal-card-title', '选择要添加的模型'));
  card.appendChild(
    el('div', 'side-note', '请勾选要添加的模型（默认不勾选；已存在的模型不可重复添加）'),
  );

  const list = el('div', 'prov-picker-list');
  const boxes: HTMLInputElement[] = [];
  const count = el('div', 'prov-picker-count');
  const syncCount = (): void => {
    const n = boxes.filter((b) => b.checked).length;
    count.textContent = '已选 ' + n + ' / ' + boxes.length + ' 个可选模型';
  };
  const off = document.createElement('div'); // 离屏构建：整份清单一次替换
  for (const it of items) {
    const row = el('label', 'prov-picker-row' + (it.existing ? ' existing' : ''));
    const cb = el('input', 'prov-picker-cb') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = false; // 默认全部不勾选
    cb.disabled = it.existing;
    cb.dataset.modelId = it.id;
    cb.addEventListener('change', syncCount);
    row.appendChild(cb);
    row.appendChild(el('span', 'prov-picker-id', it.id));
    if (it.existing) row.appendChild(el('span', 'prov-picker-tag', '已存在'));
    off.appendChild(row);
    if (!it.existing) boxes.push(cb);
  }
  list.replaceChildren(...off.childNodes);
  syncCount();
  card.appendChild(list);
  card.appendChild(count);

  const actions = el('div', 'modal-card-actions');
  const cancel = el('button', 'btn btn-soft', '取消') as HTMLButtonElement;
  cancel.type = 'button';
  const ok = el('button', 'btn btn-accent', '确认') as HTMLButtonElement;
  ok.type = 'button';

  let overlay: OverlayHandle | null = null;
  const close = (): void => {
    if (closeModelPicker === close) closeModelPicker = null;
    if (overlay) {
      popOverlay(overlay);
      overlay = null;
    }
    scrim.remove();
  };
  closeModelPicker = close;
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => {
    const picked = boxes
      .filter((b) => b.checked)
      .map((b) => b.dataset.modelId ?? '')
      .filter(Boolean);
    close();
    onConfirm(picked); // 先关窗再写表单：开关本身不触发背景重渲染
  });
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });

  actions.appendChild(cancel);
  actions.appendChild(ok);
  card.appendChild(actions);
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  overlay = pushOverlay(close); // Esc：先关本选择窗（栈顶）
  cancel.focus();
}
