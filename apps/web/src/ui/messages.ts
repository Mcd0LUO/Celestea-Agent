// ============================================================================
// ui/messages.ts — 消息流（单一职责，W240 连续事件流重构；W514 多会话化）：
//   一轮 = 按事件真实时间顺序渲染成一条连续流：
//     用户消息 → 思考段（弱化块，按序）→ 文本段（markdown 气泡）→
//     工具调用卡（内联条目）→ 工具结果 → 继续文本段 → ……
//   文本增量按节拍重渲染；工具事件到达时当前文本段收尾（flushTextSegment），
//   后续文本开启新段 —— 不再按"思考/文本/工具"分区聚合。
//   W301：文本段改用 MarkdownStream 增量渲染（只解析未固化尾部）。
//   W514：所有渲染目标由「全局 #messages」改为「会话视图容器 SessionPane」——
//         每个会话各有一份流式状态（assistant/thinkSeg/渲染节拍），后台会话的
//         增量渲染进它自己的隐藏容器，不触碰当前视图（零重渲染、无空白帧）。
//
//   W759：按职责拆到 ./messages/*，本文件保留**思考段**并把对外 API 原样再导出
//   （import 路径与拆分前兼容）。拆分是纯搬家：无行为变更。
//     ./messages/markdown.ts   markdown 渲染与消毒（md / htmlToNodes）
//     ./messages/scroll.ts     滚动与空态提示（autoscroll / hideEmptyHint / renderEmptyHint）
//     ./messages/assistant.ts  助手文本段（W301 流式增量渲染 / 占位判定 / 收尾 / 重置）
//     ./messages/user.ts       用户侧消息（W515 user / steering / queued / inbox）
//     ./messages/info.ts       信息块（context/status）与队列注记
//   思考段（buildThinkSeg / setThinkCollapsed / foldThinkSeg / appendThinking /
//   endTurn）**留在本文件**：tools/check-fold-default.mjs 对 src/ui/messages.ts
//   做源码级断言 —— `export function buildThinkSeg(` 与 live 路径
//   `buildThinkSeg({ time: fmtNow(), collapsed: !ctx.streaming })` 必须逐字在位，
//   且折叠类不得 toggle 到 .mcol 根上；搬走会让默认折叠门禁机械失败。
// ============================================================================
import { el, fmtNow } from '../utils/dom';
import type { SessionPane } from './viewctx';
import { railSync } from './rail';
import { autoscroll, hideEmptyHint } from './messages/scroll';

// ---- thinking（弱化独立段，按事件顺序出现，不再聚合进气泡） ----------------------

/* W752：思考段默认折叠。
 * 折叠类挂在 **.msg.think-seg** 上（不是 .mcol 根）——CSS 选择器是
 * `.msg.think-seg.collapsed …`；历史上 live 把类 toggle 到 .mcol 根上，选择器
 * 永不命中，于是「点了没反应、永远展开」。setThinkCollapsed 是折叠态的唯一写入口
 * （class + data-fold 箭头方向 + aria-expanded 三处同写）；live 追加与历史恢复共用
 * buildThinkSeg，两条路径的默认态因此不可能分叉。 */

/**
 * W765：折叠指示由「+ / ▸▾ 字形」改为**内联 SVG chevron**（对齐 DSH DisclosureRow
 * 的 chevron 资源形态：14px 线性箭头，线宽 1.6、圆头圆角接头）。
 * 方向不写死在 SVG 里，而由 `data-fold` 属性驱动 CSS 旋转：
 *   collapsed（收起，等价旧字形 ▸）= chevron 指向右；expanded（等价旧字形 ▾）= 顺时针 90° 指向下。
 * 源码是常量字面量、无任何用户输入参与拼接，innerHTML 在这里没有注入面。
 */
