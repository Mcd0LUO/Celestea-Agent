// ============================================================================
// types/exec.ts — A3：用户直发命令的线格式（POST /api/exec）。
//   冻结契约（架构侧 2026-09-19）：body { command, session?, workdir?, timeout_ms? }；
//   200 = { ok, exit_code, signal, stdout, stderr, duration_ms, sandbox{} }；
//   4xx = { error, code? }（如权限档位不允许 shell ⇒ 明确拒绝）。
//   这条命令**不经模型**、不触发任何 turn：前端拿到结果直接渲染成终端输出块。
// ============================================================================

/** 沙箱执行环境摘要（服务端事实，原样展示）。 */
export interface ExecSandbox {
  provider: string;
  net_isolated: boolean;
  tmp_private: boolean;
  seccomp: boolean;
  cpu_sec?: number;
}

/** POST /api/exec 请求体。 */
export interface ExecReq {
  command: string;
  session?: string;
  workdir?: string;
  timeout_ms?: number;
}

/** POST /api/exec 响应（成功态）。 */
export interface ExecResp {
  ok?: boolean;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  sandbox?: ExecSandbox;
  error?: string;
  code?: string;
}
