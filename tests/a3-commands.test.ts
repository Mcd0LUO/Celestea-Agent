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

interface GoalRequest { url: string; method: string; body: Record<string, unknown> }

/**
 * W9209：这条 stub 过去对**任何**以 `/goal` 结尾的 URL 都回捏造的 200，
 * 于是 `/goal` 的后端端点根本不存在也测不出来（F-01 被它掩盖了整整一轮）。
 *
 * 现在它按**真实契约**应答（`contracts/endpoints.json#post_session_goal`）：
 *   · 只认**确切路径** `/api/sessions/<id>/goal`（POST）——路径写错 = 404，
 *     而不是「只要尾巴对就成功」；
 *   · 请求体必须是 `{text: string}`，否则 422（契约的 422 文案）；
 *   · 非空 text 回 `{ok,session,goal:{text,createdAt,updatedAt}}`；
 *     空/纯空白 text 回 `{ok,session,goal:null}`（契约的清除语义）；
 *   · 其余一切（含未知的 /api/... 路径）如实 404 —— 绝不「什么都说成功」。
 */
function contractFetch(calls: string[], goalRequests: GoalRequest[]) {
  return async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/exec')) return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hi\n', stderr: '', duration_ms: 12, sandbox: { provider: 'userspace', net_isolated: true, tmp_private: true, seccomp: false } });
    if (/^\/api\/sessions\/.+\/goal$/.test(u)) {
      const method = String(init?.method ?? 'GET');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      goalRequests.push({ url: u, method, body });
      if (method !== 'POST') return reply(405, { error: 'not allowed' });
      if (typeof body['text'] !== 'string') return reply(422, { ok: false, error: "field 'text' must be a string" });
      const text = body['text'];
      const session = decodeURIComponent((/^\/api\/sessions\/(.+)\/goal$/.exec(u) as RegExpExecArray)[1] as string);
      return reply(200, { ok: true, session, goal: text.trim() === '' ? null : { text: text.trim(), createdAt: 'a', updatedAt: 'b' } });
    }
    if (u.includes('/api/turn')) return reply(200, { ok: true, turn: 1 });
    return reply(404, { error: 'not found' });
  };
}

describe('A3 · 斜杠命令补全框 + 派发', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{
    cmd: CmdMod;
    ctx: unknown;
    input: ElLike;
    calls: string[];
    goalRequests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
  }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const calls: string[] = [];
    const goalRequests: GoalRequest[] = [];
    vi.stubGlobal('fetch', contractFetch(calls, goalRequests));
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
    cmd.installCommands();
    const input = doc.getElementById('input') as ElLike;
    return { cmd, ctx: pane, input, calls, goalRequests };
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

  /**
   * W9209（F-01 的掩盖机制）：这条用例把上一轮审计指出的假 mock 钉死。
   * 它断言的是**请求本身与真实契约一致**（确切路径 / POST / body 形状），
   * 而不是"界面看起来对了"。若前端把路径改成契约里不存在的地址，
   * 上面那条 stub 会如实回 404 ⇒ 本用例必红。
   */
  it('/goal 打到契约里的确切端点，且请求体是 {text}（设置与清除各一次）', async () => {
    const { cmd, goalRequests } = await boot();
    await cmd.dispatchCommand('/goal 把 F2 做完');
    await flush();
    await cmd.dispatchCommand('/goal done');
    await flush();
    expect(goalRequests).toHaveLength(2);
    for (const req of goalRequests) {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/sessions/' + encodeURIComponent('ws/s1') + '/goal');
      expect(Object.keys(req.body)).toEqual(['text']);
    }
    expect(goalRequests[0]?.body['text']).toBe('把 F2 做完');
    // 'done' 是清除：前端必须发空串，而不是某个 "done" 字面量。
    expect(goalRequests[1]?.body['text']).toBe('');
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
