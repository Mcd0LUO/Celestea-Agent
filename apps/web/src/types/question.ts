// ============================================================================
// types/question.ts — W784「模型向用户提问」的线格式（契约：docs/feature-ask-user.md §3）。
//
// 为什么单独一个文件：提问的线格式有 SSE 载荷与两个 REST 响应两组，`src/types.ts`
// 已用满自己的模块体积上限（棘轮只许降不许升），按 `tools/check-module-size.mjs`
// 的规矩「超了就拆」放在这里，由 `src/types.ts` 原样再导出 —— 调用方看到的仍是
// 单一类型出口（`import type { QuestionPayload } from './types'`）。
//
// 三条语义约定（照 DSH，§3.2）：selected 存 **label 不存索引**；推荐项靠文案约定
// 「（推荐）」而非排序语义；detail 与选项标签分开、不参与 label 匹配。
// ============================================================================
import type { SseMeta } from '../types';

/** 一个选项：label 是答案里回传的稳定标识，description 只是一句权衡说明。 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** 决策类型标记：**只改变呈现方式，绝不改变答案编码**（§3.3）。 */
export interface QuestionIntent {
  kind: string;
  /** `plan-review` 的「批准」选项 label（必须命中某个选项的 label）。 */
  approve?: string;
  [key: string]: unknown;
}

/** 一个待作答的问题项（options 缺省 = 纯自由输入）。 */
export interface QuestionItem {
  id: string;
  question: string;
  /** 可选短标题。 */
  header?: string;
  /** 可选补充说明（与选项标签分开）。 */
  detail?: string;
  options?: QuestionOption[];
  /** 缺省 = 单选；多选时答案的 selected 可以有多项。 */
  multi_select?: boolean;
  intent?: QuestionIntent;
}

/**
 * SSE `question` 事件载荷：模型调用 ask_user_question 时发出，此刻该会话的 turn
 * 单槽是 busy 的（模型正挂起等待作答）。`turn` 由信封并入 = 挂起那个 turn 的
 * **会话本地序号**。
 */
export interface QuestionPayload extends SseMeta {
  id: string;
  questions: QuestionItem[];
  /** 绝对到期时刻；与 timeout_ms 一起构成 §6.1 的双轨超时。 */
  expires_at?: number;
  timeout_ms?: number;
}

/**
 * `GET /api/questions?session=` 的一条未决提问。
 * `remaining_ms` / `expired` 由服务端**读时判定**（每次请求重算）——恢复 UI 直接
 * 用它，因此长时间断连的标签页不会凭自己的钟复活一个已到期的提问。
 */
export interface PendingQuestionInfo {
  id: string;
  session?: string | null;
  questions?: QuestionItem[];
  expires_at?: number;
  timeout_ms?: number;
  /** 读时算出的剩余毫秒（< 0 表示已过期）。 */
  remaining_ms?: number;
  /** 读时判定：该提问已到期但尚未结算。 */
  expired?: boolean;
}

export interface QuestionsResp {
  ok?: boolean;
  questions?: PendingQuestionInfo[];
  error?: string;
}

/** 一条作答：selected 存选项 **label**；custom 是可选自由文本。 */
export interface QuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** `POST /api/questions/{id}/answer` 应答（timed_out:false = 真答案先到）。 */
export interface QuestionAnswerResp {
  ok?: boolean;
  id?: string;
  session?: string | null;
  timed_out?: boolean;
  error?: string;
}
