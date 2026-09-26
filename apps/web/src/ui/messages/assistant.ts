// ============================================================================
// ui/messages/assistant.ts — 助手文本段（W759 从 ui/messages.ts 拆出）
//   W301：文本段增量渲染（MarkdownStream 只解析未固化尾部 + 节拍重渲染）
//   W514：渲染目标 = 会话视图容器 SessionPane，每个 AssistantView 一份流式状态
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import { MarkdownStream } from '../../utils/markdown';
import type { AssistantView, StreamDom } from '../view';
import { activePane, type SessionPane } from '../viewctx';
import { railAdd, railSync } from '../rail';
import { runEnhancers } from '../enhance';
import { htmlToNodes } from './markdown';
import { buildOmittedNote, clampForRender, MESSAGE_RENDER_LIMIT, setOmittedCount } from './oversize';
import { prunePaneDom } from './dom-cap'; // W1485：消息容器的 DOM 上限
import { waitFor } from './cadence'; // W1524：合并窗口 = 上次渲染实测耗时（自适应）
import { autoscroll, hideEmptyHint, renderEmptyHint } from './scroll';

// ---- 文本段增量渲染器（W301） ---------------------------------------------------
/** 每个 AssistantView 一份流式渲染状态（WeakMap 挂载，不改 view.ts 公共接口）。 */
const doms = new WeakMap<AssistantView, StreamDom>();

function domOf(view: AssistantView): StreamDom {
  let d = doms.get(view);
  if (!d) {
    d = {
      stream: new MarkdownStream(),
      boundary: document.createComment('w895-boundary'),
      lastText: '\u0000',
      expanded: false,
      note: null,
    };
    doms.set(view, d);
  }
  return d;
}

/** 助手文本段是否已有内容（占位判定）。 */
export function assistantHasContent(view: AssistantView): boolean {
  return view.text.trim() !== '' || view.content.childElementCount > 0;
}

/** 直接移除空占位助手气泡（不渲染空块）。 */
export function removeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.root.remove();
  doms.delete(view);
  if (ctx.assistant === view) ctx.assistant = null;
}

/** 清空该会话消息流并重建空态（/api/clear 成功后调用；同时重置流式状态）。 */
export function resetMessages(ctx: SessionPane): void {
  if (ctx.render.timer !== null) {
    window.clearTimeout(ctx.render.timer);
    ctx.render.timer = null;
  }
  ctx.render.deadline = Number.NEGATIVE_INFINITY; // W867：清空后第一帧同样立即渲染
  ctx.render.cost = 0; // W1524：清空后没有实测代价，窗口回到下限
  if (ctx.assistant) doms.delete(ctx.assistant);
  ctx.assistant = null;
  ctx.turn = null;
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
  ctx.interjectNote = null;
  ctx.ops.clear();
  ctx.step = 0;
  renderEmptyHint(ctx);
}

// ---- 流式正文渲染节拍（W867：近似立即 + 短 debounce 合并） ----------------------
/**
 * 合并窗口（ms，≈1 帧）。语义 = leading 立即 + trailing 合并：
 *   · 距上次渲染已过窗口（首次 / 空闲后的第一帧）→ **同一调用栈内立即渲染**，事件到达
 *     即出字，不再等一个 60ms 节拍（旧口径在流式与快速切换时明显发顿，用户 6②）；
 *   · 同一窗口内的连续增量 → 并成一次尾部渲染，绝不逐字节重排。
 *
 * ★ W1524：这个 12 是**下限**，实际窗口 = clamp(上次渲染实测耗时, 12, 50)，见
 *   ./cadence.ts 的 mergeWindow。固定窗口在「渲染本身 ≥ 窗口」的内容上会退化成
 *   「每帧都渲染」——CDP 真机实测（代码形态）：一个 4 帧突发 = 4 次同步全量渲染，
 *   13 个长帧、最长 89.5ms。常量名与下限语义保持不变，W867 的门禁照旧成立。
 */
export const RENDER_DEBOUNCE = 12;

