// ============================================================================
// ui/restore-tool.ts — 历史恢复的**工具条目**渲染（W1485 从 ui/restore.ts 拆出）
// ----------------------------------------------------------------------------
// 为什么单独成模块：ui/restore.ts 已顶到模块体积棘轮上限（400 行），而本轮要给
// 它加分片渲染；这里是一次**纯搬家**（函数体逐字未变，只有 import 关系变化）。
//
// 口径（与拆分前一致）：
//   · call 建卡 / result 按 tool_call_id 配对回填，与 live 路径共用 mountToolCard；
//   · W1467：带 tool_parent_id 的行是 run_code 子调用，缩进挂到父卡的
//     .toolcard-subs 下，且**不计入** histToolStep（与 live 的 ctx.step 同口径）；
//   · 父卡不在索引里（结果先到 / 历史被截断）时退回「工具结果（无对应调用记录）」
//     一行，绝不丢内容。
// ============================================================================
import { el } from '../utils/dom';
import type { HistoryMsg } from '../types';
import type { SessionPane } from './viewctx';
import { t } from '../i18n';
import { buildToolCard, descFromArgs, mountToolCard, setToolResult, subCallIndex } from './toolcards';

/** 值 → 展示文本（对象走 2 空格缩进 JSON；stringify 失败回落 String）。 */
export function toJsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 孤立工具结果行（无对应调用记录时的降级展示）。 */
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
export function renderToolMessage(ctx: SessionPane, m: HistoryMsg, container: HTMLElement): void {
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