export const THINK_CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';
/** 折叠态取值（data-fold）：与旧「实心三角 ▸」等价。 */
export const THINK_FOLD_COLLAPSED = 'collapsed';
/** 展开态取值（data-fold）：与旧「空心三角 ▾」等价。 */
export const THINK_FOLD_EXPANDED = 'expanded';
/** 折叠占位行文案（收起时代替正文显示）。 */
export const THINK_FOLDED_HINT = '思考已折叠，点击展开';

/** 思考段的折叠零件（root = .mcol 容器）。 */
export interface ThinkSegDom {
  root: HTMLElement; // .mcol
  msg: HTMLElement; // .msg.think-seg（折叠类挂它，CSS 依赖）
  head: HTMLElement; // 标题行（点击 / 回车 / 空格切换）
  body: HTMLElement; // 正文
  foldMark: HTMLElement; // 折叠箭头（W765：内联 SVG chevron，方向由 data-fold 驱动）
  text: string; // 累积思考文本（与 ui/view.ts 的 ThinkSeg 同字段，便于直接挂到 ctx）
}

/** root → 折叠零件（不改 ui/view.ts 的 ThinkSeg 合同）。 */
const thinkFolds = new WeakMap<HTMLElement, ThinkSegDom>();
/** 用户手动切换过折叠态的段：段结束的自动折叠不再覆盖用户意图。 */
const thinkUserFolded = new WeakSet<HTMLElement>();

