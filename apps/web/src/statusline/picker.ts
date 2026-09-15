// ============================================================================
// statusline/picker.ts — W758 从 src/statusline.ts 拆出（纯搬运，无行为变更）：
//   模型 / 推理档位快速切换弹层 + 409 挂起重试。
//   W227：模型/推理档位改为可点击按钮 → 紧凑下拉面板快速切换（POST /api/config），
//     409（轮次进行中）→ 提示并挂起，SSE done 后自动重试一次；400/500 → 内联报错。
//   W262：模型清单按提供商分组的树状清单。
//   W750：跨提供商选择器——清单按 provider_id 分组（显示名可能重复/被改，用 id
//     做键）；跨 provider 先 POST /api/providers/default（带稳定 id 消歧，模型 id
//     跨 provider 会撞名），再 POST /api/config {model}；同 provider 只发后者
//     （与旧行为逐字一致）。409 挂起经 pendingPick 走同一条路径重试。
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
//   宿主契约 PickerHost（= Statusline）：根元素 + 弹层状态 + merge/setNote 回调，
//   模块自身零状态。拆分只搬位置：DOM 结构、类名、文案、事件、请求顺序均未改。
// ============================================================================
import { api, ApiError, userErrorText } from '../api';
import { el } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import type { ConfigInfo, ConfigPatch, ModelInfo, StatusSnapshot } from '../types';
import { modelIconEl } from './icons';
import { loadConfigCached, peekConfig, revalidateConfig } from './cfg-cache';
import { optimisticPatchView, revertPointOf } from './optimistic';

/** W262：没有 provider 字段的模型（静态兜底目录 / 旧数据）归入的树状分组。 */
export const OTHER_GROUP = '其他';

export const EFFORT_OPTIONS: readonly { value: string | null; label: string }[] = [
  { value: null, label: '标准（清除）' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
];

export type SwitchKind = 'model' | 'effort';

/**
 * W750：一次「切到 (provider, model)」。
 * `providerId` 非空 = 需要先切默认 provider（`provider_id` 是稳定 id，
 * 不是显示名）；空串 = 同一 provider 内换模型，直接改配置即可。
 */
export interface ModelPick {
  model: string;
  providerId: string;
}

/** 弹层宿主（Statusline 实现）：根元素、弹层状态与应用后的副作用回调。 */
export interface PickerHost {
  /** 弹层挂载点（#statusline 元素）。 */
  readonly root: HTMLElement;
  /** 当前快照里的模型（cfg.model 缺失时的兜底；全局配置，跨会话保留）。 */
  readonly snapshotModel: string;
  /**
   * W795：当前快照里的推理档位（null = 标准档/未设置）。
   * 两处用途：冷启动时乐观渲染档位清单的「当前」项；切换失败时的回滚基准。
   */
  readonly snapshotEffort: string | null;
  popup: HTMLElement | null;
  popupKind: SwitchKind | null;
  /** 弹层在全局层级栈中的句柄（Esc 只关栈顶一层）。 */
  popupOverlay: OverlayHandle | null;
  pendingPatch: ConfigPatch | null;
  /** W750：409 挂起的模型/提供商切换（SSE done 后按同一路径重试一次）。 */
  pendingPick: ModelPick | null;
  merge(partial: StatusSnapshot): void;
  setNote(text: string, ms: number): void;
}

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

  popup.appendChild(el('div', 'sl-popup-title', kind === 'model' ? '切换模型' : '切换推理档位'));
  const body = el('div', 'sl-popup-body');
  popup.appendChild(body);

  // W795：可乐观的**先画终态**。
  //   · 推理档位：候选是静态常量 + 当前值 ⇒ 缓存有没有都同一帧画出来；
  //   · 模型清单：缓存命中 → 同步渲染；冷启动 → 正文先留空（本地确无真源，
  //     不写任何占位文案），首次拉取回来再一次换入（铁律 1：单次替换）。
  const seeded = peekConfig();
  if (kind === 'effort') {
    renderEffortList(body, seeded?.reasoning_effort ?? host.snapshotEffort ?? '', host);
  } else if (seeded !== null) {
    renderModelList(body, seeded, host);
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
      el('div', 'sl-popup-error', userErrorText(err, '无法读取当前配置，请稍后重试')),
    );
    return;
  }
  if (host.popup !== popup) return; // 期间被关闭/切换
  // 冷启动：首次结果直接渲染；命中缓存：内容真的变了才原地替换（否则零重建）。
  if (seeded === null || listChanged(kind, seeded, cfg)) renderList(body, kind, cfg, host);
}

