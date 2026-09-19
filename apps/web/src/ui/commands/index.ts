// ============================================================================
// ui/commands/index.ts — A3/H：补全框的**装配与派发**（斜杠命令 + @文件，单一引擎）。
//   '/' 开头  → 命令提供者（注册表同步过滤）
//   '@' 开头  → 文件提供者（GET /api/fs/list；只列路径、绝不读内容）
//   '!xxx'    → 归一化为 '/run xxx'（等价快捷方式），命中即消费、不发 /api/turn。
//   命令被消费时不发消息；未知命令/列举失败都给可读提示（不静默）。
// ============================================================================
import { listCommands, type Command } from './registry';
import { registerBuiltinCommands } from './builtin';
import {
  hideCompletion, initCompletion, showCompletion, completionKey, setProvider,
  type PopupItem,
} from './popup';
import { activePane, onPaneChange, type SessionPane } from '../viewctx';
import { renderInfoBlock } from '../messages';
import { listMentions } from './files';
import { t } from '../../i18n';

export { onGoalChange, goalOf, renderGoalBar } from './goal';
import { renderGoalBar as refreshGoalBar, onGoalChange } from './goal';
export { listCommands, filterCommands, completionPrefix } from './registry';
export { workspacePath } from './files';

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
 * 定位光标处的 `@` 片段：从光标往回找到 token 起点的 '@'。
 * 返回 {start, after}；after = '@' 与光标之间的已输入片段（用于前缀过滤/逐级进入）。
 */
export function mentionToken(line: string, caret: number): { start: number; after: string } | null {
  let i = Math.min(caret, line.length) - 1;
  while (i >= 0 && !/\s/.test(line[i]!)) {
    if (line[i] === '@') return { start: i, after: line.slice(i + 1, caret) };
    i -= 1;
  }
  return null;
}

/**
 * 执行一条命令（由 send 入口在发送前调用）。
 * 返回 true = 已消费（调用方**不要**再发消息）；'@' 提及不是命令，返回 false。
 */
export async function dispatchCommand(line: string, ctx?: SessionPane): Promise<boolean> {
  const pane = ctx ?? activePane();
  if (!pane) return false;
  // '@' 提及只是文本，不是命令；交给普通发送路径（只传路径）。
  if (mentionToken(line, line.length) !== null) return false;
  const { name, args } = parseLine(line);
  if (name === '') return false;
  const cmd = listCommands().find((c) => c.name === name);
  if (!cmd) {
    renderInfoBlock(pane, t('chat.command.unknown', { name }), 'warn');
    return true;
  }
  hideCompletion();
  return await cmd.run({ raw: line, args, ctx: pane });
}

function inputEl(): HTMLTextAreaElement | null {
  return document.getElementById('input') as HTMLTextAreaElement | null;
}

/** 把选中的命令写回输入框。 */
function applyCommand(item: PopupItem): void {
  const input = inputEl();
  if (!input) return;
  input.value = item.value + (item.value.endsWith(' ') ? '' : ' ');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  hideCompletion();
  input.focus();
}

/** 把选中的文件路径**作为文本**插入输入框（只传路径，不读内容）。 */
function applyMention(item: PopupItem): void {
  const input = inputEl();
  if (!input) return;
  const caret = input.selectionStart ?? input.value.length;
  const tok = mentionToken(input.value, caret);
  if (tok === null) return;
  const before = input.value.slice(0, tok.start);
  const after = input.value.slice(caret);
  input.value = before + '@' + item.value + after;
  const pos = before.length + 1 + item.value.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // 目录：插入后继续列出该目录（逐级进入）；文件：关闭补全。
  if (item.value.endsWith('/')) void refresh(input.value, pos);
  else hideCompletion();
  input.focus();
}

/** 文件提供者：列举 `@` 之后的片段（异步；popup 引擎自带 seq 竞态守卫）。 */
async function fileProvider(after: string): Promise<PopupItem[]> {
  const out = await listMentions(after);
  if (out.notice !== '') {
    const pane = activePane();
    if (pane) renderInfoBlock(pane, out.notice, 'warn');
  }
  return out.items;
}

/** 命令提供者：注册表同步过滤。 */
function commandProvider(prefix: string): PopupItem[] {
  const p = prefix.toLowerCase();
  return listCommands()
    .filter((c: Command) => c.name.toLowerCase().startsWith(p))
    .map((c) => ({ label: '/' + c.name, desc: c.desc, meta: c.args, value: '/' + c.name }));
}

/** 按当前输入行与光标刷新补全框（'/' 命令 / '@' 文件）。 */
export async function refresh(line: string, caret?: number): Promise<void> {
  const pos = caret ?? line.length;
  const tok = mentionToken(line, pos);
  if (tok !== null) {
    setProvider(fileProvider);
    await showCompletion(tok.after);
    return;
  }
  if (line.startsWith('/') && !/\s/.test(line.slice(1))) {
    setProvider(commandProvider);
    await showCompletion(line.slice(1));
    return;
  }
  setProvider(null);
  hideCompletion();
}

let installed = false;

/** 装配（幂等；main.ts 在 viewctx/inputbar 之后调用一次）。 */
export function installCommands(): void {
  if (installed) return;
  installed = true;
  registerBuiltinCommands();
  const input = inputEl();
  if (!input) return;
  onPaneChange(() => refreshGoalBar());
  onGoalChange(() => refreshGoalBar());
  setProvider(null);
  initCompletion(input, (item) => {
    if (item.label.startsWith('/')) applyCommand(item);
    else applyMention(item);
  });
  input.addEventListener('input', () => void refresh(input.value, input.selectionStart ?? input.value.length));
  input.addEventListener('keydown', (e) => {
    completionKey(e);
  });
  input.addEventListener('blur', () => hideCompletion());
}

/** 供 send 入口快速判断（`!` 也认）。 */
export function isCommandLike(line: string): boolean {
  return isCommand(line);
}

/** 输入框 keydown 的总拦截口（inputbar 的 Enter 处理前调用）。 */
export function interceptKey(e: { key: string; shiftKey?: boolean; preventDefault(): void }): boolean {
  return completionKey(e);
}

export { completionVisible, activeItemLabel } from './popup';
