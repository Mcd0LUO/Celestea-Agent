// ============================================================================
// ui/commands/builtin.ts — A3：内置四条命令的注册（run / goal / model / compact）。
//   补全列表 = 这里注册的顺序；发送入口按名字派发。`/compact` 从 send.ts 的
//   专用分支收进同一套注册（不再各写一套）。
// ============================================================================
import { registerCommand, type CommandContext } from './registry';
import { runUserCommand } from './run';
import { applyGoal, currentGoalText } from './goal';
import { requestSessionModel } from '../../statusline/session-model';
import { runCompact } from '../compact';
import { renderInfoBlock } from '../messages';

/** 把一段系统提示写进消息流（/model 的确认与失败都走它，保证可见）。 */
function note(ctx: CommandContext['ctx'], text: string, cls?: 'err' | 'warn'): void {
  renderInfoBlock(ctx, text, cls);
}

let registered = false;

/** 注册内置命令（幂等）。 */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  registerCommand({
    name: 'run',
    desc: '直接执行一条命令，输出进对话（不经过模型）',
    args: '<命令>',
    async run(c) {
      const cmd = c.args.trim();
      if (cmd === '') {
        note(c.ctx, '用法：/run <命令>，例如 /run echo hi', 'warn');
        return true;
      }
      await runUserCommand(c.ctx, cmd);
      return true;
    },
  });

  registerCommand({
    name: 'goal',
    desc: '设定持久目标，之后每轮都能看到；/goal done 清除',
    args: '[目标 | done]',
    async run(c) {
      const arg = c.args.trim();
      if (arg === '') {
        const cur = currentGoalText(c.ctx);
        note(c.ctx, cur === '' ? '当前还没有目标，用 /goal <目标> 设定' : '当前目标：' + cur);
        return true;
      }
      try {
        const g = await applyGoal(c.ctx, arg === 'done' ? '' : arg);
        note(c.ctx, g ? '目标已设定：' + g.text : '目标已清除');
      } catch (err) {
        note(c.ctx, err instanceof Error ? err.message : '目标没有保存，请稍后重试', 'err');
      }
      return true;
    },
  });

  registerCommand({
    name: 'model',
    desc: '切换本会话使用的模型',
    args: '<模型名>',
    async run(c) {
      const model = c.args.trim();
      if (model === '') {
        note(c.ctx, '用法：/model <模型名>', 'warn');
        return true;
      }
      const outcome = await requestSessionModel(c.ctx.id, model);
      if (outcome.kind === 'ok') note(c.ctx, '已切换本会话模型');
      else if (outcome.kind === 'busy') note(c.ctx, '本轮还没结束，稍后会自动重试切换', 'warn');
      else note(c.ctx, outcome.text, 'err');
      return true;
    },
  });

  registerCommand({
    name: 'compact',
    desc: '压缩当前会话的上下文，腾出空间',
    args: '',
    async run(c) {
      await runCompact(c.ctx);
      return true;
    },
  });
}