/**
 * 渲染清单（离屏构建 + 单次替换，铁律 1）。
 * `cfg` 可以来自配置缓存（同步首屏）或一次真实拉取，渲染结果与来源无关。
 */
function renderList(body: HTMLElement, kind: SwitchKind, cfg: ConfigInfo, host: PickerHost): void {
  if (kind === 'effort') {
    renderEffortList(body, cfg.reasoning_effort ?? '', host);
    return;
  }
  renderModelList(body, cfg, host);
}

/**
 * 推理档位清单（W795 抽出）：候选全是静态常量 + 一个「当前」值 ⇒ 不依赖任何请求，
 * 冷启动也能同一帧画出来（乐观渲染），所以它与模型清单分成两个渲染器。
 */
function renderEffortList(body: HTMLElement, current: string, host: PickerHost): void {
  const off = document.createElement('div');
  const options = [...EFFORT_OPTIONS];
  const cur = current;
  if (cur && !options.some((o) => o.value === cur)) {
    options.push({ value: cur, label: cur + '（当前）' });
  }
  for (const o of options) {
    off.appendChild(optButton(o.label, o.value ?? '', cur, () => void apply(host, { reasoning_effort: o.value })));
  }
  body.replaceChildren(...off.childNodes);
}

function renderModelList(body: HTMLElement, cfg: ConfigInfo, host: PickerHost): void {
  const off = document.createElement('div');

  // ---- model：按提供商分组的树状清单（W262） ----
  const models = Array.isArray(cfg.available?.models) ? cfg.available.models : [];
  const cur = cfg.model ?? host.snapshotModel;
  if (!models.length) {
    // 清单缺失 → 内联文本输入降级
    const row = el('div', 'sl-popup-textrow');
    const input = el('input', 'sl-popup-input') as HTMLInputElement;
    input.placeholder = '模型名称';
    input.value = cur;
    row.appendChild(input);
    const applyBtn = el('button', 'btn btn-accent btn-mini', '应用') as HTMLButtonElement;
    applyBtn.addEventListener('click', () => {
      const v = input.value.trim();
      if (v !== '' && v !== cur) void apply(host, { model: v });
    });
    row.appendChild(applyBtn);
    off.appendChild(row);
    off.appendChild(el('div', 'sl-popup-note', '请输入模型名称'));
    body.replaceChildren(...off.childNodes);
    return;
  }
  const known = models.some((m) => m.id === cur);
  if (cur && !known) {
    // 当前模型不在清单里（自定义端点）→ 置顶一行，仍可点回
    off.appendChild(optButton(cur + '（当前）', cur, cur, () => void apply(host, { model: cur })));
    const sep = el('div', 'sl-popup-sep');
    sep.textContent = '候选模型';
    off.appendChild(sep);
  }
  // W750：当前生效项 = 后端标注的 active 行（同模型 + 同端点）。旧服务没有该
  // 字段时退回「按模型 id 匹配」；两者都没有 → 没有选中态，也不虚标。
  const activeRow = models.find((m) => m.active === true) ?? null;
  const sameId = models.find((m) => m.id === cur) ?? null;
  const currentProviderId = (activeRow?.provider_id ?? '').trim();
  const isCurrent = (m: ModelInfo): boolean =>
    activeRow !== null ? m.active === true : sameId !== null && m === sameId;
  // 树状一级 = provider 显示名（后端已保证模型名未定义时取 id）。
  // W750：同一 provider id 的记录聚成一组（显示名可能重复/被改，用 id 做键），
  // 缺 provider 字段的记录（静态兜底目录 / 旧数据）归入「其他」组。
  const groups: { pid: string; name: string; list: ModelInfo[] }[] = [];
  const byPid = new Map<string, { pid: string; name: string; list: ModelInfo[] }>();
  for (const m of models) {
    const pid = (m.provider_id ?? '').trim();
    const name = (m.provider ?? '').trim() || (pid !== '' ? pid : OTHER_GROUP);
    const key = pid !== '' ? pid : name;
    let group = byPid.get(key);
    if (!group) {
      group = { pid, name, list: [] };
      byPid.set(key, group);
      groups.push(group);
    }
    group.list.push(m);
  }
  for (const group of groups) {
    off.appendChild(groupRow(group.name, group.pid, group.list.some(isCurrent)));
    for (const m of group.list) {
      const pick: ModelPick = {
        model: m.id,
        // 显示名不是 id：只有拿到稳定 id 且与当前 provider 不同才需要先切 provider。
        providerId: (() => {
          const pid = (m.provider_id ?? '').trim();
          return pid !== '' && pid !== currentProviderId ? pid : '';
        })(),
      };
      off.appendChild(
        optButton(m.name || m.id, m.id, isCurrent(m) ? m.id : '', () => void pickModel(host, pick), true),
      );
    }
  }
  body.replaceChildren(...off.childNodes);
}

