// ============================================================================
// ui/sessions/types.ts — 会话树内部契约（W748 从 ui/sessions.ts 拆出）
//   TreeHost：子模块回调编排入口（ui/sessions.ts）的宿主契约，
//   避免「渲染/操作 / 编排入口」之间出现循环 import。
// ============================================================================
export interface TreeHost {
  /** 新建会话弹窗（presetWs = 预设工作区）。 */
  newSession(presetWs?: string): void;
  /** 新建工作区（目录选择弹窗）。 */
  newWorkspace(): void;
  /** 载入并渲染树（侧栏与设置页各自的宿主容器）。 */
  loadTreeInto(container: HTMLElement, countEl: HTMLElement | null): Promise<void>;
  /** 重新载入侧栏（#sessionTree / #sessionCount）。 */
  loadSessions(): Promise<void>;
}
