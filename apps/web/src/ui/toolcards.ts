// ============================================================================
// ui/toolcards.ts — 工具调用卡片（W239 任务 3+4；W514 多会话化）：
//   工具事件按发生时间与 user/assistant 消息交错内联，作为消息流级条目
//   （.mcol.msg.tool）插入「该会话自己的视图容器」（SessionPane.el）。
//   W514：索引（tool_call_id → 卡片）与步数由全局单例改为每容器一份，
//         后台会话的工具卡回填不会污染当前视图。
//   W778：折叠态改「真单行」——summary 只留 第 N 步 + desc(缺失回落工具名) +
//         状态 + 复制 + 折叠指示（内联 SVG chevron，方向由 data-fold 驱动）；
//         原「参数：…」「结果：…」两行预览移进 .toolcard-body（仅展开可见），
//         折叠态不再像半截展开。desc 取自工具参数里的可选字符串 desc
//         （后端契约 ≤80 字符，前端折叠空白后截断到 60）。
// ============================================================================
import { el } from '../utils/dom';
import { attachmentViewsOf, refsOfValue, renderAttachmentGrid } from './attachments';
import { autoscroll } from './messages';
import type { SessionPane } from './viewctx';
import type { ToolCardRef } from './view';
import type { ToolPayload, ToolResultPayload } from '../types';
import { noteWorkerSpawn } from './worker-strip';

export type { ToolCardRef };

const SUMMARY_CHARS = 60; // 参数/结果摘要截断字数
/** W778：desc 标签展示上限（契约 ≤80，前端折叠空白后截到 60）。 */
export const DESC_MAX_CHARS = 60;
/** W778：折叠指示（内联 SVG chevron，形状与思考段 W765 的 chevron 同源：
 *  16 网格、线宽 1.6、圆头圆角；方向不写死在标记里，由 data-fold 驱动 CSS 旋转）。 */
export const TOOL_FOLD_COLLAPSED = 'collapsed';
export const TOOL_FOLD_EXPANDED = 'expanded';
const TOOL_CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';

/**
 * W778：折叠行标签 —— 工具参数里的 `desc`（折叠空白、截断到 DESC_MAX_CHARS），
 * 缺失/空白/非字符串一律回落工具名（`desc` 是给人看的一句话，不替代工具身份）。
 */
export function toolDescLabel(desc: unknown, fallback: string): string {
  const t = typeof desc === 'string' ? desc.replace(/\s+/g, ' ').trim() : '';
  if (t === '') return fallback;
  return t.length <= DESC_MAX_CHARS ? t : t.slice(0, DESC_MAX_CHARS) + '…';
}

/**
 * W778：从原始 args 里取 `desc`（对象字段或 JSON 文本都认）；取不到返回 ''。
 * live 事件给的是对象，历史恢复给的是同上形状的对象 —— 两条路径同一取值口径。
 */
export function descFromArgs(args: unknown): string {
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t.startsWith('{')) return '';
    try {
      return descFromArgs(JSON.parse(t));
    } catch {
      return '';
    }
  }
  if (args !== null && typeof args === 'object') {
    const d = (args as { desc?: unknown }).desc;
    return typeof d === 'string' ? d : '';
  }
  return '';
}

/** 当前工具步骤数（供状态栏 step 显示）。 */
export function getToolStep(ctx: SessionPane): number {
  return ctx.step;
}

/** 清空会话/切换会话时复位（resetMessages 调用）。 */
export function resetToolCards(ctx: SessionPane): void {
  ctx.ops.clear();
  ctx.step = 0;
}

/**
 * W263：新一轮开始时把当前轮工具步数清零（每个 tool 事件 +1）。
 * 与 resetToolCards 的区别：只清计数器，保留 opIndex —— 迟到/跨轮到达的
 * tool_result 仍能按 id 回填到已渲染的卡片上。
 */
export function resetTurnStep(ctx: SessionPane): void {
  ctx.step = 0;
}

function toJsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function summaryOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= SUMMARY_CHARS) return t;
  return t.slice(0, SUMMARY_CHARS) + '…';
}

