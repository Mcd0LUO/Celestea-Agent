// ============================================================================
// plugins/apply.ts — 客户端插件的装配与**真热开关**（W859 · W895-C1 · W9108）。
// ----------------------------------------------------------------------------
//   startClientPlugins()     装配时调用一次：先乐观挂载「全开」，再异步取服务端
//                            启用表 + 配置并对齐（真注销/真重挂）。
//   whenClientPluginsReady() 取表 + 对齐完成；设置页在渲染开关初值前 await 它。
//   setClientPlugin(id,on)   开关：真的注册/真的注销（幂等），注册失败或服务端
//                            PUT 失败都回滚，且**不改内存镜像**。
//   setClientPluginConfig()  W9108：写一个插件的配置项（同一套 fail-closed 纪律）。
// 语义要点：
//   · 乐观优先 —— 调用方（设置页）当帧翻开关，本函数同步完成注册/注销；
//   · 失败回滚 —— 注册抛错 ⇒ 不留半挂载；PUT 抛错 ⇒ 把旧挂载状态挂回去，
//     且内存镜像不变，下次打开页面仍是服务端的值；
//   · 未知 id / 未知配置项一律拒绝（不猜、不静默成功）；
//   · 服务端不可用 ⇒ 如实降级为全开 + 配置全默认（loadDisabledFromServer）。
//
// W9108 的**顺序不变量**：内置两遍（高亮 / 数学）现在是登记表里的普通行，
// 「关掉再打开」= 注销 + 重新注册。执行顺序因此不能靠注册时机，而是由增强缝的
// `order` 常量声明（ui/enhance/registry.ts），重建后仍然 hljs → code-extras。
// ============================================================================
import { clientPlugins, clientPluginById, clientPluginConfig, clientPluginIds } from './descriptor';
import { effectiveConfig, normalizeItem, type PluginConfigValues } from './config';
import { t } from '../i18n';
import { activatePlugin, deactivatePlugin, isRegistered, registerEnhancerPlugin, registerHintPlugin } from './register';
import { isDisabled, loadDisabledFromServer, persistDisabled, persistDisabledMany, persistPluginConfig, savedConfigOf } from './store';

/** 切换回执：pane 就地显示；失败时 pane 负责把开关拨回去（状态没变）。 */
export interface ToggleResult {
  ok: boolean;
  text: string;
}

/** 服务端取表 + 对齐的完成信号（null = startClientPlugins 还没跑过）。 */
let ready: Promise<void> | null = null;

/** 装配内建客户端插件（ui/hint 的 initHints 调用；幂等，只挂当前启用的）。 */
export function startClientPlugins(): void {
  // W9108：内置两遍（高亮 / 数学）现在也在 clientPlugins() 里，所以这里不再单独调
  // registerBuiltinEnhancers() —— 那会造成同 id 注册两次（第二次替换第一次，结果一样
  // 但语义含糊）。「模块加载即装配」仍由 ui/enhance/builtin.ts 的末尾保证：任何
  // import 到增强缝的地方都立刻得到这两遍，与本函数的调用时机无关。
  for (const d of clientPlugins()) {
    // W895：两种缝共用同一套记账，只有「挂到哪」不同。
    if (d.kind === 'hint') registerHintPlugin(d.create());
    else registerEnhancerPlugin(d.create());
  }
  // W895-C1：启用表在服务端，首次读取是异步的。上面的挂载是乐观的（全开）；
  // 表回来后按它对齐 —— 既不拖慢首屏，也不需要「加载中」占位。
  ready = reconcileFromServer();
}

/** 服务端表到达后，把实际挂载状态与配置对齐到它（真注销 / 真重挂）。 */
async function reconcileFromServer(): Promise<void> {
  await loadDisabledFromServer(clientPluginIds());
  for (const d of clientPlugins()) {
    if (isDisabled(d.id)) deactivatePlugin(d.id);
    else activatePlugin(d.id);
  }
  for (const d of clientPlugins()) applyConfig(d.id);
}

/**
 * W9108：把某个插件的**生效配置**推给它的实现（登记项自带的 onConfig 回调）。
 *
 * 这里刻意只做「算值 → 交回登记项」：控件类型、插件身份都不在这里分派，
 * 于是新增插件/新增配置项不需要动 apply 层。
 */
function applyConfig(id: string): void {
  const spec = clientPluginConfig(id);
  const d = clientPluginById(id);
  if (spec === undefined || d === null || d.onConfig === undefined) return;
  d.onConfig(effectiveConfig(spec, savedConfigOf(id)));
}

/**
 * 取表 + 对齐完成。设置页在渲染开关初值前 await 它，这样首帧就是服务端真值；
 * 若装配还没跑过则立即完成（全开），不阻塞。
 */
export function whenClientPluginsReady(): Promise<void> {
  return ready ?? Promise.resolve();
}

