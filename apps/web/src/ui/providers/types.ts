// ============================================================================
// ui/providers/types.ts — 「模型提供商」内部数据契约
//   （W748 从 ui/providers.ts 拆出；纯搬运，字段/语义未改）。
// ============================================================================
import type { ProviderModelSpec } from '../../types';

/** 可点击多选档位片（toggle chips）：选中只切 class，不重建 DOM（铁律 4/8）。 */
export interface EffortChips {
  root: HTMLElement;
  /** 回填选中态：非固定档位（存量 xhigh / 历史 medium）自动补一片并插在「+」左侧，
   *  保证往返不丢数据、不被吞掉。 */
  set(values: readonly string[]): void;
  /** 当前选中档位（EFFORT_TIERS 顺序在前，非标准档位排后）。 */
  values(): string[];
}

export interface ModelRow {
  id: HTMLInputElement;
  name: HTMLInputElement;
  /** W258 任务 3 / W261：推理强度 = 可点击档位片（low/high/max + 自定义，可多选） */
  efforts: EffortChips;
  ctx: HTMLInputElement;
  maxOut: HTMLInputElement;
  li: HTMLElement;
}

export interface ProviderPayload {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: string;
  api_key?: string;
  models: ProviderModelSpec[];
}

export interface EditorRefs {
  /** 表单根 DOM（字段 + 模型列表 + 操作行） */
  root: HTMLElement;
  name: HTMLInputElement;
  note: HTMLInputElement;
  key: HTMLInputElement;
  url: HTMLInputElement;
  format: HTMLSelectElement;
  modelsBox: HTMLElement;
  status: HTMLElement;
  rows: ModelRow[];
  /** 内容高度变化回调（内联面板用于重算 max-height） */
  onLayout?: (() => void) | undefined;
  /** W262: 编辑既有提供商时的原始 id（身份）；新建为 undefined。
   *  名称字段只是显示名，绝不能拿它当 id —— 否则热编辑会把同一条记录
   *  存成第二个 id（同名两条网关的根因）。 */
  originalId?: string | undefined;
}

export interface FormHooks {
  /** 保存成功（后端接受）→ 收起面板/关弹窗 + 刷新数据 */
  onSaved: (payload: ProviderPayload) => void;
  /** 取消 */
  onCancel: () => void;
  /** 内容高度变化（内联面板重算 max-height；弹窗忽略） */
  onLayout?: (() => void) | undefined;
}

/** 列表渲染宿主：局部刷新失败/整表兜底时回到编排入口（避免模块间循环引用）。 */
export interface ProviderListHost {
  loadProviders(): Promise<void>;
}
