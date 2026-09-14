// ============================================================================
// ui/grants/marks.ts — 侧栏会话叶子的「已放宽权限」标记（按需查询 + 局部更新）
//   （W748 从 ui/grants.ts 拆出；纯搬运，TTL/并发/缓存/事件语义逐字未改。）
//   能力位未就绪时 ensureGrantMarks 是**空操作**（不发起任何请求）。
// ============================================================================
import { api } from '../../api';
import { DANGER_CAPS, isExpired, type GrantMark } from './caps';

/** 放宽标记变化事件（侧栏会话叶子订阅；只做局部更新）。 */
export const GRANTS_CHANGED_EVENT = 'studio:grants-changed';

/** 侧栏标记的按需查询结果缓存时长。 */
const MARK_TTL_MS = 120000;
const SCAN_CONCURRENCY = 3;
const SCAN_MAX = 40;

/** 侧栏标记缓存 + 已探测时刻（失败也计时，避免反复打同一个会话）。 */
const marks = new Map<string, GrantMark>();
const probedAt = new Map<string, number>();

/** 能力位镜像：由 grants.ts 的 applyCapability 单向写入（与拆分前 capability 判定等价）。 */
let marksEnabled = false;

export function setMarksEnabled(on: boolean): void {
  marksEnabled = on;
}

/** 记录一次探测时刻（能力位就绪时的聚焦会话刷新也会计时）。 */
export function noteProbed(sessionId: string): void {
  noteProbed(sessionId);
}

/** 某会话的放宽标记（未探测到 = null，不显示标记）。 */
export function grantMarkOf(sessionId: string): GrantMark | null {
  const m = marks.get(sessionId);
  return m && m.count > 0 ? m : null;
}

export function emitChanged(): void {
  window.dispatchEvent(new Event(GRANTS_CHANGED_EVENT));
}

export function setMark(sessionId: string, mark: GrantMark): void {
  if (sessionId === '') return;
  const prev = marks.get(sessionId);
  const same =
    prev !== undefined &&
    prev.count === mark.count &&
    prev.danger === mark.danger &&
    prev.caps.join(',') === mark.caps.join(',');
  if (mark.count > 0) marks.set(sessionId, mark);
  else marks.delete(sessionId);
  if (!same) emitChanged();
}
/** 按需查询若干会话的放宽标记（并发受控；能力位未就绪时为空操作）。 */
export function ensureGrantMarks(ids: readonly string[]): void {
  if (!marksEnabled || ids.length === 0) return;
  const now = Date.now();
  const queue: string[] = [];
  for (const id of ids) {
    if (!id || queue.includes(id)) continue;
    const at = probedAt.get(id);
    if (at !== undefined && now - at < MARK_TTL_MS) continue;
    queue.push(id);
    if (queue.length >= SCAN_MAX) break;
  }
  if (!queue.length) return;
  let i = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const idx = i++;
      if (idx >= queue.length) return;
      await fetchMark(queue[idx]!);
    }
  };
  for (let k = 0; k < Math.min(SCAN_CONCURRENCY, queue.length); k++) void run();
}

async function fetchMark(sessionId: string): Promise<void> {
  noteProbed(sessionId);
  try {
    const r = await api.grants(sessionId);
    if (r.error) return;
    const active = (r.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
    const caps = active.map((g) => String(g.cap));
    setMark(sessionId, {
      count: active.length,
      danger: caps.some((c) => DANGER_CAPS.has(c)),
      caps,
    });
  } catch {
    // 该会话不可查（已删除 / 能力未就绪）：保持现状，不显示标记、不报错
  }
}
