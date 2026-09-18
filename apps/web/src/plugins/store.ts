// ============================================================================
// plugins/store.ts — 客户端插件偏好的持久化（W859）。
// ----------------------------------------------------------------------------
// 存的是**禁用集合**而不是启用集合：以后新增内建插件时，老用户的存量键里没有
// 它 ⇒ 默认开启（与「默认开」的产品语义一致）；存启用集合会得到相反结果。
// 键命名空间化（celestea-studio.*，与 theme / sidebar 同族），避免与别的键冲突。
// 全部读写 fail-safe：坏 JSON / 非数组 / 非字符串项 / 存储不可用都不抛、不误关。
// ============================================================================

/** 持久化键（唯一真源；测试与诊断读它）。 */
export const PLUGINS_STORAGE_KEY = 'celestea-studio.client-plugins-disabled';

/** 偏好变化事件（乐观改动与回滚都会派发）。 */
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

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 隐私模式等场景访问即抛：按「没有偏好」处理
  }
}

/** 当前禁用集合（读不到 = 空集 = 全部默认开启）。 */
export function disabledPlugins(): string[] {
  const s = store();
  return s === null ? [] : parseDisabled(s.getItem(PLUGINS_STORAGE_KEY));
}

/** 该插件是否被用户关掉（只看偏好，不看此刻挂没挂上）。 */
export function isDisabled(id: string): boolean {
  return disabledPlugins().includes(id);
}

/**
 * 写入某个插件的开关偏好：只保留已知 id（顺带清掉历史遗留的未知项），并广播变更。
 * 返回真正落库的禁用集合。存储写失败只记日志（界面不假装成功）。
 */
export function setDisabled(id: string, off: boolean, knownIds: readonly string[]): string[] {
  const next = new Set(disabledPlugins());
  if (off) next.add(id);
  else next.delete(id);
  const kept = knownIds.filter((k) => next.has(k));
  const s = store();
  if (s !== null) {
    try {
      s.setItem(PLUGINS_STORAGE_KEY, JSON.stringify(kept));
    } catch (err) {
      console.warn('[plugins] 偏好写入失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }
  notify();
  return kept;
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLIENT_PLUGINS_CHANGED));
}
