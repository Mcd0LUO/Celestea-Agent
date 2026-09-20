// ============================================================================
// ui/view.ts — 视图层合同：消息流/工具卡片的 DOM 句柄（与 API 合同分离）。
// W514：新增每会话视图容器所需的合同类型（ThinkSeg / StreamDom / ToolCardRef
// / DedupState），使 messages/toolcards/restore/viewctx 共享同一份结构定义，
// 不再把「当前会话」的状态藏在各模块的模块级单例里。
// ============================================================================
import type { MarkdownStream } from '../utils/markdown';
import type { HistoryMsg } from '../types';

export interface ToolOpView {
  card: HTMLElement;
  state: HTMLElement;
  label: HTMLElement;
}

export interface AssistantView {
  /** .msg.assistant 整列 */
  root: HTMLElement;
  /** 气泡容器 */
  bubble: HTMLDivElement;
  /** thinking 折叠块（默认收起；idle 时隐藏） */
  think: HTMLDetailsElement;
  thinkBody: HTMLElement;
  /** 思考时长徽标 */
  thinkTime: HTMLElement;
  /** 工具卡片容器 */
  cards: HTMLDivElement;
  /** markdown 正文容器 */
  content: HTMLDivElement;
  text: string;
  thinkText: string;
  ops: Map<string, ToolOpView>;
  steps: number;
}

/** W514：一轮内的思考段（弱化块）——每个会话视图各持一份。 */
export interface ThinkSeg {
  root: HTMLElement; // .mcol 根（含折叠状态 class）
  head: HTMLElement; // 标题行（可点折叠/展开）
  body: HTMLElement; // 内容
  text: string;
}

/**
 * W514：文本段增量渲染状态（WeakMap 挂载在 AssistantView 上，见 messages.ts）。
 *
 * W895-R：分区**不再按节点引用记账**，改用我们自己的一个注释节点当**边界**。
 * 为什么（这是「实时与重放不一致」反复出现的根因）：
 *   旧实现把「稳定区节点」与「尾部节点」存成两个 Node[]，并假定它们始终是
 *   `content` 的直接子节点。但增强遍（代码块包裹 / JSON 树 / CSV 表）会**移动**节点，
 *   于是下一节拍：锚点已不在 content 里 → `insertBefore` 抛错或错位；
 *   更糟的是 `tailNodes` 的移除会把**已经被搬进 <details> 的内容**从新父节点里摘走，
 *   留下一个空壳（实测症状：一张被掏空的 JSON 小卡 + 一个孤立的引号）。
 *   重放走的是「一次性整体构建」分支，不碰这套记账，所以只有实时坏 —— 这就是
 *   「实时坏、重放好」的原因。
 *
 * 边界模型下这条假设消失：稳定区插在边界**之前**、尾部区插在边界**之后**，
 * 每节拍只清掉边界之后的一切。增强遍再怎么重排/包裹/拆分节点，边界都在原地。
 * 注释节点对 CSS 结构伪类不可见（实测 :first-child/:last-child 不受影响）。
 */
export interface StreamDom {
  stream: MarkdownStream;
  /** 稳定区与尾部区的分界（`content` 的子节点；注释节点）。 */
  boundary: Comment;
  lastText: string;
}

/** W514：已构建的工具卡引用（供结果回填 / 复制）。 */
export interface ToolCardRef {
  col: HTMLElement;
  card: HTMLElement;
  label: HTMLElement;
  resultPv: HTMLElement;
  body: HTMLElement;
  /** W866：该卡片的工具名（live 与历史恢复同源）——结果回填时据此识别 spawn_worker。 */
  toolName: string;
}

/**
 * W514：历史恢复 → live 增量之间的衔接去重状态（每个会话视图一份，
 * 原先为 restore.ts 的模块级单例，跨会话会互相污染）。
 */
export interface DedupState {
  tail: HistoryMsg | null;
  guardActive: boolean;
  guardBuf: string;
  guardAll: boolean;
}