/** 折叠态唯一写入口：class + data-fold（箭头方向）+ aria-expanded 同步。 */
export function setThinkCollapsed(seg: ThinkSegDom, collapsed: boolean): void {
  seg.msg.classList.toggle('collapsed', collapsed);
  seg.foldMark.setAttribute('data-fold', collapsed ? THINK_FOLD_COLLAPSED : THINK_FOLD_EXPANDED);
  seg.head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/**
 * W764：流式态标记 —— 头行扫光带与行首图标自转由 `[data-state="running"]` 驱动
 * （对齐 DSH 推理行：`[data-state=running] .row::after` 的扫光）。只写一个属性，
 * 视觉全在 CSS；段结束必须撤掉，否则旧段会一直"跑着"。
 */
export function setThinkStreaming(seg: ThinkSegDom, on: boolean): void {
  if (on) seg.msg.dataset.state = 'running';
  else delete seg.msg.dataset.state;
}

/**
 * 构建思考段 —— live 追加与历史恢复**共用这一处**（默认态的唯一真源）。
 * collapsed 缺省 = true（默认折叠）；只有 live 流式期间显式传 false 自动展开。
 */
export function buildThinkSeg(
  opts: { time?: string; text?: string; collapsed?: boolean } = {},
): ThinkSegDom {
  const root = el('div', 'mcol');
  const msg = el('div', 'msg think-seg');
  const cap = el('div', 'msg-caption think-head') as HTMLElement;
  cap.appendChild(el('span', 'who', '思考'));
  const foldMark = el('span', 'think-fold-mark');
  foldMark.innerHTML = THINK_CHEVRON_SVG; // W765：SVG chevron（方向由 data-fold 驱动）
  cap.appendChild(foldMark);
  cap.appendChild(el('span', 'think-time', opts.time ?? ''));
  cap.setAttribute('role', 'button');
  cap.setAttribute('aria-expanded', 'false');
  cap.tabIndex = 0;
  msg.appendChild(cap);
  const bubble = el('div', 'bubble think-seg-bubble');
  const body = el('div', 'think-seg-body');
  if (opts.text !== undefined) body.textContent = opts.text;
  bubble.appendChild(body);
  bubble.appendChild(el('div', 'think-seg-folded', THINK_FOLDED_HINT));
  msg.appendChild(bubble);
  root.appendChild(msg);
  const seg: ThinkSegDom = { root, msg, head: cap, body, foldMark, text: opts.text ?? '' };
  thinkFolds.set(root, seg);
  setThinkCollapsed(seg, opts.collapsed !== false);
  const toggle = (): void => {
    thinkUserFolded.add(seg.root); // 记下用户意图
    setThinkCollapsed(seg, !seg.msg.classList.contains('collapsed'));
  };
  cap.addEventListener('click', toggle);
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return seg;
}

/**
 * 段结束（流式结束 / 新轮开始）自动折叠回默认态；用户手动切换过则不打扰。
 * ctx.thinkSeg 的静态类型不含折叠零件，故用 root 反查登记表。
 */
export function foldThinkSeg(ctx: SessionPane): void {
  const seg = ctx.thinkSeg;
  if (!seg) return;
  const parts = thinkFolds.get(seg.root);
  if (!parts) return;
  setThinkStreaming(parts, false); // W764：段已结束，先撤流式信号（扫光/自转）
  if (thinkUserFolded.has(seg.root)) return;
  setThinkCollapsed(parts, true);
}

/** 轮次结束/新轮开始：思考段折回默认态，清除思考段归属与文本段锚点（DOM 保留）。 */
export function endTurn(ctx: SessionPane): void {
  foldThinkSeg(ctx); // W752：流式结束 → 思考段回到「默认折叠」终态
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
}

/**
 * Append a thinking delta（弱化块：左侧色条 + 浅色底 + 小字；独立成段）。
 * 重排规则：思考块的目标位置 = 同轮最近文本块的正上方（紧贴）；已在目标
 * 之前则不动。跨轮：endTurn() 清 thinkSeg/lastTextCol，绝不串位。
 * W752：默认折叠；创建时若本轮流式进行中则自动展开，流式结束自动折回折叠态。
 */
export function appendThinking(ctx: SessionPane, delta: string): void {
  if (!ctx.thinkSeg) {
    hideEmptyHint(ctx);
    // W752：默认折叠；仅当本轮流式进行中时自动展开（让用户实时看到思考内容），
    // 流式结束（endTurn / 新轮开始）自动折回默认态。
    const seg = buildThinkSeg({ time: fmtNow(), collapsed: !ctx.streaming });
    ctx.el.appendChild(seg.root);
    ctx.thinkSeg = seg;
    seg.body.textContent = '思考中…'; // 流式思考占位态（弱化）
  }
  const seg = ctx.thinkSeg;
  // W752：流式期间保持展开（用户手动收起的除外）——重连补发可能让本段先以折叠态
  // 建好，随后的增量不该悄悄写进看不见的折叠块里。
  if (seg) {
    const parts = thinkFolds.get(seg.root);
    if (parts) {
      setThinkStreaming(parts, ctx.streaming === true); // W764：流式扫光/自转的开关
      if (ctx.streaming && !thinkUserFolded.has(seg.root) && parts.msg.classList.contains('collapsed')) {
        setThinkCollapsed(parts, false);
      }
    }
  }
  const target = ctx.assistant?.root ?? ctx.lastTextCol;
  if (
    seg !== null &&
    target &&
    seg.root.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
  ) {
    ctx.el.insertBefore(seg.root, target); // 紧贴目标上方
  }
  if (seg !== null) {
    seg.text += delta || '';
    seg.body.textContent = seg.text === '' ? '思考中…' : seg.text;
  }
  autoscroll(ctx);
  railSync(ctx);
}

// ---- 对外 API 再导出（W759：实现见 ./messages/*，import 路径与拆分前逐字兼容） --

export { autoscroll, hideEmptyHint, renderEmptyHint } from './messages/scroll';
export { md } from './messages/markdown';
export {
  appendText,
  applyFinalText,
  assistantHasContent,
  ensureAssistant,
  finalizeAssistant,
  flushTextSegment,
  removeAssistant,
  resetMessages,
} from './messages/assistant';
export { addUserMessage, laneLabel, renderInboxMessage } from './messages/user';
export type { MsgKind } from './messages/user';
export { renderInfoBlock, renderInterjectNote } from './messages/info';