/** 工具卡构建数据（live 事件与历史恢复共用）。 */
export interface ToolCardData {
  step: number;
  name: string;
  argsText: string; // 参数全文
  /** W778：可选 desc 标签（取自 args.desc）；缺失时折叠行回落工具名。 */
  desc?: string;
}

/** 构建工具调用卡片 DOM（消息流级条目；live 与恢复渲染共用同一款式）。 */
export function buildToolCard(d: ToolCardData): ToolCardRef {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg tool');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '工具'));
  cap.appendChild(el('span', null, d.name));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const card = document.createElement('details');
  card.className = 'toolcard running';
  // W752：工具卡默认折叠（终态由 CSS 强制，见 styles/components.css 的
  // `.toolcard:not([open]) > .toolcard-body`）——显式写 false 是把「默认折叠」
  // 变成可断言的构建期事实，而不是依赖 <details> 的隐式默认值。
  // W778：summary 只剩单行摘要，参数/结果预览与全文都在 body 里 ——
  // 折叠态就是一行，展开才看细节；结果到达也不碰 open。
  card.open = false;
  const head = document.createElement('summary');
  head.className = 'toolcard-head';
  head.setAttribute('aria-expanded', 'false');
  const row1 = el('div', 'toolcard-row1');
  row1.appendChild(el('span', 'step-tag', '第 ' + d.step + ' 步'));
  // W778：折叠行标签 = desc（缺失回落工具名）；title 里保留工具名，悬停可辨。
  const nameEl = el('span', 'toolcard-name', toolDescLabel(d.desc, d.name));
  nameEl.title = d.name;
  row1.appendChild(nameEl);
  const state = el('span', 'toolcard-state');
  // W739：改用离屏构建（原静态 innerHTML 赋值是纯字面量，无注入面，但收敛写入点）
  state.appendChild(el('span', 'ts-dot'));
  state.appendChild(el('span', 'ts-label', '运行中'));
  row1.appendChild(state);
  const copyBtn = el('button', 'toolcard-copy', '复制') as HTMLButtonElement;
  copyBtn.type = 'button';
  copyBtn.title = '复制参数与结果（JSON）';
  copyBtn.addEventListener('click', (e) => {
    e.preventDefault(); // 阻止 summary 切换展开
    e.stopPropagation();
    const outEl = card.querySelector<HTMLElement>('.tool-out');
    const text = d.argsText + '\n' + (outEl?.textContent ?? '');
    void navigator.clipboard.writeText(text).catch(() => {
      /* clipboard unavailable */
    });
  });
  row1.appendChild(copyBtn);
  const fold = el('span', 'toolcard-fold');
  fold.setAttribute('data-fold', TOOL_FOLD_COLLAPSED);
  fold.innerHTML = TOOL_CHEVRON_SVG; // 常量字面量，无注入面
  row1.appendChild(fold);
  head.appendChild(row1);
  card.appendChild(head);
  // W778：预览行与全文都进 body —— 折叠态看不到，展开才显示（铁律：不重建节点）。
  const body = el('div', 'toolcard-body');
  const argsPv = el('div', 'toolcard-args-preview');
  const a = summaryOf(d.argsText);
  argsPv.textContent = a ? '参数：' + a : '参数：—';
  body.appendChild(argsPv);
  body.appendChild(el('pre', 'tool-args', d.argsText)); // W764：等宽 pre（不换行 + 横向滚动）
  const resultPv = el('div', 'toolcard-result-preview');
  resultPv.textContent = '';
  body.appendChild(resultPv);
  card.appendChild(body);
  // aria-expanded（以及 W778 的 chevron 方向）与真实展开态同步
  // （键盘/鼠标/程序化切换都会触发 toggle）
  card.addEventListener('toggle', () => {
    head.setAttribute('aria-expanded', card.open ? 'true' : 'false');
    fold.setAttribute('data-fold', card.open ? TOOL_FOLD_EXPANDED : TOOL_FOLD_COLLAPSED);
  });
  bubble.appendChild(card);
  msg.appendChild(bubble);
  col.appendChild(msg);
  return {
    toolName: d.name,
    col,
    card,
    label: state.querySelector<HTMLElement>('.ts-label') ?? state,
    resultPv,
    body,
  };
}

