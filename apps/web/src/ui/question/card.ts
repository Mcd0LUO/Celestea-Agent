// ============================================================================
// ui/question/card.ts — W784 提问卡片的**本体**：DOM 骨架 + 状态机 + 倒计时 +
//   提交请求 + 同一容器内的去重登记。
//
//   三条路径共用同一张卡片构造：
//     ① live：SSE `question` 事件（模型刚问出口）；
//     ② 恢复：GET /api/questions?session= 重建未决卡片（刷新/重连/切会话后）；
//     ③ 终态：历史里「有调用无结果」的提问（进程重启后不可再答，§7.2 规则 4）。
//
//   答案走 `POST /api/questions/{id}/answer` **直接唤醒挂起的工具调用**，不经
//   /api/turn（§4.2：挂起期间 turn 单槽被占，消息只会变成永远送不到的插话）。
//
//   纪律：只往会话容器**追加**卡片、只就地改自己这几个节点；不碰消息区其余 DOM、
//   不整树重建（FRONTEND-RULES 铁律 1/6）。判定逻辑全在 ./format 的纯函数里。
// ============================================================================
import { ApiError, api, userErrorText } from '../../api';
import { el, fmtNow } from '../../utils/dom';
import type { QuestionItem } from '../../types';
import { allPanes, LOCAL_ID, onBusyChange, paneOf, type SessionPane } from '../viewctx';
import { autoscroll, hideEmptyHint } from '../messages/scroll';
import { buildQuestionBlock, type PickHost } from './controls';
import {
  answerItemsOf,
  countdownText,
  deadlineOf,
  isExpired,
  isSettledFailure,
  questionInfoOf,
  remainingMsOf,
  summarizeAnswer,
  unansweredIds,
  type HistoryQuestion,
} from './format';

/**
 * 卡片状态：pending 可作答 → done/expired/closed 终态。
 *
 * W795：去掉了中间的 `sending` 态 —— 提交改成**乐观**（点下去当帧就画 `done` 终态，
 * 请求后台跑，失败回滚到 pending 并说明原因），因此不再存在「提交中…」这种过渡态。
 */
export type QuestionCardState = 'pending' | 'done' | 'expired' | 'closed';

const STATE_TEXT: Record<string, string> = {
  done: '已作答',
  expired: '已到时限 · 未作答（模型已按超时继续）',
  closed: '该提问已结束，无需再作答（时限已到或已在别处作答）',
};

/** 卡片可用的时序/问题信息（SSE 载荷与恢复列表条目同源）。 */
export interface CardInfo {
  id: string;
  questions: QuestionItem[];
  expires_at?: number;
  timeout_ms?: number;
  remaining_ms?: number;
}

/** 一张提问卡片的 DOM 句柄 + 本地作答草稿。 */
interface CardHandle extends PickHost {
  id: string;
  paneId: string;
  root: HTMLElement;
  card: HTMLElement;
  timer: HTMLElement;
  hint: HTMLElement;
  result: HTMLElement;
  submit: HTMLButtonElement;
  questions: QuestionItem[];
  deadline: number | null;
  state: QuestionCardState;
  /** 已知**权威**结算（作答成功 / 已被别处结算 / 历史里有回答行）：终态不再解除。 */
  settled: boolean;
}

// ---- 登记表（供去重与倒计时；WeakMap 不阻止容器被回收） ---------------------------

/** 容器 → (提问 id → 卡片)：同一容器里同一提问只允许一张卡片。 */
const registries = new WeakMap<HTMLElement, Map<string, CardHandle>>();
/** 全部存活卡片（WeakMap 不可遍历，倒计时需要一个可遍历的集合）。 */
const live = new Set<CardHandle>();
let ticker: number | null = null;

// dropPane 会 emitBusy(id, false)；注册表里已无此 pane = 容器已注销 → 同步回收卡片引用。
onBusyChange((id, busy) => {
  if (!busy && paneOf(id) === undefined) releasePaneId(id);
});

function registryOf(ctx: SessionPane): Map<string, CardHandle> {
  let map = registries.get(ctx.el);
  if (!map) {
    map = new Map();
    registries.set(ctx.el, map);
  }
  return map;
}

