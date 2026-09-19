// @vitest-environment jsdom
/**
 * A3：斜杠命令 —— 补全框交互（打 / 弹出、过滤、↑↓、Enter 选中、Esc 关闭、点击选中）、
 * ! 前缀等价 /run、/run 走 api.exec（不触发 /api/turn）、/goal 设置与清除、
 * 端点缺失（404/501）给可读提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface CmdMod {
  installCommands(): void;
  dispatchCommand(line: string, ctx?: unknown): Promise<boolean>;
  normalizeBang(line: string): string;
  isCommand(line: string): boolean;
  completionVisible(): boolean;
  activeItemLabel(): string;
}
interface SendMod { dispatchSend(text: string, mode?: string): void }

const popupRows = (): ElLike[] => Array.from(doc.querySelectorAll('#cmdPopup .cmd-row')) as ElLike[];
const popupHidden = (): boolean => (doc.getElementById('cmdPopup') as ElLike | null)?.classList.contains('hidden') ?? true;
const popupVisible = (): boolean => !popupHidden();

function key(el: ElLike, k: string): void {
  const ev = new Ev('keydown', { bubbles: true });
  Object.defineProperty(ev, 'key', { value: k });
  el.dispatchEvent(ev);
}

describe('A3 · 斜杠命令补全框 + 派发', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{ cmd: CmdMod; ctx: unknown; input: ElLike; calls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/api/exec')) return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hi\n', stderr: '', duration_ms: 12, sandbox: { provider: 'userspace', net_isolated: true, tmp_private: true, seccomp: false } });
      if (u.endsWith('/goal')) {
        // 如实回声请求里的 text（空串 = 清除 → goal:null）。
        const text = String((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '');
        return reply(200, { ok: true, goal: text === '' ? null : { text, createdAt: 'a', updatedAt: 'b' } });
      }
      if (u.includes('/api/turn')) return reply(200, { ok: true, turn: 1 });
      return reply(200, { ok: true });
    });
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
    cmd.installCommands();
    const input = doc.getElementById('input') as ElLike;
    return { cmd, ctx: pane, input, calls };
  }

  it('打 / 弹出补全列表，显示名字 + 一行说明 + 参数提示', async () => {
    const { input } = await boot();
    input.value = '/';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupVisible()).toBe(true);
    const names = popupRows().map((r) => r.querySelector('.cmd-name')?.textContent);
    expect(names).toEqual(['/run', '/goal', '/model', '/compact']);
    expect(popupRows()[0]?.querySelector('.cmd-desc')?.textContent).toContain('执行');
    expect(popupRows()[0]?.querySelector('.cmd-args')?.textContent).toBe('<命令>');
  });

  it('边打边过滤；↑↓ 改高亮；Enter 选中写回输入框', async () => {
    const { input } = await boot();
    input.value = '/go';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupRows().map((r) => r.querySelector('.cmd-name')?.textContent)).toEqual(['/goal']);
    input.value = '/m';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupRows().map((r) => r.querySelector('.cmd-name')?.textContent)).toEqual(['/model']);
    input.value = '/';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    key(input, 'ArrowDown');
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
    expect(cmd.activeItemLabel()).toBe('/goal');
    key(input, 'Enter');
    expect(input.value).toBe('/goal ');
    expect(popupHidden(), 'Enter 选中后补全框关闭').toBe(true);
  });

  it('Esc 关闭补全框（且只关这一层）', async () => {
    const { input } = await boot();
    input.value = '/';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupVisible()).toBe(true);
    key(input, 'Escape');
    expect(popupHidden()).toBe(true);
  });

  it('点击选中行写回输入框', async () => {
    const { input } = await boot();
    input.value = '/com';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    const row = popupRows()[0] as ElLike;
    row.dispatchEvent(new Ev('mousedown', { bubbles: true }));
    expect(input.value).toBe('/compact '); // 选中命令后留一个空格，便于继续输入参数
  });

  it('! 前缀归一化为 /run，且不触发 /api/turn', async () => {
    const { cmd, calls } = await boot();
    expect(cmd.normalizeBang('!echo hi')).toBe('/run echo hi');
    expect(cmd.isCommand('!echo hi')).toBe(true);
    const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod;
    send.dispatchSend('!echo hi');
    await flush();
    expect(calls.some((u) => u.includes('/api/exec'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn')), '! 命令不得触发模型轮次').toBe(false);
  });

  it('/run 走 api.exec，输出渲染成终端块（含退出码/耗时）', async () => {
    const { cmd, calls } = await boot();
    await cmd.dispatchCommand('/run echo hi');
    await flush();
    expect(calls.some((u) => u.includes('/api/exec'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn'))).toBe(false);
    const blocks = doc.querySelectorAll('.exec-block');
    expect(blocks.length).toBe(1);
    expect(doc.querySelector('.exec-stream.out .exec-stream-body')?.textContent).toContain('hi');
    expect(doc.querySelector('.exec-code')?.textContent).toContain('退出码 0');
    expect(doc.querySelector('.exec-dur')?.textContent).toContain('12');
  });

  it('端点缺失（404）→ 可读提示，不静默', async () => {
    const { cmd } = await boot();
    vi.stubGlobal('fetch', async (url: unknown) => String(url).includes('/api/exec') ? reply(404, { error: 'not found' }) : reply(200, { ok: true }));
    await cmd.dispatchCommand('/run echo hi');
    await flush();
    expect(doc.querySelector('.exec-note')?.textContent ?? '').not.toBe('');
  });

  it('/goal 设置可见（徽标/条）与 /goal done 清除', async () => {
    const { cmd } = await boot();
    await cmd.dispatchCommand('/goal 把 F2 做完');
    await flush();
    expect(doc.querySelector('.goal-bar .goal-text')?.textContent).toContain('把 F2 做完');
    await cmd.dispatchCommand('/goal done');
    await flush();
    expect(doc.querySelector('.goal-bar')?.classList.contains('hidden')).toBe(true);
  });

  it('未知命令给可读提示（不静默、不发 turn）', async () => {
    const { cmd, calls } = await boot();
    const consumed = await cmd.dispatchCommand('/nope');
    await flush();
    expect(consumed).toBe(true);
    expect(calls.some((u) => u.includes('/api/turn'))).toBe(false);
    expect(doc.querySelector('.msg.info')?.textContent ?? '').toContain('没有这个命令');
  });
});