/**
 * W778：缓存清单与后台校验结果是否一致（不一致才允许原地替换）。
 * 只比对本渲染器真正用到的字段：档位看 reasoning_effort，模型看当前模型 + 清单。
 */
function listChanged(kind: SwitchKind, a: ConfigInfo, b: ConfigInfo): boolean {
  if (kind === 'effort') return (a.reasoning_effort ?? '') !== (b.reasoning_effort ?? '');
  return (
    (a.model ?? '') !== (b.model ?? '') ||
    JSON.stringify(a.available?.models ?? []) !== JSON.stringify(b.available?.models ?? [])
  );
}

/**
 * W262：树状分组标题行 —— 提供商显示名，不可点击（无 button/无监听）。
 * W750：组内含当前生效项时标一个「当前」；display name 与稳定 id 不同名时
 * 把 id 一并淡显，免得两个 provider 显示名相似时看不出切的是哪一个。
 */
function groupRow(provider: string, providerId: string, cur: boolean): HTMLElement {
  const row = el('div', 'sl-group' + (cur ? ' cur' : ''));
  row.appendChild(el('span', 'sl-group-name', provider));
  if (providerId !== '' && providerId !== provider) {
    row.appendChild(el('span', 'sl-group-id', providerId));
  }
  if (cur) row.appendChild(el('span', 'sl-group-tag', '当前'));
  return row;
}

/** 模型/档位一行；`sub=true` = 树状缩进一级（provider 组下的模型行）。 */
function optButton(
  label: string,
  value: string,
  current: string,
  onPick: () => void,
  sub = false,
): HTMLElement {
  const cls =
    'sl-opt' +
    (sub ? ' sub' : '') +
    (value !== '' && value === current ? ' current' : '');
  const b = el('button', cls) as HTMLButtonElement;
  // W750：模型行前置家族图标（未识别 → 不加节点，不占位）。
  const icon = modelIconEl(value);
  if (icon !== null) b.appendChild(icon);
  b.appendChild(el('span', 'sl-opt-name', label));
  if (value !== '') b.appendChild(el('span', 'sl-opt-val', value));
  if (value !== '' && value === current) b.appendChild(el('span', 'sl-opt-tag', '当前'));
  b.addEventListener('click', onPick);
  return b;
}

