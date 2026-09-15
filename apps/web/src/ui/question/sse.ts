// ============================================================================
// ui/question/sse.ts — W784 提问的 **SSE 接线**（帧 → 卡片；重连 → 未决列表补齐）。
//
// 为什么单独一个文件：chat.ts 是**登记在案**的超大文件（棘轮只许降不许升），
// 本特性的代码不该长在它身上 —— chat.ts 只留 `registerQuestionSse(sse, ctxFor)`
// 一行。把「接线」与「卡片」分开也让 ui/question/card.ts 离 400 行上限远一点。
// ============================================================================
import type { SseClient } from '../../sse';
import type { SessionPane } from '../viewctx';
import { recoverAllQuestions, renderQuestionCard } from './card';

/**
 * ④ 接线：把「提问帧 → 卡片」与「重连补齐未决卡片」挂到 SSE 客户端上。
 * chat.ts 因此只留一行调用 —— 它是**登记在案**的超大文件（棘轮只许降不许升），
 * 本特性的代码不该长在它身上。
 */
export function registerQuestionSse(
  sse: SseClient,
  route: (p: { session?: string | null }) => SessionPane,
): void {
  sse.on('question', (p) => {
    try {
      renderQuestionCard(route(p), p);
    } catch (err) {
      console.warn('SSE question', err);
    }
  });
  // 重连：提问可能发生在断线期间（`question` 帧已错过）→ 用未决列表重建；
  // 无未决者原地不动，不干扰现有 UI。
  sse.onConn((state) => {
    if (state === 'online') recoverAllQuestions();
  });
}
