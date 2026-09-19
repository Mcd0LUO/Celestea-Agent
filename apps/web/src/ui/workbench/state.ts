// ============================================================================
// ui/workbench/state.ts — G4：多面板工作区的**状态层**（纯数据 + 订阅，零 DOM）。
// ----------------------------------------------------------------------------
// 面板 = {id, kind, title, dock, size, seq}：
//   · kind: 'files' | 'terminal' | 'browser' —— 同一种可**多开**（id 唯一）。
//   · dock: 'right' | 'bottom' —— 用户要求的「可自由拆分移动到底部 / 右侧」。
//   · size: 该 dock 方向上的像素尺寸（right=宽，bottom=高）。
//   · seq: 每个面板独立竞态序号（切换目录 / 加载时晚到的旧结果一律丢弃）。
// 状态变更加订阅者；渲染层（panel.ts）只读本层、不反向写。
// ============================================================================
import { t } from '../../i18n'; // i18n Batch5：面板默认标题走字典

export type PanelKind = 'files' | 'terminal' | 'browser';
export type DockSide = 'right' | 'bottom';

export interface PanelState {
  id: string;
  kind: PanelKind;
  title: string;
  dock: DockSide;
  size: number;
  /** 该面板的竞态序号（每次异步加载前 ++，晚到结果丢弃）。 */
  seq: number;
  /** 渲染层可挂任意载荷（如文件管理器当前目录）；状态层不解释它。 */
  data?: Record<string, unknown>;
}

const panels: PanelState[] = [];
const listeners = new Set<() => void>();
let seqCounter = 0;
let focused: string | null = null;

function emit(): void {
  for (const cb of listeners) cb();
}

/** 订阅面板集合变化（返回取消订阅）。 */
export function onPanelsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 当前面板（快照，渲染用）。 */
export function listPanels(): readonly PanelState[] {
  return panels;
}

/** 按 id 取面板。 */
export function panelOf(id: string): PanelState | undefined {
  return panels.find((p) => p.id === id);
}

/** 当前聚焦面板 id（null = 无）。 */
export function focusedPanel(): string | null {
  return focused;
}

/** 聚焦某面板（点击面板内任意处）。 */
export function focusPanel(id: string): void {
  if (focused === id) return;
  focused = id;
  emit();
}

/** 默认标题（按 kind + 序号）。 */
function defaultTitle(kind: PanelKind, n: number): string {
  const base = kind === 'files' ? t('chat.wb.menu.files') : kind === 'terminal' ? t('chat.wb.menu.terminal') : t('chat.wb.menu.browser');
  return base + ' ' + String(n);
}

/** 默认尺寸（right=宽 / bottom=高）。 */
export function defaultSize(dock: DockSide): number {
  return dock === 'right' ? 420 : 260;
}

/** 新建一个面板（同 kind 可多开）；返回新面板。 */
export function openPanel(kind: PanelKind, dock: DockSide = 'right'): PanelState {
  seqCounter += 1;
  const n = panels.filter((p) => p.kind === kind).length + 1;
  const panel: PanelState = {
    id: 'wb' + String(seqCounter),
    kind,
    title: defaultTitle(kind, n),
    dock,
    size: defaultSize(dock),
    seq: 0,
  };
  panels.push(panel);
  focused = panel.id;
  emit();
  return panel;
}

/** 关闭一个面板。 */
export function closePanel(id: string): void {
  const i = panels.findIndex((p) => p.id === id);
  if (i < 0) return;
  panels.splice(i, 1);
  if (focused === id) focused = panels.length > 0 ? panels[panels.length - 1]!.id : null;
  emit();
}

/** 切换某面板的停靠边（right ↔ bottom）；尺寸换成该方向的默认值。 */
export function setPanelDock(id: string, dock: DockSide): void {
  const p = panelOf(id);
  if (!p || p.dock === dock) return;
  p.dock = dock;
  p.size = defaultSize(dock);
  emit();
}

/** 调整某面板尺寸（拖拽分隔条；调用方已 rAF 节流）。 */
export function setPanelSize(id: string, size: number): void {
  const p = panelOf(id);
  if (!p) return;
  const clamped = Math.max(160, Math.min(Math.round(size), 1200));
  if (p.size === clamped) return;
  p.size = clamped;
  emit();
}

/** 面板的**下一个**竞态序号（每次异步加载前取）。 */
export function nextSeq(id: string): number {
  const p = panelOf(id);
  if (!p) return -1;
  p.seq += 1;
  return p.seq;
}

/** 面板当前序号是否仍是最新（晚到的旧结果用它判断）。 */
export function isCurrentSeq(id: string, seq: number): boolean {
  return panelOf(id)?.seq === seq;
}

/** 重置（测试 / 卸载用）。 */
export function resetPanels(): void {
  panels.length = 0;
  focused = null;
  seqCounter = 0;
  emit();
}