/**
 * W750：切到 (provider, model)。provider 不同 → 先 `POST /api/providers/default`
 * （带 provider_id 消歧：模型 id 跨 provider 会撞名），再 `POST /api/config {model}`；
 * 同一 provider → 只发后者（与旧行为逐字一致）。
 */
export async function pickModel(host: PickerHost, pick: ModelPick): Promise<void> {
  if (!host.popup) return;
  const popup = host.popup;
  const prev = revertPoint(host);
  // W795 乐观：点下去**同一帧**就把状态栏画成已切到该模型（终态），请求在后台跑。
  host.merge({ model: pick.model });
  try {
    await runPick(host, pick);
    host.setNote('已切换', 5000);
    closePopup(host);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // 轮次进行中 ⇒ 这一轮**没有**切过去：先把乐观显示退回原值，本轮结束后再重试同一路径
      host.merge(prev);
      host.pendingPick = pick;
      host.setNote('轮次进行中，将在本轮结束后生效', 0);
      closePopup(host);
    } else {
      // 失败回滚：把模型显示退回原值 + 就地说明原因（绝不假装切成功）
      host.merge(prev);
      const msg = '切换失败：' + (err instanceof Error ? err.message : String(err)) + '（已恢复原设置）';
      if (host.popup === popup) {
        popup.appendChild(el('div', 'sl-popup-status err', msg));
      } else {
        host.setNote(msg, 6000);
      }
    }
  }
}

/** W795：乐观切换的回滚基准（宿主字段 → 纯函数 ./optimistic.revertPointOf）。 */
function revertPoint(host: PickerHost): StatusSnapshot {
  return revertPointOf({ model: host.snapshotModel, effort: host.snapshotEffort });
}

/** 切换的实际动作（先 provider 后模型）；任一步失败即抛出，不吞错。 */
export async function runPick(host: PickerHost, pick: ModelPick): Promise<void> {
  if (pick.providerId !== '') await api.setDefaultModel(pick.model, pick.providerId);
  const d = await api.saveConfig({ model: pick.model });
  host.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
  window.dispatchEvent(new Event('studio:config-saved'));
}

/** POST /api/config 应用切换：成功→合并响应；409→挂起待 SSE done；其他→内联报错。 */
export async function apply(host: PickerHost, patch: ConfigPatch): Promise<void> {
  if (!host.popup) return;
  const popup = host.popup;
  const prev = revertPoint(host);
  // W795 乐观：同一帧内先按补丁画出终态（档位胶囊/模型格立即变），请求在后台跑。
  host.merge(optimisticPatchView(patch));
  try {
    const d = await api.saveConfig(patch);
    host.merge({ model: d.model, reasoning_effort: d.reasoning_effort });
    host.setNote('已切换', 5000);
    window.dispatchEvent(new Event('studio:config-saved'));
    closePopup(host);
  } catch (err) {
    const msg = '切换失败：' + (err instanceof Error ? err.message : String(err)) + '（已恢复原设置）';
    if (err instanceof ApiError && err.status === 409) {
      // 本轮不生效：退回原值 + 挂起，等本轮结束后重试（那时再乐观应用一次）
      host.merge(prev);
      host.pendingPatch = patch;
      host.setNote('轮次进行中，将在本轮结束后生效', 0);
      closePopup(host);
    } else {
      host.merge(prev);
      if (host.popup === popup) {
        popup.appendChild(el('div', 'sl-popup-status err', msg));
      } else {
        host.setNote(msg, 6000);
      }
    }
  }
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
  void runPick(host, pick)
    .then(() => {
      host.setNote('已切换', 5000);
    })
    .catch((err: unknown) => {
      host.merge(prev);
      host.setNote(
        '切换失败：' + (err instanceof Error ? err.message : String(err)) + '（已恢复原设置）',
        6000,
      );
    });
  return true;
}
