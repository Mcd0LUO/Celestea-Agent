// ============================================================================
// types/terminal.ts — W1528：工作台终端的线格式（真 PTY）。
//   冻结契约（contracts/endpoints.json#post_terminal / #post_terminal_input /
//   #post_terminal_close）：
//     POST /api/terminal                 { session?, cols?, rows? } -> { id, pid, cols, rows, sandbox }
//     POST /api/terminal/{id}/input      裸文本 body（**逐字节**，不追加换行）
//     POST /api/terminal/{id}/close      {} -> { ok, id, closed, pid? }
//   输出不经这些端点：走 SSE 的 `terminal` 事件（见 sse.ts / types.ts）。
//   这条命令**不经模型**、不触发任何 turn。
// ============================================================================

/** 沙箱执行环境摘要（服务端事实，原样展示）。 */
export interface TerminalSandbox {
  provider: string;
  net_isolated: boolean;
  tmp_private: boolean;
  seccomp: boolean;
  cpu_sec?: number;
}

/** POST /api/terminal 请求体。 */
export interface TerminalOpenReq {
  session?: string;
  cols?: number;
  rows?: number;
}

/** POST /api/terminal 响应（成功态）。 */
export interface TerminalOpenResp {
  ok?: boolean;
  id: string;
  pid: number | null;
  cols: number;
  rows: number;
  sandbox?: TerminalSandbox;
  error?: string;
  /** `shell_denied` / `terminal_unavailable` / `terminal_limit` —— 结构化拒绝码。 */
  code?: string;
}

/** POST /api/terminal/{id}/input 响应。 */
export interface TerminalInputResp {
  ok?: boolean;
  id: string;
  bytes: number;
}

/** POST /api/terminal/{id}/close 响应。 */
export interface TerminalCloseResp {
  ok?: boolean;
  id: string;
  closed: boolean;
  pid?: number | null;
}

/** SSE `terminal` 事件的载荷（contracts/sse-events.json events[terminal].payload）。 */
export interface TerminalFrame {
  id: string;
  session?: string | null;
  data: string;
}
