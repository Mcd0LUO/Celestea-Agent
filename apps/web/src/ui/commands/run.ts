// ============================================================================
// ui/commands/run.ts — A3：用户直发命令的**执行与渲染**（/run 与 ! 前缀共用）。
// ----------------------------------------------------------------------------
// 语义（架构侧 2026-09-19 裁决）：**立即执行、与模型无关** —— 前端直接调
//   POST /api/exec，输出直接进对话，**不触发任何模型轮次、不调用 /api/turn**。
// 渲染：消息流里一块「终端输出」（命令 + stdout/stderr + 退出码 + 耗时 + 沙箱摘要），
//   与模型消息视觉上可区分（.msg.exec 前缀 + .exec-block）。
// 降级：端点未发布（404/405/501）→ 可读提示，绝不静默无反应。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import { api, ApiError, userErrorText } from '../../api';
import type { SessionPane } from '../viewctx';
import { autoscroll } from '../messages';
import { railSync } from '../rail';

/** 默认超时（毫秒）：P0 固定，命令不传就按它。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

function codeLabel(r: { exit_code: number | null; signal: string | null }): string {
  if (r.signal !== null && r.signal !== '') return '被信号终止（' + r.signal + '）';
  if (r.exit_code === null) return '退出码未知';
  return '退出码 ' + String(r.exit_code) + (r.exit_code === 0 ? '（成功）' : '（失败）');
}

function streamBlock(label: string, text: string, cls: string): HTMLElement | null {
  if (text === '') return null;
  const box = el('div', 'exec-stream ' + cls);
  box.appendChild(el('div', 'exec-stream-label', label));
  box.appendChild(el('pre', 'exec-stream-body', text));
  return box;
}

function sandboxLine(s: { provider?: string; net_isolated?: boolean; tmp_private?: boolean; seccomp?: boolean } | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.provider) parts.push(s.provider);
  parts.push(s.net_isolated === true ? '网络隔离' : '可联网');
  if (s.tmp_private === true) parts.push('私有临时目录');
  if (s.seccomp === true) parts.push('系统调用过滤');
  return parts.join(' · ');
}

/** 命令气泡（与模型消息可区分：标题「命令」）。 */
function commandBubble(ctx: SessionPane, command: string): HTMLElement {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg exec');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '命令'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble exec-bubble');
  bubble.appendChild(el('pre', 'exec-cmd', command));
  msg.appendChild(bubble);
  col.appendChild(msg);
  ctx.el.appendChild(col);
  railSync(ctx);
  return col;
}

function notice(ctx: SessionPane, text: string): void {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg exec exec-note');
  const bubble = el('div', 'bubble info-bubble');
  bubble.appendChild(el('div', 'content info-content', text));
  msg.appendChild(bubble);
  col.appendChild(msg);
  ctx.el.appendChild(col);
  railSync(ctx);
}

/** 终端输出块（就地更新：先建骨架，结果到达后单次填充）。 */
function outputBlock(ctx: SessionPane, command: string): { root: HTMLElement; fill(r: ExecResultView): void } {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg exec');
  const bubble = el('div', 'bubble exec-bubble');
  const block = el('div', 'exec-block');
  bubble.appendChild(block);
  msg.appendChild(bubble);
  col.appendChild(msg);
  ctx.el.appendChild(col);
  railSync(ctx);
  return {
    root: col,
    fill(r: ExecResultView): void {
      const head = el('div', 'exec-head');
      head.appendChild(el('span', 'exec-cmd', command));
      head.appendChild(el('span', 'exec-code' + (r.failed ? ' err' : ' ok'), r.codeLabel));
      head.appendChild(el('span', 'exec-dur', String(r.durationMs) + ' ms'));
      block.appendChild(head);
      const sb = sandboxLine(r.sandbox);
      if (sb !== '') block.appendChild(el('div', 'exec-sandbox', sb));
      const out = streamBlock('输出', r.stdout, 'out');
      if (out) block.appendChild(out);
      const err = streamBlock('错误输出', r.stderr, 'err');
      if (err) block.appendChild(err);
      if (!out && !err) block.appendChild(el('div', 'exec-sandbox', '（没有输出）'));
      autoscroll(ctx, true);
    },
  };
}

/** 结果视图（供 fill 用；与线格式解耦，便于测试注入）。 */
export interface ExecResultView {
  codeLabel: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  sandbox?: { provider?: string; net_isolated?: boolean; tmp_private?: boolean; seccomp?: boolean };
}

/** 执行一条用户命令（/run 与 ! 前缀都走这里）；返回是否已产生可见输出。 */
export async function runUserCommand(ctx: SessionPane, command: string): Promise<void> {
  const cmd = command.trim();
  if (cmd === '') return;
  commandBubble(ctx, cmd);
  const block = outputBlock(ctx, cmd);
  autoscroll(ctx);
  try {
    const r = await api.exec({ command: cmd, session: ctx.id === '' ? undefined : ctx.id, timeout_ms: DEFAULT_EXEC_TIMEOUT_MS });
    block.fill({
      codeLabel: codeLabel(r),
      durationMs: r.duration_ms,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      failed: r.exit_code !== 0 || (r.signal !== null && r.signal !== ''),
      sandbox: r.sandbox,
    });
  } catch (err) {
    block.root.remove(); // 不假装有输出
    const unsupported = err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
    notice(
      ctx,
      unsupported
        ? '这个版本还不支持直接执行命令，请升级后再试'
        : '命令没有跑起来：' + userErrorText(err, '请稍后重试'),
    );
    autoscroll(ctx, true);
  }
}
