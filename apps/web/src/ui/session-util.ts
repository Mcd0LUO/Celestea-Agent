// ============================================================================
// ui/session-util.ts — 会话容器相关的两个小工具（W784 从 chat.ts 原样搬出）。
//
// 为什么搬出来：`/compact` 流程本轮从 chat.ts 拆到 ./compact.ts（chat.ts 是登记的
// 超大文件，棘轮只许降不许升），而这两个小工具是两个模块都要用的 —— 与其在两边
// 各抄一份，不如留一个真源。纯搬家：行为 / 文案逐字不变。
// ============================================================================
import { LOCAL_ID, type SessionPane } from './viewctx';

/** 请求要带的会话 id：LOCAL（尚未认领到真实会话）→ undefined（旧服务行为）。 */
export function sid(ctx: SessionPane): string | undefined {
  return ctx.id === LOCAL_ID ? undefined : ctx.id;
}

/** 异常 → 展示文本（与原 chat.ts 内的私有实现逐字一致）。 */
export function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
