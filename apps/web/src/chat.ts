// ============================================================================
// chat.ts — turn 生命周期 + SSE 接线（编排层，W514 多会话版）：
//   收到 SSE 事件 → 按 session 路由到对应「会话视图容器」→ 更新该容器
//   （流/思考/工具卡）与（仅当它是当前聚焦容器时）statusline / 状态栏 / 输入栏。
//   发送编排已拆到 ui/send.ts；旧后端（无 session）全部回落单会话行为（legacyOwner，见 ui/legacy-owner）。
// ============================================================================
import { api } from './api';
import { SseClient } from './sse';
import { pickStatusFields, statusline } from './statusline';
import type {
  DonePayload,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from './types';
import { S } from './state';
import {
  appendText,
  appendThinking,
  applyFinalText,
  assistantHasContent,
  autoscroll,
  endTurn,
  ensureAssistant,
  finalizeAssistant,
  flushTextSegment,
  flushThinkSegment,
  removeAssistant,
  renderInboxMessage,
  renderInfoBlock,
} from './ui/messages';
import { applyToolResult, pushToolCard, resetTurnStep } from './ui/toolcards';
// W784：模型向用户提问（提问卡片 + 断线重连的未决列表重建）接线
import { registerQuestionSse } from './ui/question';
import { onCompact } from './ui/compact';
import { msgOf, sid } from './ui/session-util';
import {
  initInputBar,
  refreshAttachmentEntry,
  refreshAttachmentTray,
  setBusy,
  setInputMode,
} from './ui/inputbar';
import { dispatchSend } from './ui/send';
import { getLegacyOwner, setLegacyOwner } from './ui/legacy-owner';
import { isImageDowngrade } from './ui/attachments';
import { renderImageDowngrade } from './ui/downgrade';
import { feedAssistantDelta, finalAssistantDedup } from './ui/restore';
import {
  cancelStatusFlash,
  finishElapsedTimer,
  setStatus,
  setStatusTurn,
  startElapsedTimer,
  stopElapsedTimer,
} from './ui/statusbar';
import {
  activePane,
  adoptLocalIfUnbound,
  ensurePane,
  isActivePane,
  LOCAL_ID,
  onBusyChange,
  onPaneChange,
  paneOf,
  setPaneStreaming,
  type SessionPane,
} from './ui/viewctx';
import { railActivate, railRebind } from './ui/rail';
import { updateSessionBar } from './ui/sessionbar';
import { updateWorkerStrip } from './ui/worker-strip'; // W866：本会话 worker 快捷条
import { createFrameBudget } from './ui/messages/frame-budget'; // W9113（P0-1）：帧内预算
import { t } from './i18n';

/**
 * 契约里的**全部**终态 phase（contracts/sse-events.json:167）。
 * W9201：旧代码手写 `completed || cancelled || error`，于是 step_limit / interrupted
 * 到达时不调 finalizeTurn ⇒ 会话永久卡「运行中」。提成常量是因为它同时是**门禁的
 * 可断言面**（测试直接读它，不复刻字面量清单）。契约 JSON 不进前端产物，对拍在测试里。
 */
export const TERMINAL_PHASES: readonly string[] = ['completed', 'cancelled', 'error', 'step_limit', 'interrupted'];

/** 该 phase 是否是轮次终态（非终态：start / progress / lagged / fallback）。 */
export function isTerminalPhase(phase: unknown): boolean {
  return typeof phase === 'string' && TERMINAL_PHASES.includes(phase);
}

/** 终态标签（函数：语言切换后必须跟着变；A1：completed 与「空闲」等价，不再产生文案）。 */
function phaseLabels(): Record<string, string> {
  return { cancelled: t('chat.phase.cancelled'), error: t('chat.phase.error') };
}

// ---- 会话路由 ------------------------------------------------------------------

function ctxFor(p: { session?: string | null }): SessionPane {
  const id = typeof p.session === 'string' && p.session !== '' ? p.session : null;
  if (id === null) return getLegacyOwner() ?? activePane() ?? ensurePane(LOCAL_ID);
  const adopted = adoptLocalIfUnbound(id);
  if (adopted) return adopted;
  return paneOf(id) ?? ensurePane(id);
}

/** 后台容器的状态快照（不渲染，只缓存供切回时立即显示）。 */
function mergePaneStatus(ctx: SessionPane, p: StatusPayload): void {
  const flat = pickStatusFields({ ...(p.statusline ?? {}), ...p });
  if (Object.keys(flat).length > 0) ctx.status = { ...(ctx.status ?? {}), ...flat };
}

// ---- 聚焦容器 chrome 同步（statusline / 状态栏 / 输入栏 / 会话条） ------------------

/**
 * 输入栏模式真源（W514）：聚焦容器是否运行中 / 是否 worker 会话（W866）。
 * 发送按钮**任何模式都不禁用**（运行中走插话，worker 走收件箱投递），只切文案与浅提示。
 */
function refreshInputMode(pane: SessionPane): void {
  setInputMode(pane.kind === 'worker' ? 'worker' : pane.streaming ? 'interject' : 'idle');
}

function syncChrome(pane: SessionPane): void {
  S.t0 = pane.t0;
  S.turn = pane.turn;
  S.assistant = pane.assistant;
  setStatusTurn(pane.turn);
  setBusy(pane.streaming);
  refreshInputMode(pane);
  statusline.setSession(pane.id);
  if (pane.streaming) {
    startElapsedTimer();
    setStatus(pane.phase || t('chat.phase.running'), 'busy');
  } else {
    stopElapsedTimer();
    if (pane.phase) {
      setStatus(pane.phase, pane.phase === phaseLabels()['error'] || pane.phase === phaseLabels()['cancelled'] ? 'err' : 'ok');
    } else if (S.conn === 'online') {
      setStatus(t('shell.status.online'), 'ok');
    } else if (S.conn === 'down') {
      setStatus(t('shell.status.reconnecting'), 'err');
    }
  }
  updateSessionBar();
}

// ---- turn lifecycle（每个容器一份） ----------------------------------------------

function finalizeTurn(ctx: SessionPane, phase: string): void {
  endTurn(ctx); // 思考段归属随轮次结束清除（跨轮不跨移）
  const wasStreaming = ctx.streaming;
  setPaneStreaming(ctx, false);
  ctx.turn = null;
  ctx.phase = phaseLabels()[phase] ?? ''; // A1：completed → ''（空闲态）
  const a = ctx.assistant;
  if (a) {
    if (assistantHasContent(a)) finalizeAssistant(ctx, a);
    else removeAssistant(ctx, a); // 空占位气泡（无正文/思考/工具内容）：不渲染空块
  }
  ctx.assistant = null;
  if (getLegacyOwner() === ctx) setLegacyOwner(null);
  if (isActivePane(ctx)) {
    S.turn = null;
    S.assistant = null;
    setBusy(false);
    finishElapsedTimer(); // W263：保留本轮最终耗时（下一轮 start 时重置）
    // A1：completed 无文案 → 回落空闲/在线（不再出现「完成」）
    if (ctx.phase !== '') setStatus(ctx.phase, phase === 'error' || phase === 'cancelled' ? 'err' : 'ok');
    else setStatus(S.conn === 'down' ? t('shell.status.reconnecting') : t('shell.status.online'), S.conn === 'down' ? 'err' : 'ok');
  }
  if (wasStreaming) autoscroll(ctx, true);
  updateSessionBar();
}

export function onStatus(ctx: SessionPane, p: StatusPayload): void { // export：A1 用例的测试缝
  // W805（设计 §7.6）：上游「图像不支持」降级帧的 phase 也是 'error'，但它不是
  // 轮次结束（envelope.turn=0，是进程级提示）—— 先拦下，只做可见提示。
  if (isImageDowngrade(p)) {
    renderImageDowngrade(ctx, p);
    return;
  }
  if (p.phase === 'start') {
    // 思考阶段绝不创建 assistant 气泡——只在首个 text delta 或工具卡需要时才创建
    if (isActivePane(ctx)) cancelStatusFlash();
    endTurn(ctx); // 新轮开始：思考段归属重置
    if (ctx.streaming && ctx.assistant) {
      if (assistantHasContent(ctx.assistant)) finalizeTurn(ctx, 'completed');
      else removeAssistant(ctx, ctx.assistant);
    }
    ctx.turn = p.turn ?? null;
    ctx.t0 = Date.now();
    ctx.phase = t('chat.phase.running');
    setPaneStreaming(ctx, true);
    resetTurnStep(ctx); // W263：新一轮工具步数清零
    if (isActivePane(ctx)) {
      S.t0 = ctx.t0;
      setBusy(true);
      setStatus(t('chat.phase.running'), 'busy');
      setStatusTurn(ctx.turn);
      startElapsedTimer();
    }
    updateSessionBar();
    return;
  }
  if (p.turn !== undefined && p.turn !== null && ctx.turn !== null && p.turn !== ctx.turn) {
    return;
  }
  // ★ W9201：终态**以契约为准**（5 个，见 TERMINAL_PHASES）。旧代码只认三个，于是
  //   step_limit（步数耗尽）与 interrupted（流被撕断）到达时不调 finalizeTurn ⇒
  //   ctx.streaming 永远 true、气泡永远 streaming、输入栏永远「插话」——只能刷新脱困。
  //   后端来源：TurnOutcome → real-runtime-adapter.ts:527 outcomePhaseOf 原样透传。
  //   文案：只有 cancelled/error 有词条，其余回落空串=空闲态（与 completed 同口径，A1）。
  if (isTerminalPhase(p.phase)) {
    finalizeTurn(ctx, p.phase || '');
    if (p.phase === 'error') {
      renderInfoBlock(ctx, t('chat.status.turnError', { reason: p.error || t('chat.status.unknownError') }), 'err');
    }
  }
  if (p.phase === 'lagged') {
    renderInfoBlock(ctx, t('chat.status.lagged'), 'warn');
  }
  if (p.hint) {
    renderInfoBlock(ctx, String(p.hint), 'warn');
  }
}

function onText(ctx: SessionPane, p: TextPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== ctx.turn) return;
  if (ctx.streaming === false) setPaneStreaming(ctx, true);
  // 衔接去重：SSE 重放的增量若与已恢复尾部同内容则吞掉
  const delta = feedAssistantDelta(ctx, p.delta || '');
  if (delta === null) return;
  const a = ensureAssistant(ctx);
  appendText(ctx, a, delta);
  if (isActivePane(ctx)) setStatusTurn(ctx.turn);
}

