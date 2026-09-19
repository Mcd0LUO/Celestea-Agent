// ============================================================================
// statusline/picker.ts — W758 从 src/statusline.ts 拆出（纯搬运，无行为变更）：
//   模型 / 推理档位快速切换弹层 + 409 挂起重试。
//   W227：模型/推理档位改为可点击按钮 → 紧凑下拉面板快速切换（POST /api/config），
//     409（轮次进行中）→ 提示并挂起，SSE done 后自动重试一次；400/500 → 内联报错。
//   W262：模型清单按提供商分组的树状清单。
//   W750：跨提供商选择器——清单按 provider_id 分组（显示名可能重复/被改，用 id
//     做键）；跨 provider 先 POST /api/providers/default（带稳定 id 消歧，模型 id
//     跨 provider 会撞名），再落库模型；同 provider 只发后者。409 挂起经 pendingPick
//     走同一条路径重试。
//
//   W778：清单改走配置缓存（statusline/cfg-cache.ts）——缓存命中时**同步**渲染
//     清单，随后后台 revalidateConfig() 校验一次，仅当弹层仍是同一个 popup 且
//     清单内容真的变了，才原地替换（铁律 1/3）。
//
//   W795（乐观更新，去进度占位）：
//     · 清单：推理档位的候选是**静态清单 + 当前值**，冷启动也同一帧画出来；
//       模型清单冷启动时本地确无真源（无缓存、无快照）⇒ 正文留空、首次拉取后
//       一次换入，**不再写「加载清单中…」**（那是纯占位，不是终态）。
//     · 切换（模型/档位）：点下去**同一帧**把状态栏画成已切到目标值（终态），
//       请求后台跑；失败回滚到原值 + 「已恢复原设置」说明，409 挂起则不留在错的显示上。
//
//   W870（会话级模型切换 —— 用户报案「切换模型后几秒又弹回原状」）：
//     徽标每 2s 轮询 GET /api/status?session=<聚焦会话>，其 model 来自**会话实例**
//     的 profile（全局 base + session.json.model 覆盖，见
//     apps/studio/src/runtime/session-compose.ts 的 profileFor）；而 W750 的选择器
//     只写**全局** POST /api/config。于是带覆盖的会话：乐观显示新模型 → 全局配置也
//     真改了 → ≤2s 后轮询按会话覆盖把徽标打回旧值。
//     产品语义（本轮裁决）：**statusline 的模型选择器切的是「当前聚焦会话」的模型**
//     —— 它显示在哪个会话的 statusline 上，用户点的就是「这个会话用哪个模型」；
//     全局默认留给设置页「通用配置」（POST /api/config 语义不变）。
//     实现落在 ./session-model.ts（纯逻辑，零 DOM）：有聚焦会话 ⇒
//     PUT /api/sessions/{id}/model；无聚焦会话（旧单会话容器）⇒ 回落 POST /api/config。
//     W795 的乐观显示 / 失败回滚 / 409 挂起重试结构**原样保留**，只换目标端点与文案。
//
//   W870（拆分）：清单渲染整段搬到 ./picker-list.ts、共享契约搬到
//     ./picker-shared.ts（本文件因此回到 400 行门禁以内）。本文件保留弹层生命周期
//     与请求编排；对 statusline.ts 与测试**原样再导出**原有名字，调用方零改动。
// ============================================================================
import { api, userErrorText } from '../api';
import { t } from '../i18n'; // i18n P1-a
import { el } from '../utils/dom';
import { popOverlay, pushOverlay } from '../utils/overlays';
import type { ConfigInfo, ConfigPatch } from '../types';
import { loadConfigCached, peekConfig, revalidateConfig } from './cfg-cache';
import { optimisticPatchView, revertPointOf } from './optimistic';
import { listChanged, renderEffortList, renderList, renderModelList } from './picker-list';
import {
  effortOptions,
  otherGroupLabel,
  type ListHooks,
  type ModelPick,
  type PickerHost,
  type SwitchKind,
} from './picker-shared';
import {
  failureText,
  modelTargetOf,
  requestGlobalModel,
  requestSessionModel,
  switchedNote,
  type SessionModelOutcome,
} from './session-model';

