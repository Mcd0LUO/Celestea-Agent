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
import { buildTruncatedNote, setOmittedCount } from './messages/oversize';
import { addThinkRetained, registerThinkSeg, thinkOverBudget } from './messages/think-budget';
import { t } from '../i18n';
// W1512：预算账本住在 ./messages/think-budget.ts，但公开面仍留在 messages.ts
// （调用方与测试只认这个入口，与 W867 把 cadence 拆出去时同一取舍）。
export { THINK_CONTAINER_LIMIT, thinkRetained } from './messages/think-budget';

/**
 * W1485：思考段的渲染上限（字符）。
 *
 * 为什么思考段也需要上限：流式期间本段**自动展开**（见 appendThinking 的 W752 分支），
 * 而 appendThinking 每个 tick 都做一次 `body.textContent = seg.text` + `autoscroll`。
 * 真机 CDP 实测「已挂载且可见」的代价（同一台 headless shell，1440×900）：
 *   50K → 9.7ms / 200K → 31.9ms / 600K → 104.8ms / **1.36M → 241.7ms（单 tick）**
 * 而真实日志里就有一条 1363020 字符的 thinking 段。一次 241ms 的同步布局 × 每个
 * 节拍 = 主线程被钉死，正是用户报的「切回即卡死」。
 *
 * ★ W1505（P1-1）修正了这里的**内存**面。W1485 只堵了「画多少」：正文钳到 64K，
 * 但 `seg.text` 一字不丢地留着，于是内存上界由**模型单段推理长度**决定（实测
 * 1,362,974 字符），而不是由产品常量决定。现在**同一个数管两件事**：
 *   · `seg.text` 超过 [THINK_RENDER_LIMIT] 的部分**直接丢弃**并计入 `dropped`；
 *   · 正文画保留的那部分 + 一行「已省略 N 字符」提示，**不给展开按钮** ——
 *     因为我们确实没有全文，挂按钮就是撒谎。
 *
 * 代价是「原文一字不丢」这个承诺**被撤销**了。为什么可以撤：本仓没有单条消息端点
 * （契约冻结，不加分页），无法按需 rehydrate；而真实数据里 155 个思考段只有 1 个
 * 超过 64K（0.6%），且思考是默认折叠的弱内容。用一个几乎用不到的「展开全部」去换
 * 无界内存不划算。
 *
 * ★ 为什么**两条路径都钳**（live 与历史恢复）：本仓有一条硬契约 —— 实时流与历史重放
 * 必须产出**逐字相同**的 DOM（W895-R）。若 live 钳而恢复不钳，刷新后同一个思考段会
 * 突然变长，契约就破了。`buildThinkSeg` 是两条路径的唯一构造器，钳在它里面即天然一致。
 *
 * W1512：这是**单段**上限。容器总量上限见 ./messages/think-budget.ts —— 段数无界时
 * 单段上限挡不住「600 段 × 64 K」的全容器布局代价（实测展开态 104.8 ms/tick）。
 */
export const THINK_RENDER_LIMIT = 65536;

/**
 * W1512：把容器内**最旧的**思考段回收，直到总量回到预算内。
 *
 * 只动正文与折叠类，**不删节点**（FRONTEND-RULES 铁律 4：折叠只切 class，不重建
 * DOM），因此不会产生空白帧，也不破坏 rail 的文档坐标（列还在，只是变矮）。
 * 账本与上限在 ./messages/think-budget.ts。
 */
/**
 * W1512：把**刚挂载**的一个思考段计入容器预算，并立刻守一次预算。
 *
 * 给历史恢复路径用（restore.ts 同步渲染最近 200 条；若只守 live 路径，刷新后同一个
 * 会话会突然变重，W895-R 的「实时与重放逐字一致」也会破）。live 路径走 appendThinking
 * 自己的记账，不调本函数。
 */
export function noteRestoredThinking(container: HTMLElement, seg: ThinkSegDom): void {
  noteRestoredThinkingBatch(container, [seg]);
}

/**
 * W9113（P1-2）：**批量**记账 —— 先一次性把保留量记进容器，再守一次预算。
 *
 * 为什么必须是批量而不是逐段调 [noteRestoredThinking]：历史恢复的容器是**已挂载**的
 * ctx.el（见 restore.ts 的调用点），逐段调会让 enforceThinkBudget 的
 * `querySelectorAll('.msg.think-seg')` 对 200 条历史跑 200 次 —— O(n²)。
 * 批量版把「记账」与「守预算」各做一次，语义不变（账本只增只减、不重算）。
 */
