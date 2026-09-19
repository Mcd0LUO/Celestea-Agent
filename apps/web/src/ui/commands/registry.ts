// ============================================================================
// ui/commands/registry.ts — A3：命令**注册缝**（纯数据 + 纯函数，零 DOM）。
//   一个命令 = 名字 + 一行说明 + 参数提示 + 处理函数。补全框与发送入口共用
//   这一份清单（别再各写一套）。
// ============================================================================
import type { SessionPane } from '../viewctx';

export interface CommandContext {
  /** 完整输入行（含前导 '/' 或 '!'）。 */
  raw: string;
  /** 斜杠后的参数（原样，未 trim）。 */
  args: string;
  ctx: SessionPane;
}

export interface Command {
  /** 命令名（不含 '/'），如 'run'。 */
  name: string;
  /** 一行说明（面向用户，无实现细节词）。 */
  desc: string;
  /** 参数提示（可为空）。 */
  args: string;
  /** 执行；返回 true = 已消费（不再作为普通消息发送）。 */
  run(c: CommandContext): boolean | Promise<boolean>;
}

const commands: Command[] = [];

/** 注册/覆盖一个命令（同名后者胜）。 */
export function registerCommand(cmd: Command): void {
  const i = commands.findIndex((x) => x.name === cmd.name);
  if (i >= 0) commands[i] = cmd;
  else commands.push(cmd);
}

/** 全部命令（注册序；补全框按此顺序）。 */
export function listCommands(): readonly Command[] {
  return commands;
}

/** 按前缀过滤（name 前缀，不区分大小写）。 */
export function filterCommands(prefix: string): Command[] {
  const p = prefix.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(p));
}

/** 输入行是否处在「命令补全」状态：以 '/' 开头且还没敲到空白（未进入参数）。 */
export function completionPrefix(line: string): string | null {
  if (!line.startsWith('/')) return null;
  const rest = line.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/** 输入行是否是命令调用（'/' 或 '!' 开头且非空）。 */
export function isCommandLine(line: string): boolean {
  const t = line.trim();
  return (t.startsWith('/') || t.startsWith('!')) && t.length > 1;
}