function onThinking(ctx: SessionPane, p: ThinkingPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && p.turn !== ctx.turn) return;
  appendThinking(ctx, p.delta || ''); // 弱化思考段：按事件顺序独立渲染
}

function onTool(ctx: SessionPane, p: ToolPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  // W847：一步结束（工具帧是 done 帧被总线丢弃时的兜底）→ 思考段先收尾，
  // 否则整轮的 reasoning 会累进同一个段，实时与刷新后的分段不一致。
  flushThinkSegment(ctx);
  // 连续流：文本段先收尾，工具卡按事件顺序排在文本段之后
  flushTextSegment(ctx);
  pushToolCard(ctx, p); // 消息流级条目：按事件时间内联在消息流中
  autoscroll(ctx);
}

function onToolResult(ctx: SessionPane, p: ToolResultPayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  applyToolResult(ctx, p); // W866：内部含 spawn_worker → 快捷条即时插入
  autoscroll(ctx);
}

function onDone(ctx: SessionPane, p: DonePayload): void {
  if (ctx.turn === null) ctx.turn = p.turn ?? null;
  if (p.turn !== undefined && ctx.turn !== null && p.turn !== ctx.turn) return;
  // W847：一步结束 → 思考段收尾。必须在下面 assistant 早退之前（无文本的 step
  // 没有 assistant，早退会让本步的思考段漏收尾、与落盘分段口径错位）。
  flushThinkSegment(ctx);
  if (ctx.assistant === null && typeof p.text === 'string' && p.text !== '') {
    // W847（P1）：done 携带本步的权威全文；若一步没有任何 text 帧（provider 只回
    // 完整文本、或流被掐断后只补 done），此时 ctx.assistant 为空。旧实现的
    // early return 会把这份唯一正文丢掉。这里补建气泡并走同一条 applyFinalText
    // 路径；去重语义（finalAssistantDedup）保持在前。
    if (finalAssistantDedup(ctx, p.text)) return;
    const fresh = ensureAssistant(ctx);
    applyFinalText(ctx, fresh, p.text);
    autoscroll(ctx);
    return;
  }
  const a = ctx.assistant;
  if (!a) return;
  if (finalAssistantDedup(ctx, p.text)) {
    // 整条为已恢复尾部的重放：移除重复气泡
    a.root.remove();
    ctx.assistant = null;
    return;
  }
  if (typeof p.text === 'string') applyFinalText(ctx, a, p.text);
  // done = 一轮模型输出结束；在 status completed/cancelled/error 之前可能还有工具轮次
  autoscroll(ctx);
}

