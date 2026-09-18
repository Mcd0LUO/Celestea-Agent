// ============================================================================
// ui/send.ts — W805：发送编排（从 chat.ts 拆出，让附件乐观路径有清晰落点）。
//   空闲 → 开新轮（带图片附件）；运行中 → 插话/排队（只支持文字，附件需等空闲）；
//   worker 会话（W866）→ 送入该 worker 的收件箱（同一句 POST /api/turn，后端按
//   `worker:<sid>` 路由到 send_message 那条投递）；
//   失败 → 带附件时**完整回滚**（气泡/输入框/待发附件），不带附件时保持原行为。
//   W869：文本文件附件（.md/.txt/…）在此读成正文并**注入消息文本**（不进 attachments
//   数组）；图片仍走内联 base64 的 attachments，两条路径互不影响。
// ============================================================================
import { api } from '../api';
import { S } from '../state';
import { addUserMessage, laneLabel, renderInfoBlock, renderInterjectNote } from './messages';
import {
  pendingCount,
  pendingViews,
  restorePending,
  takePending,
  toWire,
  type PendingAttachment,
} from './attachments';
import { refreshQuoteTray, restoreQuotes, takeQuotes } from './quote/tray'; // F1：引用待发区
import { serializeQuotes, type QuoteRef } from './quote/model';
import { settleTextItems, withTextAttachments } from './text-attach';
import {
  clearInput,
  refreshAttachmentTray,
  setBusy,
  setInputValue,
  type SubmitMode,
} from './inputbar';
import { runCompact } from './compact';
import { getLegacyOwner, setLegacyOwner } from './legacy-owner';
import { msgOf, sid } from './session-util';
import { note } from './sessiontree/live';
import { resetTurnStep } from './toolcards';
import { updateSessionBar } from './sessionbar';
import {
  flashStatus,
  setStatus,
  setStatusTurn,
  startElapsedTimer,
  stopElapsedTimer,
} from './statusbar';
import {
  activePane,
  adoptLocalIfUnbound,
  isActivePane,
  setPaneStreaming,
  type SessionPane,
} from './viewctx';

/** 发送入口：命令 → worker 专线 → 运行中（附件拒绝/插话/排队）→ 空闲开新轮。 */
export function dispatchSend(text: string, mode: SubmitMode = 'steer'): void {
  const t = text.trim();
  const ctx = activePane();
  if (!ctx) return;
  const pending = pendingCount();
  if (t === '' && pending === 0) return;
  if (t === '/compact') {
    void runCompact(ctx);
    return;
  }
  // W866：worker 会话是**可对话**的（不再是只读面板）。它有自己的串行收件箱，
  // 没有「本会话的 busy 槽」，所以这里不看 ctx.streaming：一律走 worker 专线。
  if (ctx.kind === 'worker') {
    void sendToWorker(ctx, t, mode);
    return;
  }
  if (ctx.streaming && pending > 0) {
    // 后端在运行中拒绝带附件的请求（插话只支持文字）—— 前端先拦，不制造必然 409。
    const hint = '本轮还没结束：附件需等本轮结束后发送（插话只支持文字）';
    flashStatus(hint, 'err', 6_000);
    note(hint);
    return;
  }
  ctx.draft = '';
  if (ctx.streaming) {
    void injectInput(ctx, t, mode);
    return;
  }
  startTurn(ctx, t);
}

