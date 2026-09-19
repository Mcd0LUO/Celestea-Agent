// ============================================================================
// ui/question/format.ts — W784 提问卡片的**纯函数**层（无 DOM、无 fetch）。
//
// 为什么单独一层：倒计时格式化、选项选择、恢复终态判定这类判断是「错了也不会
// 报错、只会静默给出错误 UI」的类型，必须能被机械断言。前端仓没有测试栈，故由
// 本仓 `tests/question-card.test.ts` 用 URL 形式的动态 import 直测（先例
// tests/model-icon.test.ts）。本文件因此**不许** import 任何 DOM 或 api 模块。
//
// 三条语义（见 docs/feature-ask-user.md §3）：selected 存 **label 不存索引**；
// detail 与选项标签分开；intent 只改呈现、不改协议。
// ============================================================================
import type {
  HistoryMsg,
  PendingQuestionInfo,
  QuestionAnswerItem,
  QuestionIntent,
  QuestionItem,
  QuestionOption,
} from '../../types';
import { t } from '../../i18n'; // i18n P1-c：文案走字典（非 DOM/api 模块）

/** 提问工具的稳定名字（历史里靠它把「无结果的调用」认成未答提问）。 */
export const ASK_TOOL_NAME = 'ask_user_question';

/** 一条提问的本地作答草稿（label 数组 + 自由文本）。 */
export interface QuestionPick {
  selected: string[];
  custom: string;
}

/** 问题 id → 草稿。 */
export type PickMap = Readonly<Record<string, QuestionPick>>;

const EMPTY_PICK: QuestionPick = { selected: [], custom: '' };

/** 取某题的草稿（缺省 = 未作任何选择）。 */
export function pickOf(picks: PickMap, questionId: string): QuestionPick {
  return picks[questionId] ?? EMPTY_PICK;
}

/** 切换一个选项：单选替换、多选增删（label 是身份，顺序无关）。 */
export function togglePick(pick: QuestionPick, label: string, multiSelect: boolean): QuestionPick {
  if (multiSelect) {
    const has = pick.selected.includes(label);
    const selected = has ? pick.selected.filter((l) => l !== label) : [...pick.selected, label];
    return { selected, custom: pick.custom };
  }
  return { selected: [label], custom: pick.custom };
}

/** 写自由文本（纯函数，不改原草稿）。 */
export function withCustom(pick: QuestionPick, custom: string): QuestionPick {
  return { selected: [...pick.selected], custom };
}

/**
 * 尚未作答的问题 id：**每题**都要有选项命中或非空自由文本才算答完。
 * 全有或全无 —— 半份答案交给模型只会让它再问一遍，不如在 UI 上挡住。
 */
export function unansweredIds(
  questions: readonly QuestionItem[],
  picks: PickMap,
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    const pick = pickOf(picks, q.id);
    if (pick.selected.length === 0 && pick.custom.trim() === '') out.push(q.id);
  }
  return out;
}

/**
 * 草稿 → 请求体里的 answers（§3.2 形状）。
 * 只送有内容的项：选项按用户点选顺序，自由文本 trim 后非空才带 `custom`。
 */
export function answerItemsOf(
  questions: readonly QuestionItem[],
  picks: PickMap,
): QuestionAnswerItem[] {
  const out: QuestionAnswerItem[] = [];
  for (const q of questions) {
    const pick = pickOf(picks, q.id);
    const custom = pick.custom.trim();
    if (pick.selected.length === 0 && custom === '') continue;
    const item: QuestionAnswerItem = { id: q.id, selected: [...pick.selected] };
    if (custom !== '') item.custom = custom;
    out.push(item);
  }
  return out;
}

/** 作答摘要（终态卡片上回显用户选了什么）。 */
export function summarizeAnswer(items: readonly QuestionAnswerItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const labels = [...item.selected];
    const custom = (item.custom ?? '').trim();
    if (custom !== '') labels.push(t('chat.question.customQuote', { text: custom }));
    if (labels.length > 0) parts.push(labels.join(t('chat.question.answerSep')));
  }
  return parts.join(t('chat.question.answerJoin'));
}

