// @vitest-environment jsdom
/**
 * W867 · 用户 5（1/2）：助手输出铺满到用户消息的右缘 + 正文列宽由 --chat-col 单值决定。
 *
 * 为什么「右缘一致」可以被断言：jsdom 30 的 getComputedStyle 会走**真实级联**
 * （样式表 → 特异性 → 媒体查询），所以下面读到的 max-width 就是浏览器里生效的那条。
 * 几何模型（全部由断言固定住）：
 *   · 用户气泡：.msg.user{align-items:flex-end} + .bubble{margin-left:auto}
 *     ⇒ 气泡右缘 = .msg 右缘；
 *   · .msg 是 .mcol 的块级子元素 ⇒ 宽度 = .mcol 宽，且每轮各一个 .mcol、宽度口径相同；
 *   · 助手气泡：.msg.assistant{align-items:stretch} + .bubble{width:fit-content}
 *     ⇒ 右缘 = min(内容, max-width)。旧 72% ⇒ 比用户消息窄一截；新 100% ⇒ 同一右缘。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, WEB } from './lib/w795-dom.js';

const css = (name: string): string => readFileSync(join(WEB, 'src', 'styles', name), 'utf8');
const STYLES = ['tokens.css', 'components.css', 'views.css', 'responsive.css'] as const;

interface StyleNode {
  textContent: string;
}
interface Computed {
  maxWidth: string;
  marginLeft: string;
  alignItems: string;
  width: string;
}

function injectStyles(): void {
  const style = doc.createElement('style') as unknown as StyleNode;
  style.textContent = STYLES.map(css).join('\n');
  const head = (doc as unknown as { head: { appendChild(n: unknown): void } }).head;
  head.appendChild(style);
}

function computed(sel: string): Computed {
  const node = doc.querySelector(sel);
  if (!node) throw new Error('missing node: ' + sel);
  const g = (globalThis as unknown as { getComputedStyle(n: unknown): Computed }).getComputedStyle;
  return g(node);
}

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: unknown };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface MessagesMod {
  addUserMessage(p: unknown, text: string): unknown;
  ensureAssistant(p: unknown): unknown;
  appendText(p: unknown, v: unknown, delta: string): void;
}

/** 用真实模块渲染一条用户消息 + 一条助手消息（DOM 与线上同构）。 */
async function renderPair(): Promise<void> {
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  const m = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
  m.addUserMessage(pane, '用户消息');
  const view = m.ensureAssistant(pane);
  m.appendText(pane, view, '助手回复');
}

describe('W867 · 用户 5：助手输出铺满（真实级联）', () => {
  beforeEach(() => {
    resetHarness();
    injectStyles();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('助手气泡 max-width 不再被 72% 收窄：与用户气泡同一条右缘', async () => {
    await renderPair();
    expect(computed('.msg.user .bubble').maxWidth, '用户气泡仍是紧凑的 72%').toBe('72%');
    expect(computed('.msg.assistant .bubble').maxWidth, '助手气泡吃满正文列').toBe('100%');
    // 用户气泡的右缘 = .msg 右缘（这不是「列宽的一部分」，是 flex 末端对齐）
    expect(computed('.msg.user').alignItems).toBe('flex-end');
    expect(computed('.msg.user .bubble').marginLeft).toBe('auto');
    expect(computed('.msg.assistant').alignItems).toBe('stretch');
  });

  it('两轮 .mcol 口径相同 ⇒ 助手 100% 就是用户右缘所在的那条边', async () => {
    await renderPair();
    const cols = Array.from(doc.querySelectorAll('.mcol')) as unknown[];
    expect(cols.length, '一条用户消息 + 一条助手消息 = 两个 .mcol').toBe(2);
    const g = (globalThis as unknown as { getComputedStyle(n: unknown): Computed }).getComputedStyle;
    const caps = cols.map((c) => g(c).maxWidth);
    expect(new Set(caps).size, '正文列宽口径必须一致（否则「同一右缘」不成立）').toBe(1);
    const widths = cols.map((c) => g(c).width);
    expect(widths).toEqual(['100%', '100%']);
  });

  it('两侧留白只由列宽决定，且列宽 = 用户值优先 / 缺省回落原 clamp（可调 + 持久化接口）', () => {
    const tokens = css('tokens.css');
    // 缺省 token 一字未动（既有 token 契约测试仍在断言它）——
    expect(tokens, '缺省 clamp 原样保留').toContain('--chat-col: clamp(680px, 64%, 920px)');
    expect(tokens, '生效值 = 用户值优先、否则缺省').toContain(
      '--chat-col-live: var(--chat-col-user, var(--chat-col));',
    );
    expect(
      css('views.css'),
      '.sess-pane 左右内边距同一算式 ⇒ 改列宽 = 两侧留白同步放缩',
    ).toMatch(
      /padding:\s*var\(--sp-flow\)\s*max\(var\(--sp-composer-side\),\s*calc\(\(100%\s*-\s*var\(--chat-col-live\)\)\s*\/\s*2\)\);/,
    );
    expect(
      css('views.css'),
      '拖拽手柄与列缘同一算式（列宽一变它跟着走）',
    ).toMatch(
      /\.chatcol-resizer\s*\{[^}]*right:\s*calc\(max\(var\(--sp-composer-side\),\s*\(100%\s*-\s*var\(--chat-col-live\)\)\s*\/\s*2\)\s*-\s*5px\)/,
    );
    expect(
      css('responsive.css'),
      '窄屏降级：tablet 及以下隐藏手柄（那一档列宽固定 16/14）',
    ).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.chatcol-resizer\s*\{\s*display:\s*none\s*;?\s*\}/);
  });
});