/** 空闲路径：开新轮；用户气泡（文本 + 附件缩略图）当帧入场，请求在后台跑。 */
function startTurn(ctx: SessionPane, t: string): void {
  const key = ctx.id; // R3 W838-F3：发送时记住原会话 key，失败回滚按它归位
  const items = takePending(key);
  const quotes = takeQuotes(key);
  const views = pendingViews(items);
  const col = addUserMessage(ctx, t, { attachments: views, quotes });
  clearInput();
  refreshAttachmentTray();
  setLegacyOwner(ctx);
  setPaneStreaming(ctx, true);
  ctx.turn = null;
  ctx.t0 = Date.now();
  ctx.phase = '启动中…';
  resetTurnStep(ctx);
  if (isActivePane(ctx)) {
    S.t0 = ctx.t0;
    setBusy(true);
    setStatus('启动中…', 'busy');
    startElapsedTimer();
  }
  updateSessionBar();
  // W869：文本附件在发送前读成正文，**注入本条消息文本**（不进 attachments 数组）；
  // 文本读取失败走与读图失败同一条路（AttachmentReadError → failTurn 完整回滚）。
  void settleTextItems(items)
    .then(() => toWire(items))
    .then((wire) => api.turn(withTextAttachments(serializeQuotes(t, quotes), items), sid(ctx), undefined, wire))
    .then((r) => {
      if (r.session) adoptLocalIfUnbound(r.session);
      if (ctx.turn === null && r.turn !== undefined) ctx.turn = r.turn;
      ctx.phase = '运行中…';
      if (isActivePane(ctx)) {
        setStatusTurn(ctx.turn !== null ? ctx.turn : (r.turn ?? 0));
        setStatus('运行中…', 'busy');
      }
    })
    .catch((err: unknown) => failTurn({ ctx, key, col, text: t, items, quotes, err }));
}

/**
 * W866：用户 → worker 的发言（乐观优先）。
 *
 * 与「运行中插话」同一节拍：气泡 + 一句「已送达/未送达」注记当帧入场，请求在
 * 后台跑，失败时**撤销气泡并把文本放回输入框** —— 绝不留下一个看起来发出去了、
 * 实际谁也没收到的气泡。附件在 worker 车道上先被拦下（收件箱只收文本）。
 */
async function sendToWorker(ctx: SessionPane, t: string, mode: SubmitMode): Promise<void> {
  if (t === '') return;
  if (pendingCount() > 0) {
    const hint = 'worker 会话不收图片附件（收件箱只收文字）';
    if (isActivePane(ctx)) flashStatus(hint, 'err', 6_000);
    renderInfoBlock(ctx, hint, 'warn');
    return;
  }
  const quotes = takeQuotes(ctx.id);
  const col = addUserMessage(ctx, t, { kind: mode === 'queue' ? 'queued' : 'user', quotes });
  clearInput();
  ctx.draft = '';
  const noteEl = renderInterjectNote(ctx, '发送中 · 等待送达…', undefined, col);
  setLegacyOwner(ctx);
  try {
    const r = await api.turn(serializeQuotes(t, quotes), sid(ctx));
    const settled = r.status !== undefined && r.status !== '' && r.status !== 'RUNNING';
    noteEl.textContent =
      settled
        ? '已送达 · 该 worker 已结束（' + r.status + '），消息留在它的收件箱里'
        : '已送达 · 将作为它的一轮对话处理';
    noteEl.className = 'interject-note ok';
    if (isActivePane(ctx)) flashStatus(settled ? '已送达（该 worker 已结束）' : '已送达 worker', 'ok', 4_000);
  } catch (err: unknown) {
    col.remove();
    noteEl.parentElement?.remove();
    ctx.interjectNote = null;
    if (quotes.length > 0) restoreQuotes(ctx.id, quotes);
    restoreDraft(ctx, t);
    const hint = '未送达（' + msgOf(err) + '）：已将内容还原到输入框';
    if (isActivePane(ctx)) {
      setStatus(hint, 'err');
      window.setTimeout(() => flashStatus(hint, 'err', 6_000), 0);
    }
    renderInfoBlock(ctx, hint, 'warn');
  }
}

/** 发送失败：带附件时完整回滚（不保留「看起来发出去了」的假气泡）。 */
function failTurn(o: {
  ctx: SessionPane;
  key: string;
  col: HTMLElement;
  text: string;
  items: PendingAttachment[];
  quotes: readonly QuoteRef[];
  err: unknown;
}): void {
  const { ctx, key, col, text, items, quotes, err } = o;
  setPaneStreaming(ctx, false);
  ctx.phase = '发送失败';
  if (getLegacyOwner() === ctx) setLegacyOwner(null);
  const rolled = items.length > 0 || quotes.length > 0;
  if (rolled) {
    col.remove();
    if (items.length > 0) restorePending(key, items); // R3 W838-F3：放回**原会话**
    if (quotes.length > 0) restoreQuotes(key, quotes);
    restoreDraft(ctx, text);
    refreshAttachmentTray();
    refreshQuoteTray();
  }
  const hint = '发送失败：' + msgOf(err) + (rolled ? '；待发内容已放回，可重试' : '');
  if (isActivePane(ctx)) {
    setBusy(false);
    stopElapsedTimer();
    setStatus(hint, 'err');
    window.setTimeout(() => flashStatus(hint, 'err', 6_000), 0);
  }
  renderInfoBlock(ctx, hint, rolled ? 'warn' : 'err');
  if (rolled) note(hint);
  updateSessionBar();
}

