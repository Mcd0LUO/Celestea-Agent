// ============================================================================
// plugins/register.ts — 客户端插件的**注册记账口**（W859）。
// ----------------------------------------------------------------------------
// 为什么需要它：ui/hint/registry.ts 的 registerHintPlugin 返回注销器，但装配点
// 过去直接把它丢掉（initHints / initRail）——设置页的开关要真的注销/重挂，
// 就必须有人保存这些注销器。本模块就是那个「人」，且它是唯一的记账处：
//   · 提供者所在模块（ui/rail.ts）与内建装配（plugins/apply.ts）都经这里注册；
//   · 关闭状态下的提供者仍然交回工厂（只是不挂载）——重新打开才能挂回去；
//   · 注册/注销失败原样抛出，由 apply 决定回滚与文案（此处不吞错）。
// 它不认识任何具体插件（零 descriptor 依赖），因此不会与 ui/rail.ts 成环。
// ============================================================================
import { registerHintPlugin as registerInRegistry, type HintPlugin } from '../ui/hint/registry';
import { isDisabled } from './store';

/** id → 提供者工厂（装配点交回的最近一个；关闭状态下也记住）。 */
const factories = new Map<string, () => HintPlugin>();
/** id → 注销器（只在真的挂载着时有值）。 */
const disposers = new Map<string, () => void>();

function noop(): void {}

/** 该 id 此刻是否真的挂在提示注册表里（诊断/测试用）。 */
export function isRegistered(id: string): boolean {
  return disposers.has(id);
}

/** 已挂载的提供者 id（诊断/测试用）。 */
export function registeredIds(): string[] {
  return [...disposers.keys()];
}

/**
 * 交回一个提供者并（在启用时）注册：幂等 —— 同 id 重复交回 = 撤旧挂新（重挂语义）。
 * 关闭状态下只记账不挂载，返回 no-op 注销器。
 */
export function registerHintPlugin(plugin: HintPlugin): () => void {
  factories.set(plugin.id, () => plugin);
  if (isDisabled(plugin.id)) return noop;
  return swapIn(plugin.id);
}

/** 挂载一个已交回的提供者（重新打开开关）；未交回过 → 抛错，调用方回滚并说明。 */
export function activatePlugin(id: string): void {
  if (disposers.has(id)) return;
  swapIn(id);
}

/** 注销一个已挂载的提供者（关闭开关）；未挂载 → no-op（幂等）。 */
export function deactivatePlugin(id: string): void {
  const off = disposers.get(id);
  if (!off) return;
  off();
  disposers.delete(id);
}

function swapIn(id: string): () => void {
  const factory = factories.get(id);
  if (!factory) throw new Error('no provider handed back for ' + id);
  const prev = disposers.get(id);
  if (prev) {
    prev();
    disposers.delete(id);
  }
  const off = registerInRegistry(factory());
  disposers.set(id, off);
  return off;
}