/**
 * 回填工具结果（展开区里的结果预览行 + 结果全文 + 完成/失败态）。
 * W752：只改状态类与内容，**绝不触碰 card.open** —— 结果到达不自动展开；
 * 用户此时已展开的卡片也不会被这次 DOM 更新折回去（原地更新，不重建节点）。
 * W778：预览行随参数预览一起在 .toolcard-body 内（折叠态不显示），
 * 结果到达照样不改 open、不动 chevron 方向。
 */
export function setToolResult(ref: ToolCardRef, resultText: string, failed: boolean, value?: unknown): void {
  ref.card.classList.remove('running');
  ref.card.classList.add(failed ? 'err' : 'ok');
  ref.label.textContent = failed ? '失败' : '完成';
  const r = summaryOf(resultText);
  ref.resultPv.textContent = r ? '结果：' + r : '';
  if (r) ref.resultPv.classList.add('has');
  if (!ref.body.querySelector('.tool-out')) {
    ref.body.appendChild(el('pre', 'tool-out' + (failed ? ' err-c' : ''), resultText));
  }
  // W805（设计 §6.3）：read_image 的 tool_result.value.attachments → 图片缩略图。
  const refs = refsOfValue(value);
  if (refs.length > 0 && !ref.body.querySelector('.attach-grid')) {
    ref.body.appendChild(renderAttachmentGrid(attachmentViewsOf(refs)));
  }
}

/** 新建工具调用卡片（live 事件；按事件时间插入该会话视图尾部）。 */
export function pushToolCard(ctx: SessionPane, p: ToolPayload, into?: HTMLElement): HTMLElement {
  ctx.step += 1;
  const ref = buildToolCard({
    step: ctx.step,
    name: String(p.name || 'tool'),
    argsText: toJsonText(p.args),
    desc: descFromArgs(p.args), // W778：折叠行标签（缺失回落工具名）
  });
  (into ?? ctx.el).appendChild(ref.col);
  if (!into) autoscroll(ctx);
  ctx.ops.set(String(p.id), ref);
  return ref.col;
}

/**
 * W866：`spawn_worker` 成功 → 把新 worker **当帧**插进「本会话 worker 快捷条」，
 * 不等下一次会话列表轮询（那是 5s 级的）。识别条件刻意收窄：工具名必须是
 * spawn_worker、结果里真有 sessionId；随后的列表刷新照常对账（同 id 只更新）。
 */
function noteSpawnedWorker(toolName: string, p: ToolResultPayload): void {
  if (toolName !== 'spawn_worker' || p.ok === false) return;
  const v = p.value;
  if (typeof v !== 'object' || v === null) return;
  const rec = v as Record<string, unknown>;
  const sid = typeof rec['sessionId'] === 'string' ? rec['sessionId'] : '';
  if (sid === '') return;
  const wid = typeof rec['wid'] === 'string' ? rec['wid'] : '';
  const title = typeof rec['title'] === 'string' ? rec['title'] : '';
  noteWorkerSpawn({
    id: 'worker:' + sid,
    kind: 'worker',
    ...(wid === '' ? {} : { wid }),
    ...(title === '' ? {} : { title }),
    workspace: 'engine',
  });
}

/** 应用工具结果：状态/结果摘要/结果全文（按 id 索引，索引属于该会话）。 */
export function applyToolResult(ctx: SessionPane, p: ToolResultPayload): void {
  // W866：spawn_worker 的结果到达当帧 → 快捷条立刻出现新行（见函数注释）。
  // 工具名取**卡片自己的**（历史恢复路径也一样有），不依赖 live 帧带 name。
  noteSpawnedWorker(ctx.ops.get(String(p.id))?.toolName ?? '', p);
  const rec = ctx.ops.get(String(p.id));
  if (!rec) return;
  const failed = p.ok === false || !!p.error;
  const label = failed
    ? '失败'
    : p.decision === 'deny'
      ? '拒绝'
      : p.decision === 'ask'
        ? '待确认'
        : '完成';
  setToolResult(rec, p.error ? String(p.error) : toJsonText(p.value), failed || p.decision === 'deny');
  rec.label.textContent = label;
  autoscroll(ctx);
}