/**
 * 运行中提交（W514 插话 + W515 两车道）：成功就地改写提示；两条车道都失败则
 * 撤销乐观渲染并把文本还原输入框 —— 不丢字。
 */
async function injectInput(ctx: SessionPane, t: string, mode: SubmitMode): Promise<void> {
  const quotes = takeQuotes(ctx.id);
  const wire = serializeQuotes(t, quotes);
  const col = addUserMessage(ctx, t, { kind: mode === 'queue' ? 'queued' : 'steering', quotes });
  clearInput();
  refreshAttachmentTray();
  ctx.draft = '';
  const waitText = mode === 'queue' ? '已排队 · 等待本轮结束…' : '已插话 · 等待送达…';
  const doneText = mode === 'queue' ? '已排队 · 本轮结束后送达' : '已插话 · 将在下一步送达';
  const noteEl = renderInterjectNote(ctx, waitText, undefined, col);
  setLegacyOwner(ctx);
  if (isActivePane(ctx)) {
    flashStatus(mode === 'queue' ? '已排队，将在本轮结束后送达' : '已插话，将在下一步送达', 'busy', 4_000);
  }
  const ok = (text: string): void => {
    noteEl.textContent = text;
    noteEl.className = 'interject-note ok';
  };
  try {
    const r = await api.turn(wire, sid(ctx), mode);
    // W847：终态以响应里的权威落点 placement 为准，而不是 injected。旧后端在
    // 运行中收到 mode='queue' 仍会回 injected:true —— 先看 injected 会把「已排队」
    // 覆盖成「已插话」。缺 placement 的旧服务走下面的兜底分支，一字不放宽。
    if (r.placement === 'queued') {
      ok(doneText);
      return;
    }
    if (r.placement === 'steering') {
      ok('已插话 · 将在下一步送达');
      return;
    }
    if (r.placement === undefined) {
      if (r.injected === true) {
        ok('已插话 · 将在下一步送达');
        return;
      }
      if (r.queued === true || mode === 'queue') {
        ok(doneText);
        return;
      }
    }
    // placement === 'context'（或旧服务的新轮路径）：本次输入就是新一轮。
    ctx.turn = r.turn ?? ctx.turn;
    setPaneStreaming(ctx, true);
    ctx.phase = '运行中…';
    ok('已作为新一轮发送');
    updateSessionBar();
  } catch (err: unknown) {
    if (mode === 'queue') {
      try {
        const r2 = await api.turn(wire, sid(ctx), 'steer');
        if (r2.injected !== false) {
          const lane = laneLabel(r2.inbox_target ?? 'next-step');
          ok('当前版本不支持排队 → 已按插话送达' + (lane ? '（' + lane + '）' : ''));
          return;
        }
      } catch {
        /* 两条车道都不可用：走统一失败路径 */
      }
    }
    col.remove();
    noteEl.parentElement?.remove();
    ctx.interjectNote = null;
    if (quotes.length > 0) restoreQuotes(ctx.id, quotes);
    restoreDraft(ctx, t);
    const hint = (mode === 'queue' ? '排队未送达（' : '插话未送达（') + msgOf(err) + '）：已将内容还原到输入框';
    if (isActivePane(ctx)) {
      setStatus(hint, 'err');
      window.setTimeout(() => flashStatus(hint, 'err', 6_000), 0);
    }
    renderInfoBlock(ctx, hint, 'warn');
  }
}

/** 插话失败时把文本还原回输入框（仅当用户没在输入框里新打字）。 */
function restoreDraft(ctx: SessionPane, text: string): void {
  ctx.draft = text;
  if (!isActivePane(ctx)) return;
  const input = document.querySelector<HTMLTextAreaElement>('#input');
  if (input && input.value.trim() === '') setInputValue(text);
}
