// @vitest-environment jsdom
/**
 * W847 W8 · 前端审美回归（apps/web）：
 *   ① styles 下不得出现 dashed / dotted（虚线一处不留）；
 *   ② 圆角只走 --r-sm/--r-md/--r-lg 刻度，不再有硬编码 px 圆角（999px 胶囊除外）；
 *   ③ 双 tooltip 防回归：hint 引擎认领后必须清掉原生 title —— 同一元素不得同时有
 *      data-hint 与 title（否则原生 1s 提示 + 150ms 卡片双弹）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');
const cssFiles = (): { name: string; text: string }[] =>
  readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(STYLES, f), 'utf8') }));

describe('W847 W8 · 样式机械门禁', () => {
  it('styles 下不得出现 dashed / dotted（虚线全删）', () => {
    const bad: string[] = [];
    for (const f of cssFiles()) {
      const lines = f.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && /\b(dashed|dotted)\b/.test(line)) bad.push(f.name + ':' + String(i + 1));
      }
    }
    expect(bad).toEqual([]);
  });

  it('圆角只走 --r-sm/--r-md/--r-lg（不再有硬编码 px 圆角；999px 胶囊除外）', () => {
    const bad: string[] = [];
    for (const f of cssFiles()) {
      for (const m of f.text.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
        const v = (m[1] ?? '').trim();
        if (/\d+px/.test(v) && !v.includes('999px')) bad.push(f.name + ' -> ' + v);
      }
    }
    expect(bad).toEqual([]);
    expect(readFileSync(join(STYLES, 'tokens.css'), 'utf8')).toContain('--r-sm: 6px');
  });
});

describe('W847 W8 · 双 tooltip 防回归', () => {
  beforeEach(() => {
    resetHarness();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('hint 引擎认领后同一元素只留 data-hint，不再挂原生 title', async () => {
    const hints = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as {
      initHints(): void;
      setHint(el: unknown, t: string): void;
    };
    hints.initHints();
    const node = doc.createElement('div') as ElLike;
    node.setAttribute('title', '原生兜底');
    hints.setHint(node, '卡片文案');
    expect(node.getAttribute('data-hint')).toBe('卡片文案');
    expect(node.getAttribute('title')).toBeNull();
  });

  it('会话树渲染后不存在同时带 data-hint 与 title 的元素', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.startsWith('/api/workspaces')) {
        return reply(200, { ok: true, workspaces: [{ name: 'ws' }], active_session: null });
      }
      if (u.startsWith('/api/sessions')) {
        return reply(200, { ok: true, sessions: [{ id: 'ws/s1', title: '甲', workspace: 'ws', modified: 1 }] });
      }
      return reply(200, { ok: true });
    });
    const hints = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
    hints.initHints();
    const sessions = (await import(/* @vite-ignore */ at('ui/sessions.ts'))) as { loadSessions(): Promise<void> };
    await sessions.loadSessions();
    await flush(4);
    const leaf = doc.querySelector('#sessionTree .sess-leaf') as ElLike | null;
    expect(leaf?.getAttribute('data-hint') ?? '').toContain('点击打开');
    expect(leaf?.getAttribute('title')).toBeNull();
    expect(Array.from(doc.querySelectorAll('[data-hint][title]')).length).toBe(0);
  });
});

describe('W847 W8/W12 · token 契约（三层 + 深色成对 + 语义圆角/间距）', () => {
  const tokens = (): string => readFileSync(join(STYLES, 'tokens.css'), 'utf8');
  it('存在语义圆角/间距/列宽/hairline token', () => {
    const t = tokens();
    for (const k of [
      '--r-bubble: 22px', '--r-dialog: 24px', '--r-menu: 20px', '--r-tip: 8px',
      '--sp-flow: 16px', '--sp-composer-side: 16px',
      '--chat-col: clamp(680px, 64%, 920px)', '--hairline: 0.5px',
    ]) {
      expect(t).toContain(k);
    }
  });
  it('深色 alias 成对覆盖（surface + foreground 都在 dark 块里）', () => {
    const t = tokens();
    const i = t.indexOf('[data-theme="dark"]');
    expect(i).toBeGreaterThan(-1);
    const block = t.slice(i, t.indexOf('}', i));
    expect(block).toContain('color-scheme: dark');
    expect(block).toContain('--s-gray-25:');
    expect(block).toContain('--s-gray-900:');
  });
  it('三层 token 齐备：static(--s-*) / alias(--bg-*/--label-*) / specific(--bubble-*)', () => {
    const t = tokens();
    for (const k of ['--s-gray-900', '--bg-base', '--label-primary', '--bubble-bg', '--tip-bg', '--input-bg']) {
      expect(t).toContain(k);
    }
  });
});

describe('W847 W12 · 「第 N 步」只有一个渲染点', () => {
  const SRC = join(STYLES, '..');
  const WEB_INDEX = join(STYLES, '..', '..', 'index.html');
  function walkTs(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkTs(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }
  it('底部 statusbar 的 statusStep 已删；只留 statusline #slSteps', () => {
    const html = readFileSync(WEB_INDEX, 'utf8');
    expect(html).not.toContain('statusStep');
    expect(html).toContain('slSteps');
    const offenders: string[] = [];
    for (const f of walkTs(SRC)) {
      const t = readFileSync(f, 'utf8');
      if (t.includes('statusStep') || t.includes('setStatusStep')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