/** 剩余毫秒：优先用服务端**读时**算好的 remaining_ms，否则 expires_at - now。 */
export function remainingMsOf(
  src: { remaining_ms?: number; expires_at?: number },
  now: number,
): number | null {
  if (typeof src.remaining_ms === 'number' && Number.isFinite(src.remaining_ms)) {
    return src.remaining_ms;
  }
  if (typeof src.expires_at === 'number' && Number.isFinite(src.expires_at)) {
    return src.expires_at - now;
  }
  return null;
}

/**
 * 本地倒计时终点（时间戳）。取「现在 + 服务端给的剩余量」而不是直接用
 * expires_at：前端与服务端的钟可能差几分钟，直接用绝对时刻会把倒计时整体偏移。
 */
export function deadlineOf(
  src: { remaining_ms?: number; expires_at?: number },
  now: number,
): number | null {
  const remaining = remainingMsOf(src, now);
  return remaining === null ? null : now + remaining;
}

/** 倒计时文案（空串 = 该提问没带时限，卡片就不显示倒计时）。 */
export function countdownText(remainingMs: number | null): string {
  if (remainingMs === null) return '';
  if (remainingMs <= 0) return t('chat.question.timedOut');
  const total = Math.floor(remainingMs / 1000);
  if (total < 60) return t('chat.question.seconds', { n: total });
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return t('chat.question.clock', { m, s: (s < 10 ? '0' : '') + s });
  }
  return t('chat.question.hoursMinutes', { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) });
}

/** 是否已到时限（null = 无时限，永远不算到点）。 */
export function isExpired(remainingMs: number | null): boolean {
  return remainingMs !== null && remainingMs <= 0;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 一个选项（label 必须是非空字符串，否则丢弃 —— 不猜、不补占位）。 */
export function normalizeOption(raw: unknown): QuestionOption | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const label = asString(rec['label']);
  if (label === null || label === '') return null;
  const description = asString(rec['description']);
  return description === null ? { label } : { label, description };
}

function normalizeIntent(raw: unknown): QuestionIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const kind = asString(rec['kind']);
  return kind === null || kind === '' ? null : { ...rec, kind };
}

/** 一个问题项（id 与 question 都必须是非空字符串，否则丢弃）。 */
export function normalizeQuestion(raw: unknown): QuestionItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec['id']);
  const question = asString(rec['question']);
  if (id === null || id === '' || question === null || question === '') return null;
  const out: QuestionItem = { id, question };
  const header = asString(rec['header']);
  if (header !== null) out.header = header;
  const detail = asString(rec['detail']);
  if (detail !== null) out.detail = detail;
  const options = Array.isArray(rec['options'])
    ? rec['options'].map(normalizeOption).filter((o): o is QuestionOption => o !== null)
    : [];
  if (options.length > 0) out.options = options;
  if (rec['multi_select'] === true) out.multi_select = true;
  const intent = normalizeIntent(rec['intent']);
  if (intent !== null) out.intent = intent;
  return out;
}

/** 归一化一组问题（丢弃无法渲染的项，绝不抛）。 */
export function normalizeQuestions(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuestion).filter((q): q is QuestionItem => q !== null);
}

/**
 * SSE 载荷 / 恢复列表条目 → 卡片可用的信息（两者字段同源，只有 timing 字段多寡
 * 不同）。id 或问题集为空 → null（不发空卡片）。
 */
export function questionInfoOf(raw: unknown): PendingQuestionInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec['id']);
  if (id === null || id === '') return null;
  const questions = normalizeQuestions(rec['questions']);
  if (questions.length === 0) return null;
  const out: PendingQuestionInfo = { id, questions };
  const session = asString(rec['session']);
  if (session !== null) out.session = session;
  for (const key of ['expires_at', 'timeout_ms', 'remaining_ms'] as const) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  if (rec['expired'] === true) out.expired = true;
  return out;
}