/**
 * 渲染文本段（W301 + W514 每容器独立节拍）—— **实时与重放走同一个函数、同一条分支**。
 *
 * W895-R：分区用**边界哨兵**而不是节点引用记账（见 view.ts 的 StreamDom 注释）。
 *   1) MarkdownStream 只解析「未固化尾部」，返回 stableHtml / tailHtml 分解；
 *   2) 新固化的块插到边界**之前**（已有块 DOM 原地保留，不重建）；
 *   3) 尾部区 = 边界**之后**的全部节点，整体替换（同一帧内完成，无空白帧）。
 *
 * 重放只是「文本已完整」的一次调用：此时 stable 已是全量、tailHtml 为空，
 * 走的仍是这条路径 —— 没有「只有重放才走」的分支，两者因此不可能分叉。
 */
function renderTextView(ctx: SessionPane, view: AssistantView): void {
  const d = domOf(view);
  if (d.lastText === view.text) {
    autoscroll(ctx);
    railSync(ctx);
    return;
  }
  // W1485：单条消息的渲染上限。超长正文只渲染前缀（原文一字不丢，展开按钮用全文
  // 重渲染一次）—— 这是「后台攒了几百 KB 后一次 parse 卡死主线程」的最后一道闸。
  const clamped = d.expanded ? { text: view.text, omitted: 0 } : clampForRender(view.text, MESSAGE_RENDER_LIMIT);
  const parts = d.stream.updateParts(clamped.text);
  d.lastText = view.text;

  // 边界必须是 content 的子节点：首次渲染挂上，或在 reset 后（容器被别处清过）重新挂。
  if (d.boundary.parentNode !== view.content) view.content.appendChild(d.boundary);

  // (2) 新增的稳定块插到边界之前。reset 时 stableDeltaHtml 是**全量** stable，
  //     所以这里天然覆盖「整体重建」，不需要另一条分支。
  // ★ 用 DocumentFragment 一次性插入（每 tick 至多 1 次 DOM 变更）：
  //   W867 的门禁按「.content 上的变更调用次数」计重排，逐节点插入会把
  //   一次合并渲染变成 N 次 —— 那是真实的性能回退，不是测试口径问题。
  if (parts.reset || parts.stableDeltaHtml) {
    const stableHtml = parts.reset ? parts.stableHtml : parts.stableDeltaHtml;
    const frag = document.createDocumentFragment();
    for (const n of htmlToNodes(stableHtml)) frag.appendChild(n);
    view.content.insertBefore(frag, d.boundary);
  }

  // (3) 尾部区整体替换：删掉边界之后的一切，再按文档序插回（同样用 fragment）。
  for (let n = d.boundary.nextSibling; n !== null; ) {
    const next = n.nextSibling;
    n.remove();
    n = next;
  }
  const tailFrag = document.createDocumentFragment();
  for (const n of htmlToNodes(parts.tailHtml)) tailFrag.appendChild(n);
  view.content.appendChild(tailFrag);

  // 超长提示行：节点**跨节拍复用**（尾部区每 tick 重建，新建的话每帧都会造一个
  // 新按钮）。它在内容之外、作为 .content 的最后一个子节点，不参与稳定/尾部两区。
  if (clamped.omitted > 0) {
    if (d.note === null) {
      d.note = buildOmittedNote(clamped.omitted, () => {
        // ★ 必须先把 lastText 置回哨兵：renderTextView 开头有「文本没变就短路」的
        //   快路径，而展开时 view.text 恰恰**没变**（变的是渲染策略）—— 不短路掉
        //   它，按钮点了什么都不会发生（本门禁的变异负控制抓到的真 bug）。
        d.expanded = true;
        d.lastText = '\u0000';
        renderTextView(ctx, view);
      });
    } else {
      setOmittedCount(d.note, clamped.omitted);
    }
    if (d.note.parentNode !== view.content) view.content.appendChild(d.note);
  } else if (d.note !== null) {
    d.note.remove();
    d.note = null;
  }

  // W895：渲染后的增强遍走注册缝（内置 hljs + math 仍在此链上，顺序不变）。
  runEnhancers(view.content);
  autoscrollView(ctx, view); // W867：离屏（历史恢复）不写滚动位
  // W1485：消息容器的 DOM 上限。**只对已挂载的容器做**（离屏的历史恢复由 restore.ts
  // 收尾统一裁一次）—— 在离屏容器里逐条数节点是纯浪费，且那时列数还没定型。
  if (view.root.isConnected !== false) prunePaneDom(ctx);
  railSync(ctx);
}

