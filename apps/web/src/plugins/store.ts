// ============================================================================
// plugins/store.ts — 显示组件**启用表 + 配置**的客户端镜像（W895-C1 · W9108）。
// ----------------------------------------------------------------------------
// W859 把偏好存在浏览器 localStorage；W895-C1 把真源搬到服务端
// （GET/PUT /api/display-plugins）。本模块只保留：
//   · 服务端返回的 disabled 列表的**内存镜像**（装配时先按「全开」，取回后对齐）；
//   · W9108 同一份响应里的**插件配置**镜像（id -> { key: value }）；
//   · 一次性迁移：服务端为空且 localStorage 有旧值时，把旧值 PUT 上去；
//   · 纯函数 parseDisabled（迁移读取旧值用，语义与旧版逐字节一致）。
//
// W9108 的持久化取舍：**扩展现有服务端端点**，不用 localStorage。理由：
//   ① 与既有「服务端是真源」口径一致 —— 同一条记录（启用表）拆成两个真源，
//      会出现「开关同步了、配置没同步」这种没人能解释的半成品状态；
//   ② 契约改动面最小且**向后兼容**：config 是同一 PUT body 里的可选字段，
//      老客户端不发它 = 服务端保留原值，老服务端不认识它 = 前端读回 undefined，
//      两个方向都退化成「没有配置」而不是报错；
//   ③ 离线可用性不是本页的既有承诺 —— 启用表本来就要求服务端可达
//      （读失败 = 如实降级为全开，见下），配置跟着走不会**新增**离线缺口。
//
// 语义：
//   · 读失败 ⇒ disabled 为空（全开）+ 配置为空（全部用默认值），如实降级并记日志；
//   · 写失败 ⇒ 抛给调用方（apply 负责把注册状态/配置镜像回滚），内存镜像**不动**；
//   · 未知 id 在读取时被忽略（服务端只存字符串，认识 id 是前端的事）。
// ============================================================================

import { fetchDisplayPlugins, saveDisplayPlugins } from './server';
import type { PluginConfigMap, PluginConfigValues } from './config';

/** 旧 localStorage 键（唯一真源；只作为一次性迁移的读取来源）。 */
export const PLUGINS_STORAGE_KEY = 'celestea-studio.client-plugins-disabled';

/** 偏好变化事件（加载对齐、迁移与开关成功都会派发）。 */
export const CLIENT_PLUGINS_CHANGED = 'studio:client-plugins-changed';

/** 纯函数：解析禁用集合 —— 坏 JSON / 非数组 / 非字符串项一律忽略（返回空集）。 */
export function parseDisabled(raw: string | null): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * 纯函数：宽容解析服务端返回的配置镜像。
 *   · 不是「对象套对象」的项一律忽略（不猜、不造默认值 —— 默认值由描述决定）；
 *   · 值只收**非空字符串**（其余形态一律当作没配过）。
 */
export function parseConfigMap(raw: unknown): PluginConfigMap {
  const out: PluginConfigMap = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, values] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    const entry: PluginConfigValues = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (key === '' || typeof value !== 'string' || value === '') continue;
      entry[key] = value;
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/** 内存镜像：服务端表；未加载/读失败时为空 = 全部开启、全部用默认配置。 */
let cache: string[] = [];
let configCache: PluginConfigMap = {};
let loaded = false;
let available = true;

/** 当前禁用集合（读不到 = 空集 = 全部默认开启）。 */
export function disabledPlugins(): string[] {
  return [...cache];
}

/** 该组件是否被用户关掉（只看启用表，不看此刻挂没挂上）。 */
export function isDisabled(id: string): boolean {
  return cache.includes(id);
}

/** W9108：某插件**已保存**的配置值（没配过 = 空对象，默认值由描述决定）。 */
export function savedConfigOf(id: string): PluginConfigValues {
  const entry = configCache[id];
  return entry === undefined ? {} : { ...entry };
}

/** W9108：整张已保存的配置镜像（诊断/测试/落库用只读快照）。 */
export function savedConfigMap(): PluginConfigMap {
  return parseConfigMap(configCache);
}

/** 服务端表是否已经加载过（诊断/测试用）。 */
export function displayPluginsLoaded(): boolean {
  return loaded;
}

/** 上一次服务端读是否成功（诊断/测试用；false = 已降级为全开 + 全默认配置）。 */
export function displayPluginsServerAvailable(): boolean {
  return available;
}

