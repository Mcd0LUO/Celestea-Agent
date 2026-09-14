// ============================================================================
// ui/grants/panel/active.ts — 生效集的只读视图（W760 从 ../panel.ts 拆出）。
//
//   纯读取：把服务端的 grants / effective 折算成「哪些能力正在生效、范围是什么」。
//   shield / body / rows / quick 四个渲染模块都要问同一个问题，所以单独成一层 ——
//   否则它们得互相 import 才能共用，必然成环（W748 拆分时用 state.ts 消环的同一条理由）。
//   W760 只搬家：判定语义、过期口径、返回结构逐字与拆分前一致。
// ============================================================================
import type { GrantCap, GrantEntry } from '../../../types';
import { isExpired } from '../caps';
import { getData } from '../state';

/** 生效中的放宽项（已过期的不计；§3.2）。 */
export function activeGrants(): GrantEntry[] {
  return (getData()?.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
}

export function activeFor(cap: GrantCap): GrantEntry | null {
  const list = activeGrants().filter((g) => g.cap === cap);
  return list.length ? list[list.length - 1]! : null;
}

export function expiredFor(cap: GrantCap): GrantEntry[] {
  return (getData()?.grants ?? []).filter((g) => g.cap === cap && isExpired(g));
}

/** 即将失效阈值（秒）：盾牌上的小圆点（设计 §3.1）。 */
export const EXPIRING_SEC = 120;