// ---- SSE wiring ---------------------------------------------------------------

export function connectSse(): SseClient {
  const sse = new SseClient();
  // W9113（P0-1）：轮次帧的 UI 工作统一过一个**帧内预算**队列 —— 症状（一帧 584 个
  // 回调 / 7.9–9.4 秒冻结）、K 的取法、「为什么保序」「为什么在这一层接线」全部写在
  // ./ui/messages/frame-budget.ts 的模块头，这里只留接线与错误隔离。
  const budget = createFrameBudget();
  const paced = (label: string, run: () => void): void => {
    budget.push(() => {
      try {
        run();
      } catch (err) {
        console.warn(label, err);
      }
    });
  };
  sse.onConn((state) => {
    S.conn = state;
    if (state === 'online') {
      setStatus(S.streaming ? t('chat.phase.running') : t('shell.status.online'), S.streaming ? 'busy' : 'ok');
    } else if (state === 'down') {
      setStatus(t('shell.status.reconnecting'), 'err');
    }
  });
  // ★ W9201：status **也走 budget**。旧注释「前两者不碰消息容器」是错的：status 是唯一
  //   同时写「消息容器 + 状态栏 + 会话条」的事件（onStatus → finalizeTurn/renderInfoBlock；
  //   onStatusInbox → renderInboxMessage 追加一整条 .mcol）。后端 status 速率不低
  //   （adapter:388 / fallback-host:150），一次宏任务里同步 emit 一批就是 W9111 的形状。
  //   更关键是**全局保序**（frame-budget.ts:34-36）：status 直连时 `status:completed` 能插到
  //   已排队的 `tool_result` 之前落地（finalizeTurn 先跑、applyToolResult 后跑）。
  //   compact/question 仍不走：前者重载消息区（自带 await），后者是用户交互卡片。
  sse.on('status', (p) => {
    paced('SSE status', () => {
      const ctx = ctxFor(p);
      if (isActivePane(ctx)) {
        statusline.fromSse(p);
        if (p.session && ctx.status) ctx.status = { ...ctx.status, ...pickStatusFields(p) };
      } else {
        mergePaneStatus(ctx, p);
      }
      onStatus(ctx, p);
      // W1479: the injected-message lane rides ON the status frame (the backend
      // has always sent `placement` + `inbox` here). It used to have its own
      // `inbox` event, which the server can never emit, so live injection showed
      // up only after a refresh replayed the transcript.
      onStatusInbox(ctx, p);
    });
  });
  // ★ 下面五条**轮次帧**（text/thinking/tool/tool_result/done）与 status 走同一条
  //   budget（它们都会写 DOM）；compact/question 不走，理由见上面 status 那段注释。
  sse.on('text', (p) => {
    paced('SSE text', () => onText(ctxFor(p), p));
  });
  sse.on('thinking', (p) => {
    paced('SSE thinking', () => onThinking(ctxFor(p), p));
  });
  sse.on('tool', (p) => {
    paced('SSE tool', () => onTool(ctxFor(p), p));
  });
  sse.on('tool_result', (p) => {
    paced('SSE tool_result', () => onToolResult(ctxFor(p), p));
  });
  sse.on('done', (p) => {
    paced('SSE done', () => {
      statusline.onSseDone();
      onDone(ctxFor(p), p);
    });
  });
  sse.on('compact', (p) => {
    try {
      onCompact(p);
    } catch (err) {
      console.warn('SSE compact', err);
    }
  });
  // W784：提问帧 → 卡片；重连 → 用未决列表补齐（都在模块内，chat.ts 只留这一行）
  registerQuestionSse(sse, ctxFor);
  sse.connect();
  return sse;
}

