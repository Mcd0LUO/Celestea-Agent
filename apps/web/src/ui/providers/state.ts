// ============================================================================
// ui/providers/state.ts — 「模型提供商」模块级共享状态（W748 从 ui/providers.ts 拆出）。
//   只做搬家：状态所有权、解析时机、取值语义与拆分前**逐字一致**。
//   宿主元素在 import 期解析（拆分前也在 import 期 need('#settingsProviders')）
//   —— 缺失即整包导入失败，行为不变。
// ============================================================================
import { need } from '../../utils/dom';
import type { ProviderInfo } from '../../types';

/** 设置页「模型提供商」容器（index.html #settingsProviders）。 */
export const boxEl = need<HTMLElement>('#settingsProviders');

let providers: ProviderInfo[] = [];
let defaultModel: string | null = null;

/** 已展开的内联面板（provider id）：列表刷新后恢复展开态（铁律 2）。 */
export const openPanels = new Set<string>();

export function getProviders(): ProviderInfo[] {
  return providers;
}

export function getDefaultModel(): string | null {
  return defaultModel;
}

/** GET /api/providers 结果一次性落盘（列表 + 默认模型）。 */
export function setProviderData(list: ProviderInfo[], def: string | null): void {
  providers = list;
  defaultModel = def;
}

export function setDefaultModel(v: string | null): void {
  defaultModel = v;
}

/** 共享小工具：错误 → 一行文案（与拆分前的 fmtErr 逐字一致）。 */
export function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
