// ============================================================================
// ui/workbench/index.ts — G4：多面板工作区对外入口（装配一次）。
//   第一步：面板系统 + 右上角入口菜单 + 文件管理器。
//   第二步：终端 + 浏览器 + dock 拖拽（同一套 state/panel）。
// ============================================================================
import { installWorkbench } from './panel';
import { installWorkbenchEntry } from './menu';

export { installWorkbench, installWorkbenchEntry };
export { openPanel, closePanel, listPanels, setPanelDock, setPanelSize, onPanelsChange, resetPanels } from './state';
export { toggleWorkbenchMenu, openWorkbenchPanel, closeWorkbenchMenu } from './menu';
export { renderWorkbench } from './panel';
export type { PanelKind, DockSide, PanelState } from './state';

let installed = false;

/** 装配多面板工作区（幂等；main.ts 调用一次）。 */
export function initWorkbench(): void {
  if (installed) return;
  installed = true;
  installWorkbench();
  installWorkbenchEntry();
}
