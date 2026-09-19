// ============================================================================
// statusline/picker-shared.ts — W870：picker 的**共享契约层**（纯类型 + 常量）。
//
//   为什么单独一层：W870 把「画什么」（./picker-list.ts）从「弹层生命周期与请求」
//   （./picker.ts）里拆出来 —— picker-list 需要 PickerHost / SwitchKind / ModelPick
//   与两个静态常量，若它反过来 import ./picker.ts 就成环（.dependency-cruiser.cjs
//   的 no-circular 是 error）。契约放这里，两边都只向下依赖，零环。
//
//   ./picker.ts 对 statusline.ts 与测试**原样再导出**这些名字（调用方零改动）。
// ============================================================================
import type { OverlayHandle } from '../utils/overlays';
import type { ConfigPatch, StatusSnapshot } from '../types';
import { t } from '../i18n'; // i18n P1-a

/** W262：没有 provider 字段的模型（静态兜底目录 / 旧数据）归入的树状分组名。 */
export function otherGroupLabel(): string {
  return t('statusline.picker.other');
}

/** 推理档位候选（label 走字典，故做成函数：语言切换后重新取用）。 */
export function effortOptions(): readonly { value: string | null; label: string }[] {
  return [
    { value: null, label: t('statusline.picker.standardClear') },
    { value: 'low', label: 'low' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' },
  ];
}

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
  /** 当前快照里的模型（该会话的状态线真源，按会话缓存保留显示）。 */
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
  /**
   * W870：当前聚焦会话 id（'' = 未解析/旧单会话容器）。
   * 非空 ⇒ 模型切换打**会话级**端点；空 ⇒ 回落全局 POST /api/config。
   * 与 ModeHost.sessionId 同源（Statusline 的 get sessionId）。
   */
  readonly sessionId: string;
  /**
   * W870：该会话当前是否**有**自己的 `session.json.model` 覆盖 —— 选择器用它
   * 如实标一行「本会话已固定模型」，让用户知道它为什么不跟全局走。
   * 快照里没有这个字段时返回 false（老服务 / 首次轮询未回）。
   */
  readonly sessionModelFixed: boolean;
  merge(partial: StatusSnapshot): void;
  setNote(text: string, ms: number): void;
}

/**
 * W870：渲染器与请求逻辑之间的**唯一缝**。列表渲染只负责「点了要做什么」的
 * 意图，具体请求仍留在 ./picker.ts（那里才 import ./session-model.ts）。
 */
export interface ListHooks {
  /** 档位补丁 / 无清单时的模型名输入。 */
  apply(patch: ConfigPatch): void;
  /** 点了一个 (provider, model) 行。 */
  pick(pick: ModelPick): void;
}
