// @vitest-environment jsdom
/**
 * W1462 · composer 底栏信息平铺 + 输入框撑开（机械门禁）。
 *
 * 用户原话：「会话 xxx 空闲 token速度，第xx轮 放到消息框胶囊外的底部平铺 灰色不显眼；
 * 空闲的空间由输入框撑开（左右极窄 padding，上下撑开）」。
 *
 * 两条不变量，都用**真实 index.html** + **真实 CSS 真源**钉死（纯 fs/jsdom 扫描，
 * 不依赖排版；像素级观感由真机 CDP 截图复验，数字见报告）：
 *   ① 信息在胶囊**之外**：低频状态（#sessionBar/#slTps/#slCache/#slSteps/#statusDot/
 *      #statusText/#statusTurn/#statusTime）全部住在 #statusbar，而 #statusbar 不是
 *      .chat-shell 的后代；#statusbar 同时是 #main 的直接子项（结构上恒在胶囊下方）。
 *   ② 输入框撑开：左右 padding 收到极窄、min-height 明显大于旧值 52px。
 *
 * 为什么必须机械：这两条都是「改一个数字就悄悄回退」的形态约束 —— 真机截图看得出，
 * 但只在提交时跑一次；后续任何一次样式微调都可能把它们改回去而没人发现（AGENT.md
 * 铁律 2/3：只数 DOM 节点会让不可见的 bug 全绿通过）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { doc, resetHarness } from './lib/w795-dom.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const css = (rel: string): string =>
  readFileSync(join(WEB, 'src', 'styles', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const indexHtml = (): string => readFileSync(join(WEB, 'index.html'), 'utf8');

/** 取某选择器**最后一条**规则体（后写的规则才生效）。 */
function rule(text: string, selector: string): string {
  const want = selector.trim().replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? '').trim().replace(/\s+/g, ' ') === want) hits.push(m[2] ?? '');
  }
  expect(hits.length, '找不到规则：' + selector).toBeGreaterThan(0);
  return hits[hits.length - 1] ?? '';
}