export function noteRestoredThinkingBatch(container: HTMLElement, segs: ThinkSegDom[]): void {
  for (const seg of segs) addThinkRetained(container, seg.text.length);
  if (segs.length > 0) enforceThinkBudget(container);
}

function enforceThinkBudget(container: HTMLElement): void {
  if (!thinkOverBudget(container)) return;
  const segs = container.querySelectorAll<HTMLElement>('.msg.think-seg');
  for (const msg of segs) {
    if (!thinkOverBudget(container)) break;
    const parts = thinkFolds.get(msg.parentElement ?? msg);
    if (!parts || parts.text === '') continue;
    // 从最旧的开始：回收 = 折起 + 释放正文（内容进 dropped，提示行如实报数）。
    const released = parts.text.length;
    parts.dropped += released;
    parts.text = '';
    addThinkRetained(container, -released);
    setThinkCollapsed(parts, true);
    paintThinkBody(parts);
  }
}

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
/** 折叠占位行文案（函数：语言切换后必须跟着变）。 */
export function thinkFoldedHint(): string {
  return t('chat.think.foldedHint');
}

/** 思考段的折叠零件（root = .mcol 容器）。 */
export interface ThinkSegDom {
  root: HTMLElement; // .mcol
  msg: HTMLElement; // .msg.think-seg（折叠类挂它，CSS 依赖）
  head: HTMLElement; // 标题行（点击 / 回车 / 空格切换）
  body: HTMLElement; // 正文
  foldMark: HTMLElement; // 折叠箭头（W765：内联 SVG chevron，方向由 data-fold 驱动）
  /**
   * **保留**的思考文本（与 ui/view.ts 的 ThinkSeg 同字段，便于直接挂到 ctx）。
   *
   * W1505（P1-1）：它的长度上限就是 [THINK_RENDER_LIMIT] —— 同一个数同时管
   * 「画多少」与「留多少」。超出部分进 [dropped]，**不保留**。
   */
  text: string;
  /** W1505：超出上限、**已丢弃**的字符数（0 = 一字未丢）。 */
  dropped: number;
  /** 省略提示行（复用节点，避免每节拍重建）。 */
  note?: HTMLElement;
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
/**
 * W1505：把 `seg.text`（**已按上限保留**）画进正文，并在丢弃过内容时挂一行诚实提示。
 *
 * 单一写入口 —— buildThinkSeg（首次/恢复）与 appendThinking（每节拍）都走它，
 * 两条路径的钳位口径因此不可能分叉。
 *
 * ★ 与 W1485 的关键差别：那时正文钳位、`seg.text` 留全文，于是「展开全部」有内容可给。
 * 现在 `seg.text` 自己就只保留到上限，所以**没有可展开的东西** —— 提示行用
 * [buildTruncatedNote]（无按钮），而不是带按钮的 [buildOmittedNote]。
 * 挂了按钮却点不出更多内容就是撒谎。
 */
function paintThinkBody(seg: ThinkSegDom, emptyText = ''): void {
  // emptyText 由调用方给：buildThinkSeg 传 ''（保持「无文本 = 空」的原语义），
  // appendThinking 传占位文案（live 流式的「思考中…」）。
  seg.body.textContent = seg.text === '' ? emptyText : seg.text;
  if (seg.dropped > 0) {
    if (!seg.note) {
      seg.note = buildTruncatedNote(seg.dropped);
      seg.body.after(seg.note);
    } else {
      setOmittedCount(seg.note, seg.dropped);
    }
  } else if (seg.note) {
    seg.note.remove();
    seg.note = undefined;
  }
}

/**
 * W1505：把一个思考增量并进段里，**保留到上限为止**，返回实际保留的新增字符数。
 *
 * 为什么是「保留到上限」而不是「超了就整段丢弃」：前缀是有用的（用户能看到推理的开头），
 * 而后半段本来就是被钳掉的部分。保留前缀也让「已省略 N 字符」这个数随流式单调增长，
 * 而不是先显示 64K、超限后又跳回 0。
 */
function retainThinking(seg: ThinkSegDom, delta: string, container: HTMLElement): void {
  const room = THINK_RENDER_LIMIT - seg.text.length;
  if (room <= 0) {
    seg.dropped += delta.length;
    return;
  }
  if (delta.length <= room) {
    seg.text += delta;
    addThinkRetained(container, delta.length);
    return;
  }
  seg.text += delta.slice(0, room);
  seg.dropped += delta.length - room;
  addThinkRetained(container, room);
}

export function buildThinkSeg(
  opts: { time?: string; text?: string; collapsed?: boolean } = {},
): ThinkSegDom {
  const root = el('div', 'mcol');
  const msg = el('div', 'msg think-seg');
  const cap = el('div', 'msg-caption think-head') as HTMLElement;
  cap.appendChild(el('span', 'who', t('chat.think.title')));
  // W1468：折叠提示行从 .bubble 移到**头行之内** —— 它此前独占第二行，使一个折叠的
  // 思考段占两行（用户：「思考块太大了，改为文字级大小」）。桌面端 chevron 是 hover
  // 才淡入，提示行确实承担状态信息，所以不删，只与标题同行显示。
  cap.appendChild(el('span', 'think-seg-folded', thinkFoldedHint()));
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
  bubble.appendChild(body);
  msg.appendChild(bubble);
  root.appendChild(msg);
  // W1505：构造时就把文本钳到上限（历史恢复路径的全文可能远超上限）。
  const initial = opts.text ?? '';
  const kept = initial.length > THINK_RENDER_LIMIT ? initial.slice(0, THINK_RENDER_LIMIT) : initial;
  const seg: ThinkSegDom = { root, msg, head: cap, body, foldMark, text: kept, dropped: initial.length - kept.length };
  thinkFolds.set(root, seg);
  // W9113（P1-3）：把「这一列保留了多少字符」登记到账本模块 —— dom-cap.ts 摘列时
  // 按列减账要用它。只登记**读法**（结构类型），不 import 本模块，故不成环。
  registerThinkSeg(root, seg);
  // W1512：构造路径不在这里记账 —— 本函数只造节点，容器由调用方 append，此刻还拿不到
  // 稳定的容器键。两条挂载路径各自记账并各守一次预算：
  //   · live：appendThinking 用 ctx.el 记账 + enforceThinkBudget(ctx.el)；
  //   · 历史恢复：restore.ts 在**搬家之后**调 noteRestoredThinkingBatch(ctx.el, segs)
  //     （W9113/P1-2：改动前记在离屏 off 上，搬家后账本随之丢失 → thinkRetained 恒 0）。
  // 若只守 live，刷新后的同一会话会突然变重（W895-R 的逐字一致也会破）。
  paintThinkBody(seg);
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
 * W847：**一步结束**的思考段收尾 —— 把当前段折回终态并解除归属（对 null 幂等），
 * 但**不**清 lastTextCol、也不结束整轮（endTurn 仍负责跨轮清理）。
 *
 * 为什么需要它：落盘的 ThinkingBuffer（packages/agent-loop/src/thinking.ts:26-31）
 * 在 text/done/terminal 处把一段连续推理 flush 成**一条** thinking_delta 行，所以
 * 历史重放天然是 thinking → tool → thinking → tool … 交替；而 live 侧 ctx.thinkSeg
 * 原先只在 endTurn 清空，整轮所有 reasoning 会累进同一个段，实时与刷新后的分段
 * 不一致。调用点见 chat.ts 的 onDone（须在 assistant 早退之前）与 onTool（done
 * 帧被总线丢弃时的兜底）。
 */
export function flushThinkSegment(ctx: SessionPane): void {
  if (!ctx.thinkSeg) return; // 幂等：本步没有开着的思考段
  foldThinkSeg(ctx); // W752 语义：撤流式信号 + 尊重用户手动折叠意图的自动折叠
  ctx.thinkSeg = null;
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
    seg.body.textContent = t('chat.think.thinking'); // 流式思考占位态（弱化）
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
    // W1505：`ctx.thinkSeg` 的类型是较窄的 view.ThinkSeg（只有 root/head/body/text），
    // 而 retainThinking 需要 ThinkSegDom 的 dropped/note —— 从登记表按 root 反查
    // （与上面 foldThinkSeg 同一手法）。
    const parts = thinkFolds.get(seg.root);
    if (parts) {
      retainThinking(parts, delta || '', ctx.el);
      // W1512：单段钳位之后还要守**容器总量** —— 段数无界，600 个满段 = 37.5 MB
      // 展开态文本，每 tick 一次全容器布局（实测 105 ms）。超预算就从最旧的段回收。
      enforceThinkBudget(ctx.el);
      paintThinkBody(parts, t('chat.think.thinking'));
    }
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
  flushVisible,
  removeAssistant,
  resetMessages,
} from './messages/assistant';
export { addUserMessage, laneLabel, renderInboxMessage } from './messages/user';
export type { MsgKind } from './messages/user';
export { renderInfoBlock, renderInterjectNote, updateInfoBlock } from './messages/info';