// W870：契约与常量仍在 ./picker-shared.ts（渲染器也要用它们，放这里会成环）；
// 这里原样再导出，statusline.ts 与测试的既有 import 路径一个都不用改。
export { effortOptions, otherGroupLabel };
export type { ModelPick, PickerHost, SwitchKind };

/** 渲染器的点击行为：请求编排留在本文件（渲染器不 import 本文件，零环）。 */
const HOOKS: (host: PickerHost) => ListHooks = (host) => ({
  apply: (patch) => void apply(host, patch),
  pick: (pick) => void pickModel(host, pick),
});

export function togglePopup(host: PickerHost, kind: SwitchKind): void {
  if (host.popup && host.popupKind === kind) {
    closePopup(host);
    return;
  }
  void openPopup(host, kind);
}

export function closePopup(host: PickerHost): void {
  if (host.popupOverlay) {
    popOverlay(host.popupOverlay);
    host.popupOverlay = null;
  }
  if (host.popup) {
    host.popup.remove();
    host.popup = null;
    host.popupKind = null;
  }
}

export async function openPopup(host: PickerHost, kind: SwitchKind): Promise<void> {
  closePopup(host);
  host.popupKind = kind;
  const popup = el('div', 'sl-popup');
  popup.setAttribute('role', 'menu');
  host.popup = popup;
  host.root.appendChild(popup);
  host.popupOverlay = pushOverlay(() => closePopup(host));

  popup.appendChild(el('div', 'sl-popup-title', t(kind === 'model' ? 'statusline.picker.switchModel' : 'statusline.picker.switchEffort')));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);

  // W795：可乐观的**先画终态**。
  //   · 推理档位：候选是静态常量 + 当前值 ⇒ 缓存有没有都同一帧画出来；
  //   · 模型清单：缓存命中 → 同步渲染；冷启动 → 正文先留空（本地确无真源，
  //     不写任何占位文案），首次拉取回来再一次换入（铁律 1：单次替换）。
  const hooks = HOOKS(host);
  const seeded = peekConfig();
  if (kind === 'effort') {
    renderEffortList(body, seeded?.reasoning_effort ?? host.snapshotEffort ?? '', hooks);
  } else if (seeded !== null) {
    renderModelList(body, seeded, host, hooks);
  }

  let cfg: ConfigInfo;
  try {
    // 命中缓存：只做后台校验（失败保留已渲染清单）；冷启动：等首次拉取。
    cfg = seeded === null ? await loadConfigCached() : await revalidateConfig();
  } catch (err) {
    if (host.popup !== popup) return; // 期间被关闭/切换
    if (seeded !== null) return; // 后台校验失败：缓存清单继续可用，不打扰用户
    if (kind === 'effort') return; // 档位清单是静态候选，已经画好了
    body.replaceChildren(
      el('div', 'sl-popup-error', userErrorText(err, t('statusline.picker.configUnavailable'))),
    );
    return;
  }
  if (host.popup !== popup) return; // 期间被关闭/切换
  // 冷启动：首次结果直接渲染；命中缓存：内容真的变了才原地替换（否则零重建）。
  if (seeded === null || listChanged(kind, seeded, cfg)) renderList(body, kind, cfg, host, hooks);
}

/**
 * W750/W870：切到 (provider, model)。provider 不同 → 先 `POST /api/providers/default`
 * （带 provider_id 消歧：模型 id 跨 provider 会撞名）。
 *
 * W870：随后**按目标**落库 —— 有聚焦会话 ⇒ `PUT /api/sessions/{id}/model`
 * （会话级，徽标下一次轮询读到新值，不再被打回）；无聚焦会话 ⇒ 旧的
 * `POST /api/config {model}`（全局默认）。两条路径都走 ./session-model.ts。
 */
export async function runPick(host: PickerHost, pick: ModelPick): Promise<SessionModelOutcome> {
  if (pick.providerId !== '') await api.setDefaultModel(pick.model, pick.providerId);
  const target = modelTargetOf(host.sessionId);
  const outcome =
    target === 'session'
      ? await requestSessionModel(host.sessionId, pick.model)
      : await requestGlobalModel(pick.model);
  if (outcome.kind !== 'ok') return outcome;
  host.merge({ model: outcome.model });
  window.dispatchEvent(new Event('studio:config-saved'));
  return outcome;
}