/** 该规则体的某条声明值（数字），例如 px('min-height') → 96。 */
function px(decls: string, prop: string): number {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([0-9.]+)px').exec(decls);
  expect(m, prop + ' 必须是 px 数值（当前规则体：' + decls.trim() + '）').not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

/**
 * 规则体的**左**内边距：优先 padding-left，否则解析 padding 简写
 * （1 值 → 四边相同；2 值 → 上下 左右；3 值 → 上 左右 下；4 值 → 上 右 下 左）。
 */
function padLeft(decls: string): number {
  // NB：正则**字面量**里写 \s（不是 \\s）—— 转义只对 new RegExp 的字符串形式需要。
  const one = /(?:^|;)\s*padding-left\s*:\s*([0-9.]+)px/.exec(decls);
  if (one?.[1] !== undefined) return Number(one[1]);
  const m = /(?:^|;)\s*padding\s*:\s*([^;]+)/.exec(decls);
  const shorthand = m?.[1];
  expect(shorthand, 'padding 简写必须在（当前规则体：' + decls.trim() + '）').toBeDefined();
  const parts = String(shorthand).trim().split(/\s+/).map((v) => Number.parseFloat(v));
  if (parts.length === 1) return parts[0] as number;
  if (parts.length === 2 || parts.length === 3) return parts[1] as number;
  return parts[3] as number;
}

/** 真实 index.html 的 <body>。 */
function useRealBody(): void {
  const raw = indexHtml();
  doc.body.innerHTML = raw.slice(raw.indexOf('<body>') + 6, raw.indexOf('</body>'));
}

/** 低频状态信息的全部 id（用户点名的四项 + 同一行的连接态/耗时）。 */
const DOCK_IDS = ['sessionBar', 'slTps', 'slCache', 'slSteps', 'statusDot', 'statusText', 'statusTurn', 'statusTime'];

describe('W1462 ① · 低频状态信息住在胶囊之外（贴底平铺）', () => {
  beforeEach(() => resetHarness());

  it('真实 index.html：信息全部在 #statusbar 内，而 #statusbar 不是 .chat-shell 的后代', () => {
    useRealBody();
    const shell = doc.querySelector('.chat-shell');
    const dock = doc.getElementById('statusbar');
    expect(shell, '#main 里必须仍有 .chat-shell').not.toBeNull();
    expect(dock, '贴底信息行 #statusbar 必须在').not.toBeNull();
    expect(dock?.closest('.chat-shell'), '信息行必须在胶囊**之外**（用户：胶囊外的底部平铺）').toBeNull();
    expect(dock?.parentElement?.id, '信息行 = #main 的直接子项（结构上恒在胶囊下方）').toBe('main');
    for (const id of DOCK_IDS) {
      const node = doc.getElementById(id);
      expect(node, '#' + id + ' 必须在（id 是运行时/行为测试的取节点真源）').not.toBeNull();
      expect(node?.closest('#statusbar'), '#' + id + ' 必须收进贴底信息行').not.toBeNull();
    }
  });

  it('胶囊只圈 statusline + inputbar；两行信息不再挤在胶囊里', () => {
    useRealBody();
    const shell = doc.querySelector('.chat-shell') as unknown as { children: ArrayLike<{ id: string }> };
    const kids = Array.from(shell.children).map((c) => c.id || '');
    expect(kids, '胶囊 = 模型行 + 输入行（低频信息已移出）').toEqual(['statusline', 'inputbar']);
    // 旧的「第 2 行」宿主不再存在：会话条/吞吐/缓存/步数已不靠 .sl-row-sub 定位
    for (const sel of ['.sl-row-sub']) {
      expect(doc.querySelector(sel), sel + ' 已随信息行移出而删除').toBeNull();
    }
  });

  it('运行时取节点：已移出的三项由 ./statusline/dock.ts 以 document 作用域取（真实事故：作用域没放开 ⇒ 整页白屏）', () => {
    const dockSrc = readFileSync(join(WEB, 'src', 'statusline', 'dock.ts'), 'utf8');
    const slSrc = readFileSync(join(WEB, 'src', 'statusline.ts'), 'utf8');
    for (const id of ['slTps', 'slCache', 'slSteps']) {
      // 作用域写死成 #statusline 时，这三项已不在其中 ⇒ need() 当场抛 "missing element"，
      // 模块加载失败、整页白屏（W1462 实测踩到）。取节点收口在 dock.ts，必须是 document 作用域。
      expect(dockSrc, '#' + id + ' 必须由贴底信息行模块取（调用点收口）').toContain("needCell('" + id + "')");
      expect(slSrc, '#' + id + ' 不得再被 statusline.ts 以 #statusline 作用域取').not.toContain("need<HTMLElement>('#" + id + "', this.el)");
    }
    // 取法本身必须是 document 作用域：写成 '#statusline #' + id 会**安静地**取不到
    // （querySelector 返回 null ⇒ needCell 抛，白屏依旧）—— 断言钉在实现上，不只钉调用点。
    expect(dockSrc, 'needCell 的实现必须是 document 作用域').toContain('document.getElementById(id)');
    expect(dockSrc, '不得把查找限定回 #statusline').not.toContain("querySelector('#statusline #'");
    // 降对比必须打到实际宿主（#statusbar）：宿主写在 dock.ts，statusline.ts 调用它
    expect(dockSrc, 'stale 降对比打到贴底信息行的实际宿主').toContain("getElementById('statusbar')");
    // 两个方向都要接线：只查 'this.dock.setStale(' 会被复位那一处满足，删除置位调用也照样绿
    // （变异负控制实测踩到）⇒ 逐条钉死。
    expect(slSrc, 'statusline.ts 必须在失败分支置位降对比').toContain('this.dock.setStale(true)');
    expect(slSrc, 'statusline.ts 必须在成功分支复位降对比').toContain('this.dock.setStale(false)');
  });

  it('CSS 真源：信息行灰、小、无背景无描边无分隔线（"不显眼"）', () => {
    const bar = rule(css('layout.css'), '#statusbar');
    expect(bar, '灰 = tertiary（--c-text-3），不得用 --c-text-1/--c-text-2').toContain('color: var(--c-text-3)');
    expect(bar, '不得再铺 composer 表面色（会读成「胶囊的延伸」）').not.toMatch(/background:\s*var\(--composer-bg\)/);
    expect(bar, '无背景（平铺在页面底色上）').toMatch(/background:\s*none/);
    expect(bar, '小字号（≤11px）').toMatch(/font-size:\s*(10|10\.5|11)px/);
    for (const prop of ['border-top', 'border-bottom', 'border', 'border-left', 'border-right']) {
      expect(bar, '不得有 ' + prop + '（无描边/无分隔线）').not.toContain(prop + ':');
    }
    // 会话条整条同灰：会话名不再用 --c-text-1 加重
    const name = rule(css('views.css'), '.sess-bar-name');
    expect(name, '会话名随信息行同灰（tertiary）').toContain('color: inherit');
    expect(name, '会话名不再加重').not.toMatch(/font-weight:\s*600/);
  });
});

describe('W1462 ② · 输入框撑开（左右极窄、上下撑开）', () => {
  beforeEach(() => resetHarness());

  it('CSS 真源：#inputbar 左右内边距极窄（≤6px），#input 上下撑开（min-height ≥ 84px）', () => {
    const bar = rule(css('layout.css'), '#inputbar');
    // 显式四条声明：左右 6px（旧值 14px）；上 2px（W1464：贴向 statusline）
    expect(bar, '输入栏左右收到极窄').toMatch(/padding-right:\s*6px/);
    expect(bar, '输入栏左右收到极窄').toMatch(/padding-left:\s*6px/);
    // W1464：statusline 盒底 → 正文顶 = 上内边距 2 + #input 的 padding-top 12 = 14px
    expect(px(bar, 'padding-top') + px(rule(css('layout.css'), '#input'), 'padding-top'), '正文顶距 statusline ≈ 两个英文字符（≤ 16px）').toBeLessThanOrEqual(16);
    const input = rule(css('layout.css'), '#input');
    expect(px(input, 'min-height'), '输入框明显高于旧值 52px（上下撑开，成为视觉主体）').toBeGreaterThanOrEqual(84);
    expect(px(input, 'min-height'), '不设成无限高（仍受 --composer-text-max-h 约束）').toBeLessThanOrEqual(160);
    expect(padLeft(bar), '输入栏左右内边距 ≤ 6px（"极窄"）').toBeLessThanOrEqual(6);
    // W1463：正文左缘贴近胶囊边界（≈ 一个英文字符），附件键的让位改由下内边距承担。
    const box = rule(css('layout.css'), '.input-box #input');
    expect(padLeft(box), '正文左内边距收到极窄（≤ 6px）').toBeLessThanOrEqual(6);
    expect(padLeft(bar) + padLeft(box), '正文左缘距胶囊边界 ≈ 一个英文字符（≤ 12px）').toBeLessThanOrEqual(12);
    // 附件键（28px 高 + 6px 底距 = 34px）的让位必须在**下内边距**里，否则多行文字会压到它
    expect(px(rule(css('layout.css'), '#input'), 'padding-bottom'), '底部留出附件键高度').toBeGreaterThanOrEqual(34);
    // 触摸档（≤1024 / ≤640 共用）：同样撑开，不是 44px 的触控下限
    const tablet = css('responsive.css');
    expect(tablet, '触摸档输入框同样上下撑开').toMatch(/#input\s*\{\s*min-height:\s*84px;\s*\}/);
  });

  it('输入框仍无底色无描边（W1297 扁平化不变量不被本次改动破坏）', () => {
    const input = rule(css('layout.css'), '#input');
    expect(input).toMatch(/border:\s*none/);
    expect(input).toMatch(/background:\s*transparent/);
  });
});
