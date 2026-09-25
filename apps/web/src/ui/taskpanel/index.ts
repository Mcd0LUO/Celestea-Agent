// ============================================================================
// ui/taskpanel/index.ts — W1533 任务面板的对外面（按职责拆到 ./{model,store,panel,wire}）。
// ----------------------------------------------------------------------------
//   installTaskPanel();                 // 装配（一次；main.ts 走 ui/sessionbar.ts 的装配点）
//   noteTaskCall / noteTaskResult        // live：SSE 的 tool / tool_result 帧
//   noteTaskHistory                      // 恢复：历史里的 tool 行
// 数据来源与位置决策见各文件头注。
// ============================================================================

export { buildPanel, hidePanel, relabelPanel, renderPanel, setCollapsed } from './panel';
export type { TaskPanelRef } from './panel';
export {
  dropTaskPanel,
  installTaskPanel,
  liveConnected,
  mountTaskPanel,
  noteTaskCall,
  noteTaskHistory,
  noteTaskResult,
  panelMounted,
  resetTaskPanelWiring,
  setTaskFrameSource,
  setTasksCollapsed,
  taskPanelOf,
} from './wire';
export {
  dropTasks,
  hasTasks,
  isSameAs,
  noteTasksFrom,
  onTasksChange,
  pruneTasks,
  resetTasks,
  setTasks,
  taskPaneCount,
  tasksOf,
} from './store';
export {
  changedIndexes,
  countOf,
  deltaOf,
  isStatus,
  panelStateOf,
  readTasks,
  rowKeys,
  sameTasks,
  snapshotOf,
} from './model';
export type { PanelState, TaskCounts, TaskDelta, TaskItem, TaskSnapshot, TaskStatus } from './model';
