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
import { t } from '../../i18n';

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
    desc: t('chat.command.run.desc'),
    args: t('chat.command.run.args'),
    async run(c) {
      const cmd = c.args.trim();
      if (cmd === '') {
        note(c.ctx, t('chat.command.run.usage'), 'warn');
        return true;
      }
      await runUserCommand(c.ctx, cmd);
      return true;
    },
  });

  registerCommand({
    name: 'goal',
    desc: t('chat.command.goal.desc'),
    args: t('chat.command.goal.args'),
    async run(c) {
      const arg = c.args.trim();
      if (arg === '') {
        const cur = currentGoalText(c.ctx);
        note(c.ctx, cur === '' ? t('chat.command.goal.none') : t('chat.command.goal.current', { text: cur }));
        return true;
      }
      try {
        const g = await applyGoal(c.ctx, arg === 'done' ? '' : arg);
        note(c.ctx, g ? t('chat.command.goal.set', { text: g.text }) : t('chat.command.goal.cleared'));
      } catch (err) {
        note(c.ctx, err instanceof Error ? err.message : t('chat.command.goal.saveFailed'), 'err');
      }
      return true;
    },
  });

  registerCommand({
    name: 'model',
    desc: t('chat.command.model.desc'),
    args: t('chat.command.model.args'),
    async run(c) {
      const model = c.args.trim();
      if (model === '') {
        note(c.ctx, t('chat.command.model.usage'), 'warn');
        return true;
      }
      const outcome = await requestSessionModel(c.ctx.id, model);
      if (outcome.kind === 'ok') note(c.ctx, t('chat.command.model.switched'));
      else if (outcome.kind === 'busy') note(c.ctx, t('chat.command.model.busy'), 'warn');
      else note(c.ctx, outcome.text, 'err');
      return true;
    },
  });

  registerCommand({
    name: 'compact',
    desc: t('chat.command.compact.desc'),
    args: '',
    async run(c) {
      await runCompact(c.ctx);
      return true;
    },
  });
}