/**
 * 作答失败是否已是**终态**：提问已结算/未知（404）或已被结算（409）—— 再点也不会
 * 成功，应当把卡片转成终态并说明，而不是让用户反复点一个必然失败的按钮。
 * 其余（0 网络、5xx、422）都是可重试的。
 */
export function isSettledFailure(status: number): boolean {
  return status === 404 || status === 409;
}

/** 提问行的载荷：线格式把它放在 `content`（问题/答案数组），而 HistoryMsg.content
 *  是**文本**口径（user/assistant 用）—— 两处口径不同，故在这一处收口，不扩散断言。 */
function payloadOf(m: HistoryMsg): unknown {
  return (m as { content?: unknown }).content;
}

/** 归一化答案项（selected 必须是字符串数组；label 身份，非索引）。 */
export function normalizeAnswerItems(raw: unknown): QuestionAnswerItem[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionAnswerItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = asString(rec['id']);
    const selected = rec['selected'];
    if (id === null || !Array.isArray(selected)) continue;
    const labels = selected.filter((v): v is string => typeof v === 'string');
    const custom = asString(rec['custom']);
    const answer: QuestionAnswerItem = { id, selected: labels };
    if (custom !== null && custom !== '') answer.custom = custom;
    out.push(answer);
  }
  return out;
}

/** 历史里的一条提问（带它的结算状态）。 */
export interface HistoryQuestion {
  id: string;
  questions: QuestionItem[];
  /** 提问行的绝对时限（旧行可能没有）。 */
  expiresAt?: number;
  /** 有配对的回答行 = 已结算。 */
  settled: boolean;
  /** 因时限到期而结算（§6.3：系统没有替模型选任何选项）。 */
  timedOut: boolean;
  /** 已结算时的作答摘要（超时为空串）。 */
  answerText: string;
}

/**
 * 历史转录里的提问（设计 §7.2）：`user_question` / `user_answer` 两行按 `question_id`
 * 配对 —— 有问无答 = 提问被中断（进程重启后未决表在内存里随之消失，该提问**不可再答**，
 * 必须渲染成已过期/未作答的终态，而不是给一个必然失败的可点按钮）。
 *
 * 口径说明：这两行**进入** Studio 转录投影（`GET /api/sessions/{id}/messages`，
 * 见 packages/session/src/messages.ts），但不进入模型消息投影（core/projection.ts
 * 显式 SKIP，避免给模型伪造它没见过的历史）—— 前端要的是前者，故此函数可用。
 */
export function historyQuestionsOf(
  messages: readonly HistoryMsg[],
): HistoryQuestion[] {
  const byId = new Map<string, HistoryQuestion>();
  const order: string[] = [];
  for (const m of messages) {
    if (m.role !== 'question') continue;
    const id = typeof m.question_id === 'string' ? m.question_id : '';
    if (id === '') continue;
    if (m.kind === 'question') {
      if (byId.has(id)) continue;
      const questions = normalizeQuestions(payloadOf(m));
      if (questions.length === 0) continue;
      const row: HistoryQuestion = { id, questions, settled: false, timedOut: false, answerText: '' };
      if (typeof m.question_expires_at === 'number') row.expiresAt = m.question_expires_at;
      byId.set(id, row);
      order.push(id);
      continue;
    }
    if (m.kind === 'answer') {
      const row = byId.get(id);
      if (row === undefined) continue;
      row.settled = true;
      row.timedOut = m.question_timed_out === true;
      row.answerText = row.timedOut ? '' : summarizeAnswer(normalizeAnswerItems(payloadOf(m)));
    }
  }
  return order.map((id) => byId.get(id) as HistoryQuestion);
}
