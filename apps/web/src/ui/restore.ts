// ============================================================================
// ui/restore.ts — 会话历史恢复（W514 多会话版）：
//   GET /api/sessions/{id}/messages → 用与 live 相同的渲染管线渲染最近
//   N=200 条存量（更早的加折叠提示）→ 尾部加「以下为本次会话」分隔线 →
//   之后的 SSE 增量照旧。衔接去重：SSE 重放的助手文本若与已恢复尾部同内容
//   （前缀匹配）则吞掉，直到发散；done 全量一致时丢弃重复气泡。
//   404/超时/端点缺失 → 保持空视图 + 轻提示，绝不崩溃。
//   W514：渲染目标 = 会话视图容器（SessionPane），去重状态每容器一份；
//         离屏双缓冲 + 单次替换（铁律 1）保持不变 → 切换/恢复无空白帧。
// ============================================================================
import { api } from '../api';
import { attachmentViewsOf } from './attachments';
import { el } from '../utils/dom';
import { t } from '../i18n';
import type { HistoryMsg } from '../types';
import {
  activatePane,
  activePane,
  adoptPane,
  ensurePane,
  type SessionPane,
} from './viewctx';
import {
  addUserMessage,
  autoscroll,
  buildThinkSeg,
  ensureAssistant,
  finalizeAssistant,
  renderEmptyHint,
  renderInboxMessage,
  type MsgKind,
} from './messages';
import { parseQuoteBlocks } from './quote/model'; // F1：历史回放解析引用块
import { railReset, railSync } from './rail';
import { buildToolCard, descFromArgs, mountToolCard, setToolResult, subCallIndex } from './toolcards';
// W784：转录里的提问行（§7.2）+ 未决列表重建（刷新 / 重连 / 切会话后）。
import { historyQuestionsOf, type HistoryQuestion } from './question/format';
import { recoverQuestions, renderHistoryQuestionCard } from './question';

const MAX_RESTORE = 200;

// ---- 衔接去重状态（每容器一份） ------------------------------------------------

/** 重置去重状态（清空会话后调用）。 */
export function resetRestore(ctx: SessionPane): void {
  ctx.dedup.tail = null;
  ctx.dedup.guardActive = false;
  ctx.dedup.guardBuf = '';
  ctx.dedup.guardAll = false;
}

/**
 * 处理一条 live 助手文本增量：若与已恢复尾部前缀匹配则吞掉（返回 null），
 * 发散后一次性吐出累积缓冲并解除守卫。
 */
export function feedAssistantDelta(ctx: SessionPane, delta: string): string | null {
  const d = ctx.dedup;
  if (d.tail?.role !== 'assistant') {
    d.tail = null;
    return delta === '' ? null : delta;
  }
  if (!d.guardActive) {
    d.guardActive = true;
    d.guardBuf = '';
    d.guardAll = false;
  }
  d.guardBuf += delta;
  const tc = d.tail.content ?? '';
  if (tc.startsWith(d.guardBuf)) {
    if (d.guardBuf === tc) d.guardAll = true;
    return null;
  }
  const out = d.guardBuf;
  d.guardActive = false;
  d.guardAll = false;
  d.tail = null;
  return out === '' ? null : out;
}

/**
 * done 事件钩子：若整条 live 助手消息是已恢复尾部的重放（无新增内容），
 * 返回 true 让调用方移除该重复气泡。
 */
export function finalAssistantDedup(ctx: SessionPane, text?: string): boolean {
  const d = ctx.dedup;
  if (!d.guardActive) return false;
  d.guardActive = false;
  const drop =
    d.guardAll ||
    (typeof text === 'string' && text !== '' && d.tail?.role === 'assistant' && text === (d.tail.content ?? ''));
  d.guardAll = false;
  d.tail = null;
  return drop;
}

// ---- 渲染 ---------------------------------------------------------------------

function toJsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function appendToolLine(text: string, container: HTMLElement): void {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', t('chat.tool.title')));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content restore-tool');
  body.textContent = text;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  container.appendChild(col);
}

/**
 * 渲染一条结构化 tool 消息（call 建卡 / result 按 id 配对回填）。
 *
 * W1467：带 `tool_parent_id` 的行是 run_code 子调用 —— 缩进挂到父卡的
 * `.toolcard-subs` 下，**与 live 路径同一个 [mountToolCard]**，两条路径因此
 * 产生同一棵树。子调用不计入 `histToolStep`（与 live 的 `ctx.step` 同口径），
 * 否则刷新后的「第 N 步」会比实时多出子调用的数量。
 */
function renderToolMessage(ctx: SessionPane, m: HistoryMsg, container: HTMLElement): void {
  if (m.kind === 'call') {
    const parentId = typeof m.tool_parent_id === 'string' ? m.tool_parent_id : undefined;
    const id = m.tool_call_id ?? 'call_' + (ctx.histToolStep + 1);
    const sub = parentId === undefined ? undefined : subCallIndex(id);
    if (parentId === undefined) ctx.histToolStep += 1;
    const ref = buildToolCard({
      step: ctx.histToolStep,
      name: m.tool_name ?? 'tool',
      argsText: toJsonText(m.tool_args),
      desc: descFromArgs(m.tool_args), // W778：折叠行标签（与 live 同一取值口径）
      ...(sub === undefined ? {} : { sub }),
    });
    mountToolCard(ref, parentId, ctx.restoreOps, container);
    ctx.restoreOps.set(id, ref);
    return;
  }
  const id = m.tool_call_id ?? '';
  const ref = ctx.restoreOps.get(id);
  if (ref) {
    const failed = !!m.tool_error && m.tool_error !== '';
    setToolResult(ref, failed ? String(m.tool_error) : toJsonText(m.tool_value), failed, m.tool_value);
    ctx.restoreOps.delete(id);
    return;
  }
  appendToolLine(
    t('shell.restore.orphanResult') +
      (m.tool_error ? String(m.tool_error) : toJsonText(m.tool_value)),
    container,
  );
}

/**
 * W515：历史条目的种类映射 ——
 *   role=user + kind='steering'|'queued' → 插话/排队气泡（与普通用户消息可区分）；
 *   role/kind='inbox' → 回执/系统注入条目；
 *   其余保持现状（未知 kind 一律按普通消息渲染，不丢内容）。
 */
function userKindOf(m: HistoryMsg): MsgKind {
  if (m.kind === 'steering') return 'steering';
  if (m.kind === 'queued') return 'queued';
  return 'user';
}

function renderOne(
  ctx: SessionPane,
  m: HistoryMsg,
  container: HTMLElement,
  questions: Map<string, HistoryQuestion>,
): void {
  const content = String(m.content ?? '');
  // W784：提问行 → 提问卡片（未结算的渲染成「已过期 · 未作答」终态，§7.2 规则 4）；
  // 回答行不再单独渲染 —— 它已经回显在对应卡片上（同一张卡，不产生第二个条目）。
  const qid = typeof m.question_id === 'string' ? m.question_id : '';
  if (m.role === 'question') {
    const row = qid === '' ? undefined : questions.get(qid);
    if (row !== undefined && m.kind === 'question') {
      renderHistoryQuestionCard(ctx, row, container);
    }
    return;
  }
  if (m.role === 'inbox' || m.kind === 'inbox') {
    renderInboxMessage(ctx, content, { source: m.source, kind: m.kind, into: container });
    return;
  }
  if (m.role === 'user') {
    const parsed = parseQuoteBlocks(content); // 只在 role=user 解析（架构侧裁决）
    addUserMessage(ctx, parsed.rest, {
      kind: userKindOf(m),
      attachments: attachmentViewsOf(m.attachments),
      quotes: parsed.quotes,
      into: container,
    });
    return;
  }
  if (m.role === 'assistant') {
    if (content.trim() === '') return;
    const a = ensureAssistant(ctx, container);
    a.text = content;
    finalizeAssistant(ctx, a);
    return;
  }
  if (m.role === 'thinking') {
    renderThinkingHistory(content, container);
    return;
  }
  renderToolMessage(ctx, m, container);
}

