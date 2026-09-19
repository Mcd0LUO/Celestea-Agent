// ============================================================================
// ui/commands/index.ts — A3：斜杠命令的**装配与派发**（对外入口）。
//   装配：registerBuiltinCommands() + initCompletion(输入框) + input 事件接线。
//   派发：`!xxx` 前缀归一化为 `/run xxx`（等价快捷方式）；`/name args` 查注册表执行。
//   命令被消费时不发 /api/turn；未知命令给可读提示（不静默）。
// ============================================================================
import { listCommands, type Command } from './registry';
import { registerBuiltinCommands } from './builtin';
import { hideCompletion, initCompletion, updateCompletion, completionKey } from './popup';
import { activePane, type SessionPane } from '../viewctx';
import { renderInfoBlock } from '../messages';

export { onGoalChange, goalOf, renderGoalBar } from './goal';
import { renderGoalBar as refreshGoalBar, onGoalChange } from './goal';
import { onPaneChange } from '../viewctx';
export { listCommands, filterCommands, completionPrefix } from './registry';

/** 把 `!xxx` 归一化为 `/run xxx`；非 `!` 行原样返回。 */
export function normalizeBang(line: string): string {
  const t = line.trim();
  if (!t.startsWith('!')) return line;
  const rest = t.slice(1).trim();
  return rest === '' ? '/' : '/run ' + rest;
}

/** 输入行是否是命令（归一化后以 '/' 开头且非空）。 */
export function isCommand(line: string): boolean {
  const t = normalizeBang(line).trim();
  return t.startsWith('/') && t.length > 1;
}

/** 从完整输入行解析出命令名与参数（原样）。 */
function parseLine(line: string): { name: string; args: string } {
  const t = normalizeBang(line).trim();
  const body = t.slice(1);
  const sp = body.search(/\s/);
  if (sp < 0) return { name: body, args: '' };
  return { name: body.slice(0, sp), args: body.slice(sp + 1) };
}

/**
 * 执行一条命令（由 send 入口在发送前调用）。
 * 返回 true = 已消费（调用方**不要**再发 /api/turn）。
 */
export async function dispatchCommand(line: string, ctx?: SessionPane): Promise<boolean> {
  const pane = ctx ?? activePane();
  if (!pane) return false;
  const { name, args } = parseLine(line);
  if (name === '') return false;
  const cmd = listCommands().find((c) => c.name === name);
  if (!cmd) {
    renderInfoBlock(pane, '没有这个命令：/' + name + '（输入 / 查看全部命令）', 'warn');
    return true;
  }
  hideCompletion();
  return await cmd.run({ raw: line, args, ctx: pane });
}

/** 把选中的命令写回输入框（补全框选中回调）。 */
function applyPick(cmd: Command): void {
  const input = document.getElementById('input') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = '/' + cmd.name + (cmd.args === '' ? '' : ' ');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  hideCompletion();
  input.focus();
}

let installed = false;

/** 装配斜杠命令（幂等；main.ts 在 viewctx/inputbar 之后调用一次）。 */
export function installCommands(): void {
  if (installed) return;
  installed = true;
  registerBuiltinCommands();
  const input = document.getElementById('input') as HTMLTextAreaElement | null;
  if (!input) return;
  onPaneChange(() => refreshGoalBar()); // 切会话 → 目标条跟随（A3 可见性）
  onGoalChange(() => refreshGoalBar()); // 目标变化 → 条立即重画
  initCompletion(input, applyPick);
  input.addEventListener('input', () => updateCompletion(input.value));
  input.addEventListener('keydown', (e) => {
    if (completionKey(e)) return; // 补全框消费了这次按键
  });
  input.addEventListener('blur', () => hideCompletion());
}

/** 供 send 入口快速判断（`!` 也认）。 */
export function isCommandLike(line: string): boolean {
  return isCommand(line);
}

/**
 * 输入框 keydown 的**总拦截口**（inputbar 的 Enter 处理前调用）。
 * 补全框可见时消费四个键，避免 Enter 被发送路径先抢走。
 */
export function interceptKey(e: { key: string; shiftKey?: boolean; preventDefault(): void }): boolean {
  return completionKey(e);
}

export { completionVisible, activeCommandName } from './popup';
