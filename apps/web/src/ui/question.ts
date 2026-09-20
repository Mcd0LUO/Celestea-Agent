// ============================================================================
// ui/question.ts — W784 提问卡片的**对外入口**（W784 起按职责拆到 ./question/*，
// 本文件只再导出公开 API，import 路径 `./ui/question` 保持稳定）。
//
//   ① live  ：SSE `question` 事件（模型调用 ask_user_question，挂起等待作答）
//   ② 恢复  ：GET /api/questions?session= 重建未决卡片（刷新 / 重连 / 切会话后）
//   ③ 终态  ：历史里「有调用无结果」的提问（进程重启后不可再答，§7.2 规则 4）
//
//   答案走 `POST /api/questions/{id}/answer` 直接唤醒挂起的工具调用，不经
//   /api/turn（docs/archive/decisions/feature-ask-user.md §4.2）。
//
//   拆分（照 ui/messages.ts + ui/messages/ 的先例，`src/**` 单文件默认 ≤400 行）：
//     ./question/format.ts    纯函数：倒计时 / 选项草稿 / 恢复终态判定（可直测）
//     ./question/controls.ts  控件层：题干 / 选项 / 自由输入
//     ./question/card.ts      本体：状态机 / 倒计时 / 提交 / 去重登记
//     ./question/sse.ts       接线：帧 → 卡片；重连 → 未决列表补齐
// ============================================================================
export {
  liveCardCount,
  recoverAllQuestions,
  recoverQuestions,
  renderHistoryQuestionCard,
  renderQuestionCard,
} from './question/card';
export { registerQuestionSse } from './question/sse';
export type { QuestionCardState } from './question/card';