// ---- cancel -------------------------------------------------------------------

/**
 * 取消当前聚焦容器的轮次（单一取消入口）：statusline 的 #slStop（W846 起输入栏不再有 #btnCancel）。
 * 失败只提示错误，本地状态交由 SSE 的 status:cancelled 收尾（finalizeTurn）。
 */
export function requestCancel(): void {
  const ctx = activePane();
  if (!ctx || !ctx.streaming) return;
  setStatus(t('chat.status.cancelling'), 'busy');
  void api.cancel(sid(ctx)).catch((err: unknown) => {
    setStatus(t('chat.status.cancelFailed', { reason: msgOf(err) }), 'err');
  });
}

/**
 * W1479：inbox 条目（Agent Inbox / worker 回执 / 系统注入）→ 转录里的独立条目。
 *
 * 数据在 `status` 帧上（后端 `session-publisher.ts` 一直在发 `placement` +
 * `inbox`），不再是独立的 `inbox` 事件——那个事件服务端**永远发不出来**（总线
 * 每次 emit 都断言契约清单），所以这条车道曾经只是「看起来接好了」。
 *
 * 只读展示，不与用户消息混同；没有正文 → 什么都不做（保持现状）。
 * `placement === 'context'` 才是「已进入模型可见历史」的那一刻，也正是在那时
 * 它同时出现在 transcript 里——所以这一帧是唯一一次「实时显示」的机会。
 */