/** 旧 localStorage 值（迁移用）；访问抛错（隐私模式）按「没有偏好」处理。 */
function legacyDisabled(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    return parseDisabled(localStorage.getItem(PLUGINS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * 旧键一旦**被服务端成功应答过**就作废，必须清掉。
 *
 * 为什么不是「迁移成功后再清」：那样只要服务端表**再次变空**（用户把组件重新打开就会），
 * 下次加载就会把旧值又搬回来，静默关掉用户刚打开的组件 —— 而且每次加载都重复。
 * 清不掉（隐私模式）也无妨：那种环境下 `legacyDisabled()` 同样读不到值，不会迁移。
 */
function clearLegacy(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PLUGINS_STORAGE_KEY);
  } catch {
    // 读得到却删不掉的环境不存在；真遇到也只是下次再尝试一次迁移（幂等）。
  }
}

/** 只保留已知 id（顺带清掉历史遗留的未知项）。 */
function knownOnly(knownIds: readonly string[], list: readonly string[]): string[] {
  return knownIds.filter((id) => list.includes(id));
}

/**
 * 从服务端加载启用表 + 配置（装配期调用一次）。
 *   · 读失败 ⇒ 空集（全开）+ 空配置（全默认）+ 记日志，返回空集；
 *   · 首次读到空表且 localStorage 有旧值 ⇒ 一次 PUT 迁移；迁移写失败则本次沿用旧值。
 */
export async function loadDisabledFromServer(knownIds: readonly string[]): Promise<string[]> {
  let server: string[];
  let config: PluginConfigMap;
  try {
    const wire = await fetchDisplayPlugins();
    server = Array.isArray(wire.disabled) ? wire.disabled.filter((x): x is string => typeof x === 'string') : [];
    config = parseConfigMap(wire.config);
    available = true;
  } catch (err) {
    available = false;
    cache = [];
    configCache = {};
    loaded = true;
    notify();
    console.warn('[plugins] 服务端启用表不可用，本次按全部开启、配置全部用默认值：' + messageOf(err));
    return [];
  }
  // 先取旧值（清掉就读不到了），再清键：服务端已应答 = 真源已切换，旧键作废。
  let disabled = knownOnly(knownIds, server);
  const legacy = disabled.length === 0 ? knownOnly(knownIds, legacyDisabled()) : [];
  clearLegacy();
  if (legacy.length > 0) {
    try {
      await saveDisplayPlugins(legacy, config);
    } catch (err) {
      console.warn('[plugins] 旧偏好迁移写入失败，本次沿用旧值：' + messageOf(err));
    }
    disabled = legacy;
  }
  cache = disabled;
  configCache = config;
  loaded = true;
  notify();
  return [...cache];
}

/**
 * 把一次开关写进服务端。**只有成功才更新内存镜像**；失败原样抛出，
 * 调用方据此回滚注册状态。返回真正落库的禁用集合。
 */
export async function persistDisabled(id: string, off: boolean, knownIds: readonly string[]): Promise<string[]> {
  return persistDisabledMany([{ id, off }], knownIds);
}

/**
 * W895-L：一次提交**多**个开关（插件库的「全部开启/关闭」、按分类批量）。
 *
 * 为什么必须有它：库视图的批量动作若退化成 N 次单开关调用，就是 N 次 PUT，
 * 每次都可能部分失败 —— 状态会停在「一半成一半败」而没有任何人能解释它。
 * 这里把整批**一次**落库（服务端是整表替换语义），于是要么全成、要么全不动。
 *
 * W9108：启用表与配置共用同一条 PUT（整表替换），所以这里把当前配置镜像**一起**
 * 发出去 —— 否则一次批量开关会把用户刚存的配置抹掉。
 */
export async function persistDisabledMany(
  changes: readonly { id: string; off: boolean }[],
  knownIds: readonly string[],
): Promise<string[]> {
  const next = new Set(cache);
  for (const c of changes) {
    if (c.off) next.add(c.id);
    else next.delete(c.id);
  }
  const kept = knownIds.filter((k) => next.has(k));
  await saveDisplayPlugins(kept, configCache);
  cache = kept;
  notify();
  return [...kept];
}

/**
 * W9108：写一个插件的配置。**只有成功才更新内存镜像**；失败原样抛出，
 * 调用方据此把界面拨回原值（与开关同一套 fail-closed 纪律）。
 *
 * 值一律是字符串，由调用方先经描述 normalize（见 config.ts）—— 本层不认识任何插件。
 */
export async function persistPluginConfig(
  id: string,
  values: PluginConfigValues,
  knownIds: readonly string[],
): Promise<PluginConfigValues> {
  const next: PluginConfigMap = { ...configCache };
  const entry: PluginConfigValues = { ...(next[id] ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value === '') delete entry[key];
    else entry[key] = value;
  }
  if (Object.keys(entry).length === 0) delete next[id];
  else next[id] = entry;
  // 与 disabled 一起整表替换：服务端是「一个资源」，两条信息必须同一次落库。
  await saveDisplayPlugins(knownIds.filter((k) => cache.includes(k)), next);
  configCache = next;
  notify();
  return { ...entry };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLIENT_PLUGINS_CHANGED));
}
