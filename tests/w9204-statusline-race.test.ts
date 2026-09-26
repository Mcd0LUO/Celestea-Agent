// @vitest-environment jsdom
/**
 * W9204 · statusline 的两条竞态/生命周期修复（真实模块 + 真实 DOM/事件路径）。
 *
 * ① P1-3 工作方式弹层的状态从**模块级单例**改为**按实例**（root = #statusline）：
 *    · modePopupHit / closeModePopup 收 root ⇒ 第二个 Statusline 实例的弹层不被第一个
 *      认成自己的。**这一条有变异负控制**：把 hit 改回「忽略 root、看全部开着的实例」
 *      即变红（见报告 M7）。
 *    · overlay 的 close 闭包带**对象同一性守卫**（防御性，见报告「刻意没做什么」）：
 *      这条**没有**测试覆盖 —— 把守卫删掉本文件仍全绿（M9），因为通过公开 API 无法
 *      构造出「迟到的旧层 close」；报告如实标注为未覆盖，不当成已测。
 *
 * ② P1-4 refreshPermission 的请求序号守卫：
 *    同一会话上两次请求乱序返回时，先发的（旧的）**不得**覆盖后发的（新的）。
 *    旧实现只比 asked !== h.sessionId，两者都等于同一个会话 ⇒ 守卫形同虚设。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, el, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ModeMod {
  toggleModePopup(h: unknown): void;
  modePopupHit(e: unknown, root?: unknown): boolean;
  closeModePopup(root?: unknown): void;
}
interface OverlaysMod {
  overlayDepth(): number;
}

/** 造一个最小的 ModeHost（弹层只需要 root/sessionId/currentMode + 两个回调）。 */
function modeHost(root: ElLike, sessionId: string): Record<string, unknown> {
  return {
    root,
    sessionId,
    currentMode: 'standard',
    applyMode: () => undefined,
    setNote: () => undefined,
  };
}

describe('W9204 ① · 工作方式弹层的状态按实例隔离（P1-3）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('Esc 层与弹层一一对应：打开压一层、关闭归零、同一实例不累积', async () => {
    const mode = (await import(/* @vite-ignore */ at('statusline/mode.ts'))) as ModeMod;
    const overlays = (await import(/* @vite-ignore */ at('utils/overlays.ts'))) as OverlaysMod;
    const root = el('statusline');
    mode.toggleModePopup(modeHost(root, 'ws/s1'));
    expect(doc.querySelector('#statusline .sl-popup'), '弹层已打开').not.toBeNull();
    expect(overlays.overlayDepth(), 'Esc 层已压入').toBe(1);
    // 关闭：Esc 层必须回到 0，且没有残留节点。
    mode.closeModePopup(root);
    expect(overlays.overlayDepth(), '关闭后 Esc 层归零').toBe(0);
    expect(doc.querySelector('#statusline .sl-popup'), '关闭后无残留弹层').toBeNull();
    // 再开一次：仍恰好一层（不累积）。
    mode.toggleModePopup(modeHost(root, 'ws/s1'));
    expect(overlays.overlayDepth(), '重开仍恰好一层').toBe(1);
    mode.closeModePopup(root);
    expect(overlays.overlayDepth(), '再关归零').toBe(0);
  });

  it('modePopupHit 只认**本实例**的弹层：另一个实例的弹层不被误判', async () => {
    const mode = (await import(/* @vite-ignore */ at('statusline/mode.ts'))) as ModeMod;
    // 造第二个状态栏根（真实页面只有一个，这里只验证判定的实例归属）。
    const other = doc.createElement('div') as unknown as ElLike;
    other.id = 'statusline2';
    doc.body.appendChild(other);
    const rootA = el('statusline');
    mode.toggleModePopup(modeHost(rootA, 'ws/s1'));
    const popup = doc.querySelector('#statusline .sl-popup') as ElLike;
    const ev = { target: popup, composedPath: () => [popup] };
    expect(mode.modePopupHit(ev, rootA), '本实例命中').toBe(true);
    expect(
      mode.modePopupHit(ev, other),
      '另一个实例不得把这张弹层认成自己的（旧实现看模块级 popup ⇒ 误判）',
    ).toBe(false);
    // 另一个实例的 close 也不得关掉本实例的弹层。
    mode.closeModePopup(other);
    expect(doc.querySelector('#statusline .sl-popup'), '跨实例 close 不误关').not.toBeNull();
    mode.closeModePopup(rootA);
    expect(doc.querySelector('#statusline .sl-popup'), '本实例 close 生效').toBeNull();
  });
});

describe('W9204 ② · refreshPermission 的请求序号守卫（P1-4）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('同一会话上乱序返回：先发的旧快照不得覆盖后发的新快照', async () => {
    const perm = (await import(/* @vite-ignore */ at('statusline/permission.ts'))) as {
      refreshPermission(h: unknown): Promise<void>;
    };
    const applied: string[] = [];
    const host = {
      sessionId: 'ws/s1',
      currentPreset: '',
      applyPermission: (p: string) => { if (p !== '') applied.push(p); },
      setNote: () => undefined,
    };
    // 让 /permission 的第 1 次请求**慢**（40ms）、第 2 次**快**（立即）⇒ 乱序返回。
    // 用真实定时器（本用例不 fake 时间，避免把夹具的 flush 一起冻住）。
    const realFetch = globalThis.fetch as unknown as (u: unknown, i?: unknown) => Promise<unknown>;
    let n = 0;
    vi.stubGlobal('fetch', (u: unknown, i?: unknown) => {
      if (!/\/permission$/.test(String(u))) return realFetch(u, i);
      n += 1;
      const which = n;
      const preset = which === 1 ? 'read-only' : 'full-access';
      const resp = { ok: true, status: 200, json: async () => ({ ok: true, session: 'ws/s1', preset, effective: {} }) };
      return which === 1
        ? new Promise((r) => { setTimeout(() => r(resp), 40); })
        : Promise.resolve(resp);
    });
    await Promise.all([perm.refreshPermission(host), perm.refreshPermission(host)]);
    expect(n, '两次请求都真的发出去了（否则本用例空转）').toBe(2);
    expect(applied, '只有最后一次请求有资格写回').toEqual(['full-access']);
  });
});
