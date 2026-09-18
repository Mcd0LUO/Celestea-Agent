// @vitest-environment jsdom
/**
 * W847 W5 · 批量删除会话（apps/web 会话树）两个真实 DOM 回归：
 *   (a) 批量模式下点行 = 只切换勾选、**绝不打开**会话；点复选框不双触发；提示改「点击勾选」。
 *   (b) 「删除选中」成功后行**立即**消失且不因整树重载回来（不再 fetch /api/sessions）；
 *       部分失败时只把失败项**精确插回原位**并说明原因。
 * 用 jsdom + pathToFileURL 加载真实模块（ui/sessions.ts / sessiontree/*），驱动真实 DOM 事件；
 * 夹具沿用 tests/lib/w795-dom.ts（与 W795 乐观更新同一套骨架/助手）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, click, confirmOk, doc, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface El extends ElLike {
  checked: boolean;
}

const SESSIONS = [
  { id: 'ws/s1', title: '甲', workspace: 'ws', modified: 3 },
  { id: 'ws/s2', title: '乙', workspace: 'ws', modified: 2 },
  { id: 'ws/s3', title: '丙', workspace: 'ws', modified: 1 },
];

const q = (sel: string): El | null => doc.querySelector(sel) as unknown as El | null;
const qa = (sel: string): El[] => Array.from(doc.querySelectorAll(sel) as unknown as ArrayLike<El>);
const rowOf = (id: string): El | null => q('#sessionTree .sess-leaf[data-id="' + id + '"]');
const rowIds = (): string[] => qa('#sessionTree .sess-leaf').map((r) => r.dataset.id ?? '');
const checkOf = (id: string): El | null =>
  (rowOf(id)?.querySelector('.sess-check') as unknown as El | null) ?? null;
const deleteBtn = (): El | null => q('#sessionTree .sess-batchbar .btn-danger');
const footText = (): string => q('#sideFoot')?.textContent ?? '';

let sessionsGets = 0;
let activatePosts = 0;
let deleteResp: unknown = { ok: true, deleted: 2, failed: [] };

function installFetch(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u === '/api/workspaces' || u.startsWith('/api/workspaces?')) {
      return reply(200, { ok: true, workspaces: [{ name: 'ws' }], active_session: null });
    }
    if (method === 'GET' && (u === '/api/sessions' || u.startsWith('/api/sessions?'))) {
      sessionsGets += 1;
      return reply(200, { ok: true, sessions: SESSIONS });
    }
    if (u === '/api/sessions/batch-delete') return reply(200, deleteResp);
    if (method === 'POST' && /\/api\/sessions\/[^/]+\/activate$/.test(u)) {
      activatePosts += 1;
      return reply(200, { ok: true });
    }
    return reply(200, { ok: true });
  });
}

type SessionsMod = { loadSessions(): Promise<void> };
type StoreMod = {
  setBatchMode(v: boolean): void;
  getActiveSession(): string | null;
  getSessions(): { id?: string }[];
  selected: Set<string>;
};

/** 载入普通树 → 进入勾选模式 → 再渲染（叶子带 .sess-check）。 */
async function boot(): Promise<StoreMod> {
  const sessions = (await import(/* @vite-ignore */ at('ui/sessions.ts'))) as SessionsMod;
  const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as StoreMod;
  await sessions.loadSessions();
  store.setBatchMode(true);
  store.selected.clear();
  await sessions.loadSessions();
  return store;
}

beforeEach(() => {
  sessionsGets = 0;
  activatePosts = 0;
  deleteResp = { ok: true, deleted: 2, failed: [] };
  resetHarness(); // 骨架 + vi.resetModules + 基础 fetch 打桩
  installFetch();
  const foot = doc.createElement('div');
  foot.id = 'sideFoot';
  doc.body.appendChild(foot);
});

afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('W847 W5 · (a) 批量模式点行只勾选、不打开', () => {
  it('点行：勾选切换、不打开（active 不变、无 activate 请求）；提示为「点击勾选」', async () => {
    const store = await boot();
    const activeBefore = store.getActiveSession();
    const leaf = rowOf('ws/s1') as El;
    expect(leaf.getAttribute('data-hint') ?? '').toContain('点击勾选');
    click(leaf.querySelector('.sess-leaf-name') as El, true);
    await flush(6);
    expect(store.selected.has('ws/s1')).toBe(true);
    expect(checkOf('ws/s1')?.checked).toBe(true);
    expect(store.getActiveSession()).toBe(activeBefore);
    expect(activatePosts).toBe(0);
  });

  it('点复选框：只切一次勾选，不打开（双触发会把它切回去）', async () => {
    const store = await boot();
    const before = store.selected.has('ws/s1');
    const cb = checkOf('ws/s1') as El;
    cb.click();
    await flush(6);
    expect(store.selected.has('ws/s1')).toBe(!before);
    expect(cb.checked).toBe(!before);
    expect(store.getActiveSession()).toBeNull();
    expect(activatePosts).toBe(0);
  });
});

describe('W847 W5 · (b) 删除选中：就地移除、不因重载画回；失败精确插回', () => {
  it('成功：行立即消失，且不触发整树重载（旧列表画不回来）', async () => {
    const store = await boot();
    click(rowOf('ws/s1')?.querySelector('.sess-leaf-name') as El, true);
    click(rowOf('ws/s2')?.querySelector('.sess-leaf-name') as El, true);
    await flush(4);
    expect(store.selected.size).toBe(2);
    const before = sessionsGets;
    click(deleteBtn(), true);
    await flush(4);
    click(confirmOk(), true);
    await flush(24);
    expect(rowOf('ws/s1')).toBeNull();
    expect(rowOf('ws/s2')).toBeNull();
    expect(sessionsGets).toBe(before); // 没有整树重载
    expect(store.selected.size).toBe(0);
    expect(q('#sessionTree .sess-check')).toBeNull(); // 已退出勾选模式
    expect(footText()).toContain('已删除');
  });

  it('部分失败：成功的行不回来、失败项插回原位、保持勾选并说明原因', async () => {
    const store = await boot();
    const order = rowIds();
    click(rowOf('ws/s1')?.querySelector('.sess-leaf-name') as El, true);
    click(rowOf('ws/s2')?.querySelector('.sess-leaf-name') as El, true);
    await flush(4);
    deleteResp = { ok: true, deleted: 1, failed: [{ id: 'ws/s2', error: 'unknown session' }] };
    click(deleteBtn(), true);
    await flush(4);
    click(confirmOk(), true);
    await flush(24);
    expect(rowOf('ws/s1')).toBeNull(); // 真删的没被画回
    expect(rowOf('ws/s2')).not.toBeNull(); // 失败项插回
    expect(rowIds()).toEqual(order.filter((id) => id !== 'ws/s1')); // 精确原位
    expect(store.selected.has('ws/s2')).toBe(true);
    expect(store.selected.has('ws/s1')).toBe(false);
    expect(footText()).toContain('删除失败');
  });
});