/** W795：乐观切换的回滚基准（宿主字段 → 纯函数 ./optimistic.revertPointOf）。 */
function revertPoint(host: PickerHost): ReturnType<typeof revertPointOf> {
  return revertPointOf({ model: host.snapshotModel, effort: host.snapshotEffort });
}

export async function pickModel(host: PickerHost, pick: ModelPick): Promise<void> {
  if (!host.popup) return;
  const popup = host.popup;
  const prev = revertPoint(host);
  // W795 乐观：点下去**同一帧**就把状态栏画成已切到该模型（终态），请求在后台跑。
  host.merge({ model: pick.model });
  const outcome = await runPick(host, pick);
  if (outcome.kind === 'ok') {
    // W870 如实：切的是本会话还是全局默认，说的就是哪一句（不混为一谈）。
    host.setNote(switchedNote(outcome.target), 5000);
    closePopup(host);
    return;
  }
  // 失败/挂起一律先回滚乐观显示：绝不留在错的显示上（W795 口径原样保留）。
  host.merge(prev);
  if (outcome.kind === 'busy') {
    // 轮次进行中 ⇒ 这一轮**没有**切过去：挂起，本轮结束后按**同一条路径**重试。
    host.pendingPick = pick;
    host.setNote(t('statusline.picker.busy'), 0);
    closePopup(host);
    return;
  }
  const msg = failureText(outcome);
  if (host.popup === popup) popup.appendChild(el('div', 'sl-popup-status err', msg));
  else host.setNote(msg, 6000);
}

/** POST /api/config 应用档位切换：204/200 → 合并响应；409 → 挂起；其他 → 内联报错。 */
export async function apply(host: PickerHost, patch: ConfigPatch): Promise<void> {
  if (!host.popup) return;
  const popup = host.popup;
  const prev = revertPoint(host);
  // W795 乐观：同一帧内先按补丁画出终态（档位胶囊立即变），请求在后台跑。
  host.merge(optimisticPatchView(patch));
  try {
    const d = await api.saveConfig(patch);
    host.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
    host.setNote(t('statusline.switched'), 5000);
    window.dispatchEvent(new Event('studio:config-saved'));
    closePopup(host);
  } catch (err) {
    const msg = t('statusline.withRestoredSettings', { text: t('statusline.switchFailed', { reason: err instanceof Error ? err.message : String(err) }) });
    if (isBusy(err)) {
      // 本轮不生效：退回原值 + 挂起，等本轮结束后重试（那时再乐观应用一次）
      host.merge(prev);
      host.pendingPatch = patch;
      host.setNote(t('statusline.picker.busy'), 0);
      closePopup(host);
    } else {
      host.merge(prev);
      if (host.popup === popup) popup.appendChild(el('div', 'sl-popup-status err', msg));
      else host.setNote(msg, 6000);
    }
  }
}

/** 409 判定（./api 的 ApiError；只在这里 import 一次，避免每个调用点重复判）。 */
function isBusy(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409;
}

/**
 * SSE done 钩子里的第一步：存在 409 挂起的模型/提供商切换时重试一次。
 * 返回 true = 已接手（调用方不要再走 pendingPatch 分支）。
 */
export function retryPendingPick(host: PickerHost): boolean {
  // W750：模型/提供商切换先走（它可能还要先切 provider）。
  const pick = host.pendingPick;
  if (pick === null) return false;
  host.pendingPick = null;
  const prev = revertPoint(host);
  // W795：本轮已结束 ⇒ 同一帧内先把状态栏画成已切到目标（不再有「正在应用切换…」占位），
  // 请求在后台跑；失败则退回原值并说明原因。
  host.merge({ model: pick.model });
  void runPick(host, pick).then((outcome) => {
    if (outcome.kind === 'ok') {
      host.setNote(switchedNote(outcome.target), 5000);
      return;
    }
    host.merge(prev);
    host.setNote(failureText(outcome), 6000);
  });
  return true;
}
