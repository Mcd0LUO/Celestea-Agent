// ============================================================================
// ui/grants/panel/body.ts — 权限面板主体：开/关/重绘（设计 §3.2；W760 从 ../panel.ts 拆出）。
//
//   W1517（权限入口合并）：面板现在同时承载**两块内容**（设计 §3）——
//     §1 会话档位：原 statusline 的档位弹层（statusline/permission/tier.ts 的
//        tierSection，列表 / 切换 / 失败回滚逐条沿用）
//     §2 精细授权：快捷授权区（./quick）→ 两条说明 → 警示区（./warnings）→
//        结果预览 → 逐项明细行（./rows）→ 页脚「全部撤销」
//   内容顺序（W751/W757 定的）在 §2 内部逐字未改。
//   重绘走「离屏构建 + 单次替换」；每次重绘都重新落位（./position）。
//   授予/撤销动作本身不在这里（见 ../flow.ts），经 GrantsHost 回调触发。
//   档位段落的宿主契约是 statusline/permission.ts 的 PermissionHost（由 ui/grants.ts
//   在打开时用**同一个** focusedSession/refresh 源适配后塞进来，见 openPanel）。
// ============================================================================
import { el } from '../../../utils/dom';
import { popOverlay, pushOverlay } from '../../../utils/overlays';
import { caps } from '../caps';
import { t } from '../../../i18n';
import {
  getData,
  getDataSession,
  getPanelEl,
  getPanelNote,
  getPanelOverlay,
  inlineError,
  setPanelEl,
  setPanelNote,
  setPanelOverlay,
  type GrantsHost,
} from '../state';
import { registerTierRepaint, registeredTierHost } from '../../../statusline/permission';
import { resetTierStatus, tierSection } from '../../../statusline/permission/tier';
import { activeFor, activeGrants, expiredFor } from './active';
import { attachPosition, detachPositionNow, positionPanel } from './position';
import { previewText } from './phrase';
import { renderPresets } from './quick';
import { renderRow } from './rows';
import { warningBox } from './warnings';

// ---- 面板（§3.2） --------------------------------------------------------------

export function closePanel(): void {
  detachPositionNow();
  registerTierRepaint(() => {}); // 面板关了就不再有重画目标
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

  popup.appendChild(el('div', 'sl-popup-title', t('grants.body.title')));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);

  resetTierStatus(); // W1517：上一次的档位失败回执不该跟着新面板出现
  // 档位视图落定（换会话 / 徽标刷新）时重画面板 —— 面板开着时 §1 的「当前」标记要跟着变。
  registerTierRepaint(() => {
    if (getPanelEl() === popup) renderPanel(host);
  });

  if (host.focusedSession() === '') {
    body.replaceChildren(
      el('div', 'sl-popup-note', t('grants.body.noSession')),
    );
    positionPanel();
    attachPosition();
    return;
  }

  // W795：**同一帧内先画终态**，没有任何「读取中」占位。
  //   ① 已有本会话快照（常态：点开盾牌前 refresh 早就跑过了）→ 立刻整块画出来；
  //   ② 首次打开、还没有任何快照 → 面板整体先隐藏（不是空壳给用户看），
  //      快照一到再一次性显示 + 落位（内容与位置一起出现，不会闪一次未定位的面板）。
  const known = getData() !== null && getDataSession() === host.focusedSession();
  if (!known) popup.classList.add('hidden');
  if (known) renderPanel(host);
  attachPosition();
  await host.refresh(true);
  if (getPanelEl() !== popup) return; // 期间被关闭
  popup.classList.remove('hidden');
  renderPanel(host);
}

/** 面板整体重绘：离屏构建 + 单次替换（铁律 1）。 */
export function renderPanel(host: GrantsHost): void {
  const popup = getPanelEl();
  if (!popup) return;
  const body = popup.querySelector<HTMLElement>('.sl-popup-body');
  if (!body) return;
  const off = document.createElement('div');

  // §1 会话档位（W1517）：原档位弹层的列表/切换，现在住同一个面板里。
  // 宿主 = statusline 侧注册进来的**同一个**档位 controller（见 permission.ts 的
  // registerTierHost）—— 两块内容读同一份聚焦会话，不会出现「面板说甲会话、档位说
  // 乙会话」；未装配（其它测试夹具只加载 grants）时本段整体不画。
  const tier = registeredTierHost();
  if (tier !== null) off.appendChild(tierSection(tier, () => renderPanel(host)));

  // §2 精细授权：快捷授权（W751 任务 1c）在最顶部，先给「一键组合」，再是逐项明细。
  off.appendChild(renderPresets(host));

  off.appendChild(
    el('div', 'grant-intro', t('grants.body.introDefault')),
  );
  off.appendChild(
    el(
      'div',
      'grant-intro',
      t('grants.body.introScope'),
    ),
  );

  // 警示区（W757）：服务端的 warnings 此前从未被渲染 —— 条目被忽略、文件读不出来、
  // 或站点清单在本次部署下不生效时，面板必须说出来，否则「已授予」只是个假象。
  const warn = warningBox();
  if (warn) off.appendChild(warn);

  // 结果预览（§3.4）：把「能力」翻译成「这个会话接下来能做什么」。
  const preview = el('div', 'grant-preview');
  preview.appendChild(el('span', 'grant-preview-label', t('grants.body.previewLabel')));
  preview.appendChild(el('span', null, previewText()));
  off.appendChild(preview);

  if (getData() === null) {
    off.appendChild(
      el('div', 'sl-popup-note', t('grants.body.unreadable')),
    );
  } else {
    for (const def of caps()) {
      if (def.cap === 'unsandboxed' && getData()?.unsandboxed_available !== true) continue;
      // W819-8：预留能力位不再作为可授项列出；仅当本会话已有存量条目时渲染，
      // 好让运维仍能看见并撤销它。
      if (def.reserved === true && activeFor(def.cap) === null && expiredFor(def.cap).length === 0) continue;
      off.appendChild(renderRow(def, host));
    }
  }

  const foot = el('div', 'grant-foot');
  foot.appendChild(
    el('div', 'grant-foot-note', t('grants.body.footNote')),
  );
  const all = el('button', 'btn-mini grant-danger-btn', t('grants.body.revokeAll')) as HTMLButtonElement;
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