/**
 * W1524：带**实测耗时**的渲染 —— 每次真正渲染都把耗时写回节拍，作为下一次的合并窗口。
 *
 * 为什么单独包一层而不是在 renderTextView 内部测：renderTextView 开头有一条「文本没变
 * 就短路」的快路径（只 autoscroll/railSync），那条路径的耗时**不代表**重排代价，记进去
 * 会让窗口无端变小。只统计真正干了活的那条路径。
 */
function renderTimed(ctx: SessionPane, view: AssistantView): void {
  const t0 = performance.now();
  renderTextView(ctx, view);
  ctx.render.cost = performance.now() - t0;
}

function scheduleTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.render.timer !== null) return; // 已有一次尾部渲染排队（窗口内的增量都并进它）
  // W1485：标签页在后台时**不排渲染**，只累积（view.text 继续涨）。
  // 浏览器对后台标签页的 setTimeout 节流到 ≥1s，而 SSE 事件照常到达 —— 排队的那次
  // 渲染会在切回时以「几百 KB 全文」的身份落地，正是用户看到的「切回即卡死」。
  // 后台只累积、变可见时由 flushVisible() 一次性对齐（同一帧内完成，不会空白）。
  if (document.hidden) return;
  const now = performance.now();
  // W1524：窗口自适应（见 ./cadence.ts）。waitFor 内部保留 -Infinity 的首帧哨兵语义。
  const wait = waitFor(now, ctx.render, RENDER_DEBOUNCE);
  if (wait === 0) {
    ctx.render.deadline = now;
    renderTimed(ctx, view); // leading：立即渲染（不再等定时器）
    return;
  }
  ctx.render.timer = window.setTimeout(() => {
    ctx.render.timer = null;
    ctx.render.deadline = performance.now();
    renderTimed(ctx, view);
  }, wait);
}

/**
 * W867：只有**已挂载**的气泡才需要跟随滚动。历史恢复在离屏容器里构建（restore.ts 的
 * off），逐条写 scrollTop 是纯浪费（200 条 ≈ 200 次强制布局 + 无效写）；恢复末尾
 * restoreSessionHistory 自己会 autoscroll(ctx, true) 贴底一次，观感不变。
 * 用 `=== false` 判定（而不是 `!isConnected`）：DOM 垫片没有该属性时行为与改动前一致。
 */
function autoscrollView(ctx: SessionPane, view: AssistantView, force = false): void {
  if (view.root.isConnected === false) return;
  autoscroll(ctx, force);
}

/** 立即冲刷（turn 结束 / done 事件 / 最终文本到来时调用）。 */
function flushTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.render.timer !== null) {
    window.clearTimeout(ctx.render.timer);
    ctx.render.timer = null;
  }
  ctx.render.deadline = performance.now();
  renderTextView(ctx, view);
}

/**
 * W1485：从后台切回时把「后台累积的正文」一次性渲染到当前状态。
 *
 * 为什么必须有这一步（而不是让 scheduleTextView 自己排队）：后台期间我们**故意**
 * 不排渲染，若不在可见时补一次，正文就会停在切走那一刻的样子，直到下一个 token
 * 到达才追上 —— 用户看到的是「切回来还是旧内容」。这里同步补一次，且因为渲染上限
 * 已经生效，这一次的代价有界（≤ MESSAGE_RENDER_LIMIT）。
 *
 * 与 grants.ts:217 的 visibilitychange（授权面板刷新）互不干涉：那条走网络，
 * 这条只碰 DOM；两条都只订阅、都不阻止对方。
 */
export function flushVisible(): void {
  const ctx = activePane();
  const view = ctx?.assistant;
  if (!ctx || !view) return;
  if (ctx.render.timer !== null) {
    window.clearTimeout(ctx.render.timer);
    ctx.render.timer = null;
  }
  ctx.render.deadline = performance.now();
  renderTextView(ctx, view);
}

/** 增量追加正文 delta（节拍渲染，不逐字重排）。 */
export function appendText(ctx: SessionPane, view: AssistantView, delta: string): void {
  view.text += delta || '';
  scheduleTextView(ctx, view);
}