/** 该插件此刻是否真的挂着（不是看偏好；诊断/测试/设置页初值都用它）。 */
export function isClientPluginOn(id: string): boolean {
  return isRegistered(id);
}

/** 该插件此刻的**生效配置**（默认值 + 已保存值；诊断/设置页初值都用它）。 */
export function clientPluginConfigValues(id: string): PluginConfigValues {
  const spec = clientPluginConfig(id);
  if (spec === undefined) return {};
  return effectiveConfig(spec, savedConfigOf(id));
}

/** 幂等开关：真的注册/注销，成功后写服务端；失败保持原状态并返回说明。 */
export async function setClientPlugin(id: string, on: boolean): Promise<ToggleResult> {
  const d = clientPluginById(id);
  if (d === null) return { ok: false, text: t('plugins.notFound') };
  const wasOn = isRegistered(id);
  try {
    if (on) activatePlugin(id);
    else deactivatePlugin(id);
  } catch (err) {
    restore(id, wasOn);
    console.warn('[plugins] 切换失败：' + messageOf(err));
    return { ok: false, text: t('plugins.toggleFailed', { label: d.label }) };
  }
  try {
    await persistDisabled(id, !on, clientPluginIds());
  } catch (err) {
    // W895-C1: 服务端写失败 ⇒ 回滚真挂载状态，内存镜像也没动（persistDisabled
    // 只在成功后才更新它）。界面据此把开关拨回，且下次打开仍是服务端的值。
    restore(id, wasOn);
    console.warn('[plugins] 偏好写入失败：' + messageOf(err));
    return { ok: false, text: t('plugins.toggleFailed', { label: d.label }) };
  }
  return { ok: true, text: t('plugins.toggled', { state: on ? t('plugins.on') : t('plugins.off'), label: d.label }) };
}

/**
 * W9108：写一个插件的**单个配置项**（就地保存）。
 *
 * 纪律与开关完全一致：值先经描述 normalize（界面上显示的 = 能存下去的），
 * 服务端写失败 ⇒ 内存镜像不动、生效值不动、返回失败让界面拨回原值 ——
 * 绝不静默吞掉用户的配置，也绝不把默认值当成已保存。
 */
export async function setClientPluginConfig(id: string, key: string, raw: string): Promise<ToggleResult> {
  const d = clientPluginById(id);
  const spec = d?.config;
  if (d === null || spec === undefined) return { ok: false, text: t('plugins.notFound') };
  const item = spec.items.find((x) => x.key === key);
  if (item === undefined) return { ok: false, text: t('plugins.notFound') };
  const value = normalizeItem(item, raw);
  try {
    await persistPluginConfig(id, { [key]: value }, clientPluginIds());
  } catch (err) {
    console.warn('[plugins] 配置写入失败：' + messageOf(err));
    return { ok: false, text: t('plugins.config.saveFailed', { label: d.label }) };
  }
  applyConfig(id);
  return { ok: true, text: t('plugins.config.saved', { label: d.label }) };
}

/**
 * W895-L：批量开关（插件库的「全部」/按分类）。
 *
 * 与 setClientPlugin 同一套纪律：先当帧改真挂载状态，再**一次**写服务端；
 * 写失败 ⇒ 把**整批**挂载状态回滚到动手前，且内存镜像不动（persistDisabledMany
 * 只在成功后才更新它）。不做「逐个 try」—— 那会留下没人能解释的半成品状态。
 */
export async function setClientPlugins(ids: readonly string[], on: boolean): Promise<ToggleResult> {
  const known = ids.filter((id) => clientPluginById(id) !== null);
  if (known.length === 0) return { ok: false, text: t('plugins.notFound') };
  const before = known.map((id) => ({ id, on: isRegistered(id) }));
  try {
    for (const id of known) { if (on) activatePlugin(id); else deactivatePlugin(id); }
  } catch (err) {
    for (const b of before) restore(b.id, b.on);
    console.warn('[plugins] 批量切换失败：' + messageOf(err));
    return { ok: false, text: t('plugins.toggleFailedMany', { n: String(known.length) }) };
  }
  try {
    await persistDisabledMany(known.map((id) => ({ id, off: !on })), clientPluginIds());
  } catch (err) {
    for (const b of before) restore(b.id, b.on);
    console.warn('[plugins] 批量写入失败：' + messageOf(err));
    return { ok: false, text: t('plugins.toggleFailedMany', { n: String(known.length) }) };
  }
  return { ok: true, text: t('plugins.toggledMany', { state: on ? t('plugins.on') : t('plugins.off'), n: String(known.length) }) };
}

/** 兜底把实际挂载状态拉回期望值（失败路径专用；再失败只记日志，不掩盖原始错误）。 */
function restore(id: string, on: boolean): void {
  try {
    if (on) activatePlugin(id);
    else deactivatePlugin(id);
  } catch (err) {
    console.warn('[plugins] 回滚失败：' + messageOf(err));
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