/**
 * 历史思考条目：与 live **同一构建函数** buildThinkSeg（默认折叠态因此不可能分叉）。
 * 历史恢复 = 静态内容，永远用默认态（collapsed: true），不随 live 流式状态变化。
 */
function renderThinkingHistory(content: string, container: HTMLElement): void {
  container.appendChild(buildThinkSeg({ text: content, collapsed: true }).root);
}

function appendNote(ctx: SessionPane, text: string): void {
  if (ctx.el.querySelector('.restore-note')) return;
  ctx.el.appendChild(el('div', 'restore-note', text));
}

/**
 * 渲染指定会话历史（最近 200 条 + 折叠提示 + 「以下为本次会话」分隔线）。
 * 离屏双缓冲——先在离屏容器完整构建，再一次性 replaceChildren（无空白帧）；
 * guard() 返回 false 时丢弃（竞态：旧请求结果晚到不得覆盖新会话）。
 * 404/超时/端点缺失 → 轻提示，不崩溃。
 */
export async function restoreSessionHistory(
  ctx: SessionPane,
  guard?: () => boolean,
): Promise<void> {
  let resp;
  try {
    resp = await api.messages(ctx.id);
  } catch (err) {
    if (!ctx.streaming) {
      appendNote(
        ctx,
        t('shell.restore.unavailable'),
      );
    }
    return;
  }
  if (guard && !guard()) return; // 竞态：期间已发起更新的切换，丢弃本次结果
  const all = resp.messages ?? [];
  if (ctx.streaming) return; // 已开跑：不打断实时流

  // 离屏构建（不挂载，浏览器不绘制中间态）
  railReset(ctx); // 先清该会话旧长条；离屏渲染注册的新条目在替换后重新 layout
  ctx.restoreOps.clear();
  ctx.histToolStep = 0;
  const off = document.createElement('div');
  if (all.length > MAX_RESTORE) {
    off.appendChild(
      el('div', 'restore-fold', t('shell.restore.folded', { n: MAX_RESTORE })),
    );
  }
  const recent = all.length > MAX_RESTORE ? all.slice(all.length - MAX_RESTORE) : all;
  // W784 §7.2：提问/回答两行按 question_id 配对（有问无答 = 该提问不可再答）。
  const questions = new Map(historyQuestionsOf(recent).map((row) => [row.id, row]));
  for (const m of recent) renderOne(ctx, m, off, questions);
  if (ctx.restoreOps.size) {
    for (const ref of ctx.restoreOps.values()) {
      setToolResult(ref, t('shell.restore.noResult'), false);
    }
    ctx.restoreOps.clear();
  }
  if (recent.length) {
    const sep = el('div', 'live-sep');
    sep.appendChild(el('span', null, t('shell.restore.sessionStart')));
    sep.title = t('shell.restore.earlier');
    off.appendChild(sep);
  }
  if (guard && !guard()) return;

  // 一次性替换（无空白帧）
  ctx.el.replaceChildren(...off.childNodes);
  if (!recent.length) {
    renderEmptyHint(ctx);
    const sep = el('div', 'live-sep');
    sep.appendChild(el('span', null, t('shell.restore.sessionStart')));
    ctx.el.appendChild(sep);
  }
  ctx.dedup.tail = recent.length ? (recent[recent.length - 1] ?? null) : null;
  ctx.dedup.guardActive = false;
  ctx.dedup.guardBuf = '';
  ctx.dedup.guardAll = false;
  ctx.restored = true;
  railSync(ctx);
  autoscroll(ctx, true);
  // 历史就位后再问服务端「还有哪些提问没结算」：进程没重启的刷新靠这一步把卡片
  // 从「未作答」放回可作答；进程重启了服务端就没有它，卡片留在终态（§7.2）。
  void recoverQuestions(ctx);
}