/**
 * Sync final assistant text from the done event.
 *
 * ★ W1524：文本**没变**时也必须冲刷排队中的那次渲染。
 *
 *   旧实现是 view.text === text → return，理由是「没有新内容就不用渲染」。但那只在
 *   「已渲染的文本 == view.text」时成立；流式的尾部渲染是**排队**的（scheduleTextView
 *   的定时器），done 到达时完全可能有一次渲染还没落地。此时早退 = 让用户对着旧 DOM 等
 *   满一个合并窗口（W1524 的窗口最坏 50ms）。
 *
 *   这不是纯理论：tests/w895r-live-replay-parity 就是靠「done 之后 8 个宏任务内 DOM 必须
 *   已是终态」在读结果，W1524 把窗口从固定 12ms 改成自适应后该用例 6 跑 2 红（原始代码
 *   6 跑 0 红）。修在这里而不是去调窗口：**turn 结束本来就该立刻对齐终态**，与窗口多长无关。
 */
export function applyFinalText(ctx: SessionPane, view: AssistantView, text: string): void {
  if (typeof text !== 'string') return;
  // ★ W9201（P1 修复）：空文本**也要**冲刷排队中的那次渲染。
  //
  //   旧实现在这一行就 `!text → return` 了，而上面 W1524 的整个论证是
  //   「done 到达时完全可能有一次渲染还排在窗口里，turn 结束本来就该立刻对齐终态」。
  //   空文本的 done 恰恰是最需要这条保证的一类：工具步的 done、被掐断的流、
  //   provider 只回完整文本的兜底 —— 它们都不带正文，于是终态 DOM 会停在旧内容上，
  //   最长再等一个合并窗口（RENDER_WINDOW_MAX=50ms），而 chat.ts 紧接着就
  //   autoscroll 了（滚到底、DOM 却是旧的）。
  //
  //   ★ 不造空气泡：这里**只**冲刷「已经排队的那次渲染」，既不碰 view.text、
  //     也不新建任何节点 —— 空文本的语义（「本步没有正文」）一字未变。
  //     没有排队渲染时是纯空转（ctx.render.timer === null），所以「done 带空文本」
  //     不会凭空多出一次全量重排。
  if (text === '') {
    if (ctx.render.timer !== null) flushTextView(ctx, view);
    return;
  }
  if (view.text === text) {
    // 内容没变，但可能有排队未落的渲染 → 立刻冲刷，别让终态等一个窗口。
    if (ctx.render.timer !== null) flushTextView(ctx, view);
    return;
  }
  view.text = text;
  flushTextView(ctx, view);
}

/** 冻结当前文本段：有内容则收尾为完整气泡，并解除当前段。 */
export function flushTextSegment(ctx: SessionPane): void {
  const a = ctx.assistant;
  if (!a) return;
  ctx.assistant = null;
  if (assistantHasContent(a)) {
    a.bubble.classList.remove('streaming');
    a.bubble.classList.add('complete');
    flushTextView(ctx, a);
    autoscroll(ctx, true);
  } else {
    a.root.remove(); // 空占位不渲染
    doms.delete(a);
  }
}

/** 获取当前文本段视图或创建新的流式文本气泡（容器 = 该会话的视图）。 */
export function ensureAssistant(ctx: SessionPane, into?: HTMLElement): AssistantView {
  const target = into ?? ctx.el;
  if (target === ctx.el) {
    if (ctx.assistant) return ctx.assistant;
    hideEmptyHint(ctx);
  }
  const col = el('div', 'mcol');
  const msg = el('div', 'msg assistant');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', 'Studio'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble streaming');
  const content = el('div', 'content rendered');
  bubble.appendChild(content);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  railAdd(ctx, col, 'assistant');
  if (target === ctx.el) railSync(ctx);

  // think/cards 字段为类型兼容保留（不挂载；thinking/工具卡均独立成段）
  const view: AssistantView = {
    root: msg,
    bubble,
    think: document.createElement('details'),
    thinkBody: document.createElement('div'),
    thinkTime: document.createElement('span'),
    cards: document.createElement('div'),
    content,
    text: '',
    thinkText: '',
    ops: new Map(),
    steps: 0,
  };
  if (target === ctx.el) {
    ctx.lastTextCol = col; // 同轮最近文本段（thinking 重排锚点）
    ctx.assistant = view;
    autoscroll(ctx, true);
  }
  return view;
}

/** 文本段收尾（turn 结束 / done 冲刷）。 */
export function finalizeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  flushTextView(ctx, view);
  autoscrollView(ctx, view, true); // W867：离屏（历史恢复）不写滚动位
}
