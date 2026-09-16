// ============================================================================
// ui/compact.ts — W259 `/compact` 上下文压缩命令（W784 从 chat.ts 原样搬出）。
//
// 为什么搬：`chat.ts` 是**登记在案**的超大文件（tools/module-size-baseline.json，
// 棘轮只许降不许升），而 W784 的提问接线必须往 chat.ts 加行 —— 按
// `tools/check-module-size.mjs` 的规矩「超了就拆」，把这段自成一体的压缩流程整段
// 挪出来（它的两个模块级状态 compacting / localCompactAt 只服务它自己）。
// **纯搬家：行为 / 文案 / 时序逐字不变**，chat.ts 仍从本模块拿 runCompact / onCompact。
// ============================================================================
import { api } from '../api';
import type { CompactPayload } from '../types';
import { clearInput } from './inputbar';
import { flashStatus, setStatus } from './statusbar';
import { activePane, isActivePane, paneOf, type SessionPane } from './viewctx';
import { resolveActiveSession, restoreSessionHistory } from './restore';
import { msgOf, sid } from './session-util';

// ---- W259 /compact -------------------------------------------------------------

/** 压缩请求进行中（防连点）。 */
let compacting = false;
/** R3 W838-F10：本地刚压缩过的**每会话**时间戳 —— 单一全局值会吞掉别的会话的 compact SSE。 */
const localCompactAt = new Map<string, number>();
const LOCAL_COMPACT_DEDUP_MS = 5_000;

/** 收到 compact SSE：只对对应容器重载消息区（运行中不打断），不打扰其它会话。 */
export function onCompact(p: CompactPayload): void {
  const id = typeof p.session === 'string' && p.session !== '' ? p.session : null;
  const ctx = id ? (paneOf(id) ?? null) : activePane();
  if (!ctx) return;
  // R3 W838-F10：去重按**路由后的会话**判定 —— A 刚压缩不吞 B 的 compact SSE。
  if (Date.now() - (localCompactAt.get(ctx.id) ?? 0) < LOCAL_COMPACT_DEDUP_MS) return;
  if (ctx.streaming) return;
  void (async () => {
    await restoreSessionHistory(ctx);
    if (isActivePane(ctx)) flashStatus(p.note || '上下文已压缩', 'ok');
  })();
}

/**
 * `/compact` 命令流程（W259）：仅当输入整体 trim 后精确等于 "/compact" 时触发，
 * 命令被消费（清空输入框），绝不写入用户气泡、绝不 POST /api/turn。
 */
export async function runCompact(ctx: SessionPane): Promise<void> {
  if (compacting) return;
  compacting = true;
  clearInput(); // 命令消费：输入框清空，但不当普通消息发送
  ctx.draft = '';
  try {
    let id = sid(ctx);
    if (id === undefined) {
      const resolved = await resolveActiveSession();
      if (resolved === null) {
        flashStatus('压缩失败：未找到活跃会话', 'err', 8000);
        return;
      }
      id = resolved;
    }
    setStatus('压缩中…', 'busy');
    const r = await api.compactSession(id);
    if (r.compacted === false) {
      flashStatus(r.note || '历史不足，无需压缩', 'ok');
      return;
    }
    localCompactAt.set(id, Date.now());
    flashStatus(r.note || '历史已压缩', 'ok');
    await restoreSessionHistory(ctx); // 消息区 reload
  } catch (err) {
    flashStatus('压缩失败：' + msgOf(err), 'err', 8_000);
  } finally {
    compacting = false;
  }
}
