// ============================================================================
// plugins/store.ts — 显示组件启用表的**客户端镜像**（W895-C1）。
// ----------------------------------------------------------------------------
// W859 把偏好存在浏览器 localStorage；W895-C1 把真源搬到服务端
// （GET/PUT /api/display-plugins）。本模块只保留：
//   · 服务端返回的 disabled 列表的**内存镜像**（装配时先按「全开」，取回后对齐）；
//   · 一次性迁移：服务端为空且 localStorage 有旧值时，把旧值 PUT 上去；
//   · 纯函数 parseDisabled（迁移读取旧值用，语义与旧版逐字节一致）。
// 语义：
//   · 读失败 ⇒ 内存镜像为空 = 全部开启（如实降级，不伪造、不崩）；
//   · 写失败 ⇒ 抛给调用方（apply 负责把注册状态回滚），内存镜像**不动**；
//   · 未知 id 在读取时被忽略（服务端只存字符串，认识 id 是前端的事）。
// ============================================================================

import { fetchDisplayPlugins, saveDisplayPlugins } from './server';

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

/** 内存镜像：服务端表；未加载/读失败时为空 = 全部开启。 */
let cache: string[] = [];
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

/** 服务端表是否已经加载过（诊断/测试用）。 */
export function displayPluginsLoaded(): boolean {
  return loaded;
}

/** 上一次服务端读是否成功（诊断/测试用；false = 已降级为全开）。 */
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
 * 从服务端加载启用表（装配期调用一次）。
 *   · 读失败 ⇒ 空集（全开）+ 记日志，返回空集；
 *   · 首次读到空表且 localStorage 有旧值 ⇒ 一次 PUT 迁移；迁移写失败则本次沿用旧值。
 */
export async function loadDisabledFromServer(knownIds: readonly string[]): Promise<string[]> {
  let server: string[];
  try {
    server = await fetchDisplayPlugins();
    available = true;
  } catch (err) {
    available = false;
    cache = [];
    loaded = true;
    notify();
    console.warn('[plugins] 服务端启用表不可用，本次按全部开启：' + messageOf(err));
    return [];
  }
  // 先取旧值（清掉就读不到了），再清键：服务端已应答 = 真源已切换，旧键作废。
  let disabled = knownOnly(knownIds, server);
  const legacy = disabled.length === 0 ? knownOnly(knownIds, legacyDisabled()) : [];
  clearLegacy();
  if (legacy.length > 0) {
    try {
      await saveDisplayPlugins(legacy);
    } catch (err) {
      console.warn('[plugins] 旧偏好迁移写入失败，本次沿用旧值：' + messageOf(err));
    }
    disabled = legacy;
  }
  cache = disabled;
  loaded = true;
  notify();
  return [...cache];
}

/**
 * 把一次开关写进服务端。**只有成功才更新内存镜像**；失败原样抛出，
 * 调用方据此回滚注册状态。返回真正落库的禁用集合。
 */
export async function persistDisabled(id: string, off: boolean, knownIds: readonly string[]): Promise<string[]> {
  const next = new Set(cache);
  if (off) next.add(id);
  else next.delete(id);
  const kept = knownIds.filter((k) => next.has(k));
  await saveDisplayPlugins(kept);
  cache = kept;
  notify();
  return [...kept];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLIENT_PLUGINS_CHANGED));
}