/**
 * 解析当前活跃会话 id（W237）：
 *   1) GET /api/sessions 的 active 字段；2) GET /api/workspaces 的 active_session；
 *   3) 兜底：旧后端无 active 概念 → 若 cli-main 存在则用之；否则 null。
 */
export async function resolveActiveSession(): Promise<string | null> {
  try {
    const d = await api.sessions();
    const act = (d.sessions ?? []).find((s) => s.active === true);
    if (act?.id) return act.id;
  } catch {
    /* fall through */
  }
  try {
    const w = await api.workspaces();
    if (w.active_session) return w.active_session;
  } catch {
    /* fall through */
  }
  try {
    const d = await api.sessions();
    if ((d.sessions ?? []).some((s) => s.id === 'cli-main')) return 'cli-main';
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 启动恢复：把 LOCAL 容器认领为当前活跃会话（容器对象不变 → 已渲染内容
 * 与 rail 状态全部保留），再拉取历史。
 */
export async function restoreActiveHistory(): Promise<void> {
  const id = await resolveActiveSession();
  if (id === null) {
    const ctx = activePane();
    if (ctx && !ctx.streaming) appendNote(ctx, t('shell.restore.noActive'));
    return;
  }
  const pane = adoptPane(id);
  if (!pane.restored && !pane.streaming) await restoreSessionHistory(pane);
  else void recoverQuestions(pane); // 历史已在/正在跑：仍补一次未决列表
}

// ---- 会话切换（无空白帧 + 竞态防护 + 后台会话不阻塞） ----------------------------

let progressEl: HTMLElement | null = null;

function showSwitchProgress(): void {
  if (progressEl) return;
  progressEl = document.createElement('div');
  progressEl.className = 'switch-progress';
  // W795：这条顶部细进度条是**唯一**保留的非阻塞提示（历史数据本身就是终态内容，
  // 没有可先画的终态）；但它不再携带任何「正在加载…」文案（title 已删）。
  document.body.appendChild(progressEl);
}

function hideSwitchProgress(): void {
  progressEl?.remove();
  progressEl = null;
}

/**
 * 打开会话视图（W514）：
 *   - 立即切容器（hidden 切换，零重渲染）：别的会话在跑也照样切，不等任何请求；
 *   - 未恢复过历史 → 离屏双缓冲恢复（顶部细进度条，不整页空白）；
 *   - 正在跑（live）的会话 → 直接看实时流，不再拉历史；
 *   - seq 竞态防护：同一容器重复打开时旧结果丢弃。
 */
export function openSession(id: string, meta?: { kind?: string; title?: string }): SessionPane {
  const pane = ensurePane(id, meta?.kind, meta?.title);
  activatePane(id);
  if (!pane.streaming && !pane.restored) {
    const seq = ++pane.restoreSeq;
    showSwitchProgress();
    // restoreSessionHistory 末尾自带一次未决列表重建，此处不重复请求
    void restoreSessionHistory(pane, () => seq === pane.restoreSeq).finally(() => {
      if (seq === pane.restoreSeq) hideSwitchProgress();
    });
  } else {
    // 切回已有内容的会话：可能错过了提问帧（切走期间模型问了）→ 补齐未决卡片
    void recoverQuestions(pane);
  }
  return pane;
}

/** 兼容旧入口：等价于 openSession（保留外部调用点）。 */
export function switchToSession(id: string): void {
  openSession(id);
}

/** 会话切换是否进行中（供外部判断加载态）。 */
export function isSwitching(): boolean {
  return progressEl !== null;
}