/**
 * 仍属于该容器的卡片：挂载中（isConnected）或正被离屏构建（parentElement 尚在）。
 * 两者皆无 = 节点已被消息区重载丢弃 → 条目作废（否则会以为卡片还在而不再渲染）。
 */
function stillThere(h: CardHandle): boolean {
  if (h.root.isConnected) return true;
  // 离屏构建：父容器仍被 viewctx 持有才算存活（容器 drop/淘汰后 pane 已注销 → 作废，
  // 否则 live 强引用与 ticker 永不回收）。
  return h.root.parentElement !== null && paneOf(h.paneId)?.el === h.root.parentElement;
}

function releasePaneId(paneId: string): void { // 容器被 drop → 同步回收卡片引用并停表（R3 W838-F5）
  for (const h of Array.from(live)) if (h.paneId === paneId) live.delete(h);
  stopTickerIfIdle();
}
function stopTickerIfIdle(): void {
  if (live.size === 0 && ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function liveCard(ctx: SessionPane, id: string): CardHandle | null {
  const map = registryOf(ctx);
  const found = map.get(id);
  if (!found) return null;
  if (stillThere(found)) return found;
  map.delete(id);
  live.delete(found);
  return null;
}

// ---- 倒计时（单一共享 1s 心跳；无卡片时自动停表，不留定时器） -----------------------

function tickAll(): void {
  const now = Date.now();
  for (const h of Array.from(live)) {
    if (!stillThere(h)) {
      live.delete(h);
      continue;
    }
    if (h.state === 'pending') paintTimer(h, now);
  }
  stopTickerIfIdle();
}

/** 画一次倒计时；本地钟到点即转「已到时限」终态（绝不发出必然失败的作答）。 */
function paintTimer(h: CardHandle, now: number): void {
  if (h.deadline === null) {
    h.timer.textContent = '';
    return;
  }
  const remaining = h.deadline - now;
  h.timer.textContent = countdownText(remaining);
  if (isExpired(remaining) && h.state === 'pending') setState(h, 'expired');
}

// ---- 状态机 --------------------------------------------------------------------

/** 唯一的终态/可交互态写入口：状态属性 + 控件可用性 + 文案三处同写。 */
function setState(h: CardHandle, state: QuestionCardState, resultText?: string): void {
  h.state = state;
  if (state === 'done' || state === 'closed') h.settled = true;
  h.card.dataset.state = state;
  const terminal = state !== 'pending';
  for (const c of h.controls) c.disabled = terminal;
  h.submit.disabled = terminal;
  h.submit.textContent = '提交作答';
  h.timer.textContent = terminal ? '' : h.timer.textContent;
  h.result.textContent = terminal ? (resultText ?? STATE_TEXT[state] ?? '') : '';
}

/** 点提交：未答完就地提示（不预先骂人），到点则转终态而不是送一个必然失败的请求。 */
function submitOrRefuse(ctx: SessionPane, h: CardHandle): void {
  if (h.state !== 'pending') return;
  if (h.deadline !== null && Date.now() >= h.deadline) {
    setState(h, 'expired');
    return;
  }
  const missing = unansweredIds(h.questions, h.picks);
  if (missing.length > 0) {
    h.hint.textContent = '还有 ' + missing.length + ' 个问题没作答：每题选一项，或自己填一句';
    return;
  }
  void submit(ctx, h);
}

/**
 * 提交作答（W795 乐观）：
 *   点下去**同一帧**就画「已作答 + 选了什么」这个终态（控件同时禁用 = 防重复提交），
 *   请求在后台发；失败则**回滚**到可作答态并说明原因（绝不假装成功、绝不静默）。
 */
async function submit(ctx: SessionPane, h: CardHandle): Promise<void> {
  const items = answerItemsOf(h.questions, h.picks);
  const sid = ctx.id === LOCAL_ID ? undefined : ctx.id;
  setState(h, 'done', '已作答：' + summarizeAnswer(items));
  h.hint.textContent = '';
  try {
    await api.answerQuestion(h.id, items, sid);
  } catch (err) {
    // 404/409 = 该提问已结算（时限先到，或已在别处作答）：再点也不会成功 → 终态。
    if (err instanceof ApiError && isSettledFailure(err.status)) {
      setState(h, 'closed');
      h.hint.textContent = '';
      return;
    }
    // 回滚：控件重新可用（settled 也必须清掉 —— 那是「权威结算」的标记）
    h.settled = false;
    setState(h, 'pending');
    h.hint.textContent = '提交失败：' + userErrorText(err) + '（可重试）';
    paintTimer(h, Date.now());
  }
}

// ---- 卡片构建 ------------------------------------------------------------------

function buildHead(h: CardHandle, questions: QuestionItem[]): HTMLElement {
  const head = el('div', 'q-head');
  const title = el('div', 'q-title');
  const header = questions[0]?.header;
  title.textContent = header !== undefined && header !== '' ? header : '需要你的决定';
  // intent 只改呈现（§3.3）：加一枚类型标记，协议与答案编码完全不变。
  const intent = questions[0]?.intent?.kind;
  if (intent !== undefined && intent !== '') {
    title.appendChild(el('span', 'q-intent', intent === 'plan-review' ? '方案评审' : intent));
  }
  head.appendChild(title);
  head.appendChild(h.timer);
  return head;
}

/** 构建一张卡片（三条路径共用；不挂载、不发请求）。 */
function buildCard(ctx: SessionPane, info: CardInfo): CardHandle {
  const root = el('div', 'mcol q-col');
  const msg = el('div', 'msg question');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '提问'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble question-bubble');
  const card = el('div', 'q-card');
  card.dataset.state = 'pending';
  const submitBtn = el('button', 'q-submit btn btn-accent', '提交作答') as HTMLButtonElement;
  submitBtn.type = 'button';
  const h: CardHandle = {
    id: info.id,
    paneId: ctx.id,
    root,
    card,
    timer: el('div', 'q-timer'),
    hint: el('div', 'q-hint'),
    result: el('div', 'q-result'),
    submit: submitBtn,
    controls: [],
    questions: info.questions,
    picks: {},
    deadline: null,
    state: 'pending',
    settled: false,
    onEdit: () => {
      h.hint.textContent = '';
    },
  };
  card.appendChild(buildHead(h, info.questions));
  const items = el('div', 'q-items');
  for (const q of info.questions) items.appendChild(buildQuestionBlock(h, q));
  card.appendChild(items);
  const actions = el('div', 'q-actions');
  actions.appendChild(h.submit);
  card.appendChild(actions);
  card.appendChild(h.hint);
  card.appendChild(h.result);
  // 监听器在**构建期**挂（不是在挂载期）：历史卡片被恢复路径放回可作答时也必须有它。
  h.submit.addEventListener('click', () => submitOrRefuse(ctx, h));
  bubble.appendChild(card);
  msg.appendChild(bubble);
  root.appendChild(msg);
  return h;
}

/** 挂载一张卡片并登记（唯一挂载点）。 */
function mount(ctx: SessionPane, h: CardHandle): CardHandle {
  hideEmptyHint(ctx);
  ctx.el.appendChild(h.root);
  registryOf(ctx).set(h.id, h);
  live.add(h);
  if (ticker === null) ticker = window.setInterval(tickAll, 1000);
  return h;
}

/**
 * 刷新一张卡片的时序（并在必要时解除误判的终态）。恢复路径的 `remaining_ms` 由服务端
 * 读时重算 —— 若卡片此前被判成「已到时限」（本地钟偏差），而服务端说它仍可作答，就
 * 放回可作答态，免得用户面对一张永远点不动的卡片。
 */
function refreshCard(h: CardHandle, info: CardInfo): CardHandle {
  if (info.questions.length > 0) h.questions = info.questions;
  h.deadline = deadlineOf(info, Date.now());
  const stillOpen = !isExpired(remainingMsOf(info, Date.now()));
  if (h.state === 'expired' && !h.settled && stillOpen) setState(h, 'pending');
  if (h.state === 'pending') {
    h.hint.textContent = '';
    paintTimer(h, Date.now());
  }
  return h;
}

/** 线格式 → 卡片信息（问题集为空一律不成卡；时序字段缺席即不写）。 */
function cardInfoOf(raw: unknown): CardInfo | null {
  const info = questionInfoOf(raw);
  const questions = info?.questions;
  if (!info || questions === undefined || questions.length === 0) return null;
  const out: CardInfo = { id: info.id, questions };
  if (info.expires_at !== undefined) out.expires_at = info.expires_at;
  if (info.timeout_ms !== undefined) out.timeout_ms = info.timeout_ms;
  if (info.remaining_ms !== undefined) out.remaining_ms = info.remaining_ms;
  return out;
}

// ---- 对外三条路径 --------------------------------------------------------------

/** ① live：SSE `question` 事件 → 渲染（或刷新已存在的同 id 卡片）。 */
export function renderQuestionCard(ctx: SessionPane, raw: unknown): CardHandle | null {
  const info = cardInfoOf(raw);
  if (!info) return null;
  const existing = liveCard(ctx, info.id);
  if (existing) return refreshCard(existing, info);
  const h = refreshCard(buildCard(ctx, info), info);
  mount(ctx, h);
  autoscroll(ctx, true);
  return h;
}

/**
 * ② 恢复：GET /api/questions?session= 重建未决卡片（刷新 / 重连 / 切会话后）。
 * 无未决 → 原地不动（不干扰现有 UI）；请求失败 → 静默保持现状（旧服务无此能力）。
 */
export async function recoverQuestions(ctx: SessionPane): Promise<void> {
  // 容器还没认领到真实会话（LOCAL）时**不查**：不带 session 的查询是整表，
  // 把别的会话的未决提问画进这个容器是错的。认领后由 restoreActiveHistory 再触发。
  if (ctx.id === LOCAL_ID) return;
  const sid = ctx.id;
  let resp;
  try {
    resp = await api.questions(sid);
  } catch {
    return; // 未提供该能力或暂时不可达：不打扰用户，也不清掉已有卡片
  }
  let added = 0;
  for (const item of resp.questions ?? []) {
    const info = cardInfoOf(item);
    if (!info) continue;
    const existing = liveCard(ctx, info.id);
    if (existing) {
      refreshCard(existing, info);
      continue;
    }
    mount(ctx, refreshCard(buildCard(ctx, info), info));
    added += 1;
  }
  if (added > 0) autoscroll(ctx, true);
}

/**
 * ③ 历史转录里的提问（§7.2）：有问无答 = 提问被中断（进程重启后未决表消失，该提问
 * **不可再答**）→ 终态卡片；有答 = 回显当时选了什么。
 *
 * 未结算的那张**照常登记**并从服务端复核：若未决列表说它仍可作答（例如只是页面刷新，
 * 进程没重启），refreshCard 会把它放回可作答态 —— 「重启后不可答」与「刷新后仍可答」
 * 因此由**服务端事实**区分，而不是靠前端猜。
 */
export function renderHistoryQuestionCard(
  ctx: SessionPane,
  row: HistoryQuestion,
  into?: HTMLElement,
): HTMLElement {
  const h = buildCard(ctx, { id: row.id, questions: row.questions });
  if (into) {
    into.appendChild(h.root);
    registryOf(ctx).set(h.id, h); // 登记以便恢复路径复用同一张卡（不进倒计时集合）
  } else {
    mount(ctx, h);
  }
  if (row.settled && !row.timedOut) {
    setState(h, 'done', '已作答：' + row.answerText);
  } else if (row.settled) {
    h.settled = true; // 超时结算：权威终态，恢复路径不得解除
    setState(h, 'expired');
  } else {
    // 有问无答（会话中断）：既没有答案，也不再有可作答的未决项。
    setState(h, 'expired', '未作答 · 该提问已无法再作答（会话曾中断）');
  }
  return h.root;
}

/** 重连后重建**所有**已知会话的未决卡片（无未决者原地不动）。 */
export function recoverAllQuestions(): void {
  for (const pane of allPanes()) void recoverQuestions(pane);
}

/** 仅供测试/诊断：当前存活卡片数。 */
export function liveCardCount(): number {
  return live.size;
}
