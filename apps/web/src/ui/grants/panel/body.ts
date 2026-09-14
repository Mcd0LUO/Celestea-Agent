// ============================================================================
// ui/grants/panel/body.ts — 权限面板主体：开/关/重绘（设计 §3.2；W760 从 ../panel.ts 拆出）。
//
//   面板 = 复用 statusline 的 .sl-popup 样式族 + utils/overlays 的 Esc 层级栈；
//   内容顺序（W751/W757 定的）逐字未改：
//     快捷授权区（./quick）→ 两条说明 → 警示区（./warnings）→ 结果预览 →
//     逐项明细行（./rows）→ 页脚「全部撤销」→ 面板级状态行。
//   重绘走「离屏构建 + 单次替换」；每次重绘都重新落位（./position）。
//   授予/撤销动作本身不在这里（见 ../flow.ts），经 GrantsHost 回调触发。
// ============================================================================
import { el } from '../../../utils/dom';
import { popOverlay, pushOverlay } from '../../../utils/overlays';
import { CAPS } from '../caps';
import {
  getData,
  getPanelEl,
  getPanelNote,
  getPanelOverlay,
  inlineError,
  setPanelEl,
  setPanelNote,
  setPanelOverlay,
  type GrantsHost,
} from '../state';
import { activeGrants } from './active';
import { attachPosition, detachPositionNow, positionPanel } from './position';
import { previewText } from './phrase';
import { renderPresets } from './quick';
import { renderRow } from './rows';
import { warningBox } from './warnings';

// ---- 面板（§3.2） --------------------------------------------------------------

export function closePanel(): void {
  detachPositionNow();
  const overlay = getPanelOverlay();
  if (overlay) {
    popOverlay(overlay);
    setPanelOverlay(null);
  }
  const panelEl = getPanelEl();
  if (panelEl) {
    panelEl.remove();
    setPanelEl(null);
  }
}

export function togglePanel(host: GrantsHost): void {
  if (getPanelEl()) {
    closePanel();
    return;
  }
  void openPanel(host);
}

export async function openPanel(host: GrantsHost): Promise<void> {
  closePanel();
  inlineError.clear();
  setPanelNote(null);
  const domHost = document.getElementById('statusline');
  if (!domHost) return;
  const popup = el('div', 'sl-popup grant-popup');
  popup.setAttribute('role', 'dialog');
  setPanelEl(popup);
  domHost.appendChild(popup);
  setPanelOverlay(pushOverlay(() => closePanel()));

  popup.appendChild(el('div', 'sl-popup-title', '本会话权限'));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);
  body.appendChild(el('div', 'sl-popup-loading', '正在读取当前权限…'));
  // 先按「加载中」的尺寸落位（同一帧内完成，不会闪一次未定位的面板）
  positionPanel();
  attachPosition();

  if (host.focusedSession() === '') {
    body.replaceChildren(
      el('div', 'sl-popup-note', '尚未打开任何会话：请先在左侧选择一个会话。'),
    );
    positionPanel();
    return;
  }
  await host.refresh(true);
  if (getPanelEl() !== popup) return; // 期间被关闭
  renderPanel(host);
}

/** 面板整体重绘：离屏构建 + 单次替换（铁律 1）。 */
export function renderPanel(host: GrantsHost): void {
  const popup = getPanelEl();
  if (!popup) return;
  const body = popup.querySelector<HTMLElement>('.sl-popup-body');
  if (!body) return;
  const off = document.createElement('div');

  // 快捷授权（W751 任务 1c）：放在面板最顶部，先给「一键组合」，再是逐项明细。
  off.appendChild(renderPresets(host));

  off.appendChild(
    el('div', 'grant-intro', '默认情况下，本会话只能读写工作区目录，不能访问网络。'),
  );
  off.appendChild(
    el(
      'div',
      'grant-intro',
      '以下授权只对当前会话生效，可随时撤销；变更将在会话下一轮开始时生效。',
    ),
  );

  // 警示区（W757）：服务端的 warnings 此前从未被渲染 —— 条目被忽略、文件读不出来、
  // 或站点清单在本次部署下不生效时，面板必须说出来，否则「已授予」只是个假象。
  const warn = warningBox();
  if (warn) off.appendChild(warn);

  // 结果预览（§3.4）：把「能力」翻译成「这个会话接下来能做什么」。
  const preview = el('div', 'grant-preview');
  preview.appendChild(el('span', 'grant-preview-label', '结果预览'));
  preview.appendChild(el('span', null, previewText()));
  off.appendChild(preview);

  if (getData() === null) {
    off.appendChild(
      el('div', 'sl-popup-note', '当前无法读取本会话权限，请稍后重试。'),
    );
  } else {
    for (const def of CAPS) {
      if (def.cap === 'unsandboxed' && getData()?.unsandboxed_available !== true) continue;
      off.appendChild(renderRow(def, host));
    }
  }

  const foot = el('div', 'grant-foot');
  foot.appendChild(
    el('div', 'grant-foot-note', '变更将在会话下一轮开始时生效。'),
  );
  const all = el('button', 'btn-mini grant-danger-btn', '全部撤销') as HTMLButtonElement;
  all.type = 'button';
  all.disabled = activeGrants().length === 0;
  all.addEventListener('click', () => void host.revoke(null));
  foot.appendChild(all);
  off.appendChild(foot);

  const note = getPanelNote();
  if (note) off.appendChild(el('div', 'sl-popup-status ' + note.cls, note.text));
  body.replaceChildren(...off.childNodes);
  // 内容高度变了 → 重新落位（面板位置永远由当前 DOM 实测决定）
  positionPanel();
}