function onStatusInbox(ctx: SessionPane, p: StatusPayload): void {
  if (p.placement !== 'context') return;
  const message = p.message;
  // Discriminate by SHAPE, not by `phase`: the downgrade frame's prose is a
  // string and this lane's payload is an object. (Typing it as a union is what
  // makes this check possible — it was `string`-only before, so the object was
  // unreachable and the lane rendered nothing.)
  if (typeof message !== 'object' || message === null) return;
  const text = (message.summary ?? '').trim();
  if (text === '') return;
  renderInboxMessage(ctx, text, { source: message.from, target: message.lane, kind: message.kind });
}

// ---- 装配 ----------------------------------------------------------------------

export function initChat(): void {
  initInputBar({
    // W515：mode = 提交车道（Enter=当前车道，Ctrl/Cmd+Enter=另一条）
    send(text, mode) {
      dispatchSend(text, mode);
    },
    // W302：取消回调改为模块级 requestCancel，与 #slStop 共用同一入口
    cancel: requestCancel,
  });

  // 会话切换：rail 换轨 + chrome（statusline/状态栏/输入栏/会话条/待发附件）同步。
  // 只做 class/文本/节点搬家 —— 背景视图零重渲染（铁律 5）。
  onPaneChange((pane) => {
    railActivate(pane);
    railRebind(pane);
    syncChrome(pane);
    refreshAttachmentTray();
    refreshAttachmentEntry();
    // W866：快捷条只属于「当前聚焦会话」——切会话只按已有列表重算归属（零请求）。
    updateWorkerStrip(null, pane);
  });

  // 任一会话运行态变化 → 会话条 + 侧栏运行态点（订阅方各自局部更新）；
  // 聚焦容器的运行态变化同时刷新输入栏模式（运行中 → 插话态，不再禁用发送）。
  onBusyChange((id) => {
    updateSessionBar();
    const pane = activePane();
    if (pane && (pane.id === id || (pane.id === LOCAL_ID && id === LOCAL_ID))) {
      refreshInputMode(pane);
      setBusy(pane.streaming);
    }
    // W866：worker 的运行态点由 paneBusy 驱动 —— 变了就重画快捷条（局部）。
    updateWorkerStrip(null, pane);
  });
}
