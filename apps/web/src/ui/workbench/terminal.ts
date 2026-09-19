// ============================================================================
// ui/workbench/terminal.ts — G4：终端面板（**一次性执行，不是真 PTY**）。
// ----------------------------------------------------------------------------
// 数据面：POST /api/exec（立即执行，返回 stdout/stderr/exit_code/duration_ms）。
// ⚠️ 它**不是交互式 TTY**：没有提示符、没有 stdin、没有持续流。所以 P0 做
//    「命令输入框 + 输出区」：每输入一条跑一条、把结果**追加**到输出区；
//    界面上明确写「一次性执行（不是交互式终端）」，绝不渲染会被误解为可交互的提示符。
//    真 PTY 需要新的流式端点（可行性已 spike，端点未做）⇒ P1。
// 竞态：每次执行取面板新 seq；晚到的旧结果丢弃（多面板各自独立）。
// ============================================================================
import { el } from '../../utils/dom';
import { api, ApiError, userErrorText } from '../../api';
import { nextSeq, type PanelState } from './state';

interface TermLine {
  cmd: string;
  out: string;
  err: string;
  code: string;
  ms: number;
  failed: boolean;
}

function dataOf(panel: PanelState): { lines: TermLine[] } {
  const d = panel.data as unknown as { lines?: TermLine[] } | undefined;
  if (d && Array.isArray(d.lines)) return d as { lines: TermLine[] };
  const init = { lines: [] as TermLine[] };
  panel.data = init as unknown as Record<string, unknown>;
  return init;
}

function lineBlock(l: TermLine): HTMLElement {
  const box = el('div', 'wb-term-line');
  const head = el('div', 'wb-term-cmd');
  head.appendChild(el('span', 'wb-term-prompt', '$'));
  head.appendChild(el('span', 'wb-term-cmdtext', l.cmd));
  box.appendChild(head);
  if (l.out !== '') box.appendChild(el('pre', 'wb-term-out', l.out));
  if (l.err !== '') box.appendChild(el('pre', 'wb-term-out err', l.err));
  box.appendChild(el('div', 'wb-term-meta' + (l.failed ? ' err' : ''), l.code + ' · ' + String(l.ms) + ' ms'));
  return box;
}

/** 渲染终端面板内容（可重入；输出从面板 data 恢复，切换 dock 不丢）。 */
export function renderTerminalPanel(body: HTMLElement, panel: PanelState, isCurrent: (id: string, seq: number) => boolean): void {
  const data = dataOf(panel);
  const off = document.createElement('div');
  off.appendChild(el('div', 'wb-term-note', '一次性执行（不是交互式终端）：输入一条命令，回车运行。'));
  const row = el('div', 'wb-term-row');
  const input = el('input', 'wb-term-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = '输入命令，例如 ls -la';
  const run = el('button', 'wb-btn wb-term-run', '运行') as HTMLButtonElement;
  run.type = 'button';
  row.appendChild(input);
  row.appendChild(run);
  off.appendChild(row);
  const out = el('div', 'wb-term-outwrap');
  for (const l of data.lines) out.appendChild(lineBlock(l));
  off.appendChild(out);
  body.replaceChildren(...Array.from(off.childNodes));

  const doRun = (): void => {
    const cmd = input.value.trim();
    if (cmd === '') return;
    input.value = '';
    const seq = nextSeq(panel.id);
    void exec(panel, cmd, seq, isCurrent, out);
  };
  run.addEventListener('click', doRun);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doRun();
    }
  });
}

async function exec(
  panel: PanelState,
  cmd: string,
  seq: number,
  isCurrent: (id: string, seq: number) => boolean,
  out: HTMLElement,
): Promise<void> {
  const pending = el('div', 'wb-term-line');
  pending.appendChild(el('div', 'wb-term-meta', '运行中'));
  out.appendChild(pending);
  let line: TermLine;
  try {
    const r = await api.exec({ command: cmd, timeout_ms: 30_000 });
    line = {
      cmd,
      out: r.stdout ?? '',
      err: r.stderr ?? '',
      code: r.signal !== null && r.signal !== '' ? '信号 ' + r.signal : '退出码 ' + String(r.exit_code),
      ms: r.duration_ms,
      failed: r.exit_code !== 0 || (r.signal !== null && r.signal !== ''),
    };
  } catch (err) {
    const unsupported = err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
    line = {
      cmd,
      out: '',
      err: unsupported ? '这个版本还不支持直接执行命令' : userErrorText(err, '命令没有跑起来'),
      code: '失败',
      ms: 0,
      failed: true,
    };
  }
  if (!isCurrent(panel.id, seq)) return; // 竞态：晚到结果丢弃
  dataOf(panel).lines.push(line);
  pending.replaceWith(lineBlock(line));
}
