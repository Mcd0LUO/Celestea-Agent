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

/** W514：文本段增量渲染状态（WeakMap 挂载在 AssistantView 上，见 messages.ts）。 */
export interface StreamDom {
  stream: MarkdownStream;
  stableNodes: Node[];
  tailNodes: Node[];
  lastText: string;
  /** 是否已在 content 中建立过节点（false → 本次走整体构建） */
  inited: boolean;
}

/** W514：已构建的工具卡引用（供结果回填 / 复制）。 */
export interface ToolCardRef {
  col: HTMLElement;
  card: HTMLElement;
  label: HTMLElement;
  resultPv: HTMLElement;
  body: HTMLElement;
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
