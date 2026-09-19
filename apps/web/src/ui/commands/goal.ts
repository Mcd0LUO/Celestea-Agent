// ============================================================================
// ui/commands/goal.ts — A3：持久目标（/goal）的设置/查看/清除 + 界面可见。
// ----------------------------------------------------------------------------
// 语义（架构侧 2026-09-19 裁决）：一等概念——立一个目标，agent 每轮都能看到，
//   可查看、可完成（POST /api/sessions/{id}/goal {text}；text='' = 清除）。
//   P0 明确不做「目标驱动自动续跑」：只做持久可见 + 每轮注入上下文（注入由服务端负责）。
// 可见性：statusline 的 #slGoal 徽标（一眼可见）+ 会话页顶部的 #goalBar 条。
// ============================================================================
import { el } from '../../utils/dom';
import { api, userErrorText } from '../../api';
import type { SessionPane } from '../viewctx';
import type { GoalInfo } from '../../types/goal';
import { activePane, paneOf } from '../viewctx';
import { t } from '../../i18n';

/** 每个会话的目标（客户端缓存，供徽标/条渲染；服务端仍是真源）。 */
const goals = new Map<string, GoalInfo | null>();
/** 订阅者（statusline / goalBar 重绘）。 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** 订阅目标变化（返回取消订阅）。 */
export function onGoalChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 某会话的当前目标（null = 无）。 */
export function goalOf(session: string): GoalInfo | null {
  return goals.get(session) ?? null;
}

function setLocal(session: string, g: GoalInfo | null): void {
  goals.set(session, g);
  emit();
}

/** 从服务端回声归一化目标（缺字段时保守回落）。 */
function normalize(raw: unknown): GoalInfo | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r['text'] === 'string' ? r['text'] : '';
  if (text === '') return null;
  const now = new Date().toISOString();
  return {
    text,
    createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : now,
    updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'] : now,
  };
}

/**
 * 设置/清除目标。text='' = 清除（完成）。
 * 乐观：先画终态，请求后台跑；失败回滚并抛出（调用方负责给可见说明，W795 口径）。
 * 返回最终目标（null = 已清除）。
 */
export async function applyGoal(ctx: SessionPane, text: string): Promise<GoalInfo | null> {
  const session = ctx.id;
  const prev = goals.get(session) ?? null;
  const wanted = text.trim();
  setLocal(session, wanted === '' ? null : { text: wanted, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  ctx.goal = wanted === '' ? null : wanted;
  try {
    const r = await api.setGoal(session, wanted);
    if (r.ok === false) throw new Error(r.error ?? t('chat.goal.failed'));
    const g = normalize(r.goal);
    setLocal(session, g);
    ctx.goal = g ? g.text : null;
    return g;
  } catch (err) {
    setLocal(session, prev); // 回滚
    ctx.goal = prev ? prev.text : null;
    throw new Error(t('chat.goal.saveFailed', { reason: userErrorText(err, t('settings.common.retryLater')) }));
  }
}

/** `/goal` 无参数：显示当前目标（可读一句，不新建）。 */
export function currentGoalText(ctx: SessionPane): string {
  const g = goalOf(ctx.id);
  return g ? g.text : '';
}

// ---- 界面可见：会话页顶部的目标条 ----
let barEl: HTMLElement | null = null;

function ensureBar(): HTMLElement {
  if (barEl && barEl.isConnected) return barEl;
  barEl = el('div', 'goal-bar hidden');
  const main = document.getElementById('main');
  (main ?? document.body).appendChild(barEl);
  return barEl;
}

/** 重画目标条（只在有目标时可见；不重建背景）。 */
export function renderGoalBar(): void {
  const bar = ensureBar();
  const pane = activePane();
  const g = pane ? goalOf(pane.id) : null;
  if (!g) {
    bar.classList.add('hidden');
    bar.replaceChildren();
    return;
  }
  bar.classList.remove('hidden');
  const off = document.createElement('div');
  off.appendChild(el('span', 'goal-tag', t('chat.goal.tag')));
  off.appendChild(el('span', 'goal-text', g.text));
  const done = el('button', 'goal-done', t('chat.goal.done')) as HTMLButtonElement;
  done.type = 'button';
  done.title = t('chat.goal.clearHint');
  done.addEventListener('click', () => {
    const p = activePane() ?? paneOf(pane?.id ?? '');
    if (p) void applyGoal(p, '');
  });
  off.appendChild(done);
  bar.replaceChildren(...Array.from(off.childNodes));
}
