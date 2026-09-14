// ============================================================================
// ui/grants/request.ts — 授予请求的取值与构造（W773 新建；纯函数，零 DOM/零网络）。
//
//   为什么单独一层：**默认永久**是这一轮的产品决定，必须有唯一一处可被机械断言的
//   实现 —— `ttlOf(def)` 返回 0（永久），`reqFor()` 就发出 `ttl_sec: 0`。
//   `tools/check-grants-permanent.mjs` 直接在 node 里 import 本模块断言这条链路，
//   而不是靠读源码。
//
//   `maxTtlOf` / `ttlOf` 原在 ./panel/phrase.ts（W760 拆分时搬过去），本轮搬到本模块：
//   它们与 reqFor 是同一件事（「这次授予发多长时间」），且搬迁后 panel 层不再是
//   flow.ts 取 TTL 的必经之路（panel.ts 仍原样再导出，对外 API 不变）。
// ============================================================================
import type { GrantReq, GrantScope } from '../../types';
import { TEMP_DEFAULT_SEC, type CapDef } from './caps';
import { getData, ttlPick } from './state';

/** 该能力的有效期上限（服务端 max_ttl_sec 优先；供面板与快捷授权共用）。 */
export function maxTtlOf(def: CapDef): number {
  const v = getData()?.max_ttl_sec?.[def.cap];
  return typeof v === 'number' && v > 0 ? v : def.maxTtl;
}

/**
 * 本次授予的有效期（秒）。**0 = 永久**：
 *   · 没在「临时授权…」里选过 ⇒ `def.defaultTtl`（W773 起每个 cap 都是 0）⇒ 永久；
 *   · 选了「永久」⇒ 0；
 *   · 选了具体时长 ⇒ 按该能力的服务端上限收敛（0 不受上限约束，永久不该被截断）。
 */
export function ttlOf(def: CapDef): number {
  const picked = ttlPick.get(def.cap);
  if (picked === undefined) return def.defaultTtl;
  return picked === 0 ? 0 : Math.min(picked, maxTtlOf(def));
}

/** 「临时授权…」展开时的初始时长（30 分钟档，再按该能力上限收敛；unsandboxed 得 900）。 */
export function tempDefaultTtl(def: CapDef): number {
  return Math.min(TEMP_DEFAULT_SEC, maxTtlOf(def));
}

/** 授予请求体：`ttl_sec` 直接取上面的取值（unsandboxed 只允许使用一次；§3.2 注）。 */
export function reqFor(def: CapDef, scope: GrantScope, ttlSec: number): GrantReq {
  const req: GrantReq = { cap: def.cap, scope, ttl_sec: ttlSec };
  if (def.cap === 'unsandboxed') req.uses_left = 1;
  return req;
}
