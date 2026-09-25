// @vitest-environment node
/**
 * W1297 · composer 扁平化门禁（用户：「会话框和状态栏合并为一个大会话框，无分界，
 * 扁平化无视觉噪声」）。
 *
 * 背景：.chat-shell 里原本有三层「小框」在制造视觉噪声 ——
 *   ① #input 自带 1px 描边 + 灰底（base.css 的 textarea 默认样式）；
 *   ② .sl-effort / .sl-mode / .sl-grant（原还有 .sl-perm，W1517 入口合并后已删）/
 *      .sl-mode-btn / .sl-stop 各带 1px 描边；
 *   ③ .sl-tps / .sl-cache / .sl-steps 各带灰底胶囊（--c-layer-2）。
 * 结果：一个扁平大框里套着七八个描边/灰底小方块，用户读到的不是「一个框」。
 *
 * 本文件是**机械门禁**（纯 fs 扫描，不依赖 jsdom 排版）：把「composer 内不再出现
 * 内层描边 / 胶囊底色」钉成断言。像素级观感由真机截图复验（见报告）。
 *
 * 为什么必须是机械的：这条不变量很容易在后续加功能时被无意破坏（例如新加一个
 * 状态项时顺手给了 border），而它只在真机截图里才看得出来 —— 正是 AGENT.md 铁律 3
 * 「只数 DOM 节点会让不可见的 bug 全绿通过」要防的那类。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');
/** 读文件并**剥掉注释** —— 注释里常出现 border-top: 之类字样，不剥会误判。 */
const css = (f: string): string =>
  readFileSync(join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 取某选择器**最后一条**规则体。选择器按「整段精确匹配」比较（空白归一化）——
 * 不能用子串正则：`#input` 会命中 `.input-box #input`，取到错误的规则体。
 */
function rule(text: string, selector: string): string {
  const want = selector.trim().replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? '').trim().replace(/\s+/g, ' ') === want) hits.push(m[2] ?? '');
  }
  expect(hits.length, '找不到规则：' + selector).toBeGreaterThan(0);
  return hits[hits.length - 1] ?? '';
}

/** 该规则体是否声明了可见边框（border: none / border: 0 不算）。 */
function hasVisibleBorder(decls: string): boolean {
  for (const decl of decls.split(';')) {
    const [rawProp, ...rest] = decl.split(':');
    const prop = (rawProp ?? '').trim();
    if (!/^border(-(top|right|bottom|left))?$/.test(prop)) continue;
    const val = rest.join(':').trim();
    if (/^none\b/.test(val) || /^0(px)?\b/.test(val)) continue;
    return true;
  }
  return false;
}

describe('W1297 · composer 扁平化：内层不再有描边', () => {
  it('#input 去底色 + 去描边（文字直接坐在 composer 表面上）', () => {
    const decls = rule(css('layout.css'), '#input');
    expect(decls, '#input 不得再自成一格：去掉描边').toMatch(/border:\s*none/);
    expect(decls, '#input 不得再有独立底色').toMatch(/background:\s*transparent/);
  });

  it('statusline 的档位/工作方式/车道：无描边（停止键 W1512 已移入输入栏）', () => {
    // W1513：工作方式已从「文字胶囊」改成风格化图标 —— 它与 .sl-effort 不再共用规则，
    // 故各自断言（.sl-mode 只声明几何，无描边这一点必须仍然成立）。
    for (const sel of ['.sl-effort', '.sl-mode', '.sl-mode-btn']) {
      const decls = rule(css('statusline.css'), sel);
      expect(hasVisibleBorder(decls), sel + ' 不得再有描边（扁平化）').toBe(false);
    }
  });

  it('statusline 的吞吐/缓存/步数：无灰底胶囊', () => {
    const decls = rule(css('statusline.css'), '.sl-tps, .sl-steps, .sl-cache');
    expect(decls, '数值不再垫灰底小方块').not.toMatch(/background/);
  });

  it('权限入口（W1517 合并后只剩盾牌一个）与其档位徽标格：无描边', () => {
    // W1517：档位不再有自己的按钮（.sl-perm 已删）—— 入口是唯一的 .sl-grant，
    // 档位名住它的徽标区（.sl-grant-tier）。断言语义未变：这两个可见元素都不得有描边。
    expect(hasVisibleBorder(rule(css('grants.css'), '.sl-grant')), '.sl-grant 不得再有描边').toBe(false);
    expect(hasVisibleBorder(rule(css('grants.css'), '.sl-grant-tier')), '.sl-grant-tier 不得再有描边').toBe(false);
    expect(hasVisibleBorder(rule(css('grants.css'), '.sl-grant-badge')), '.sl-grant-badge 不得再有描边').toBe(false);
  });

  it('附件入口：无描边（改用柔和圆底）', () => {
    const decls = rule(css('layout.css'), '#btnAttach.attach-inline');
    expect(hasVisibleBorder(decls), '#btnAttach 不得再有描边').toBe(false);
    expect(decls, '附件入口 = 无边框圆底图标').toMatch(/border-radius:\s*50%/);
  });

  it('#statusbar 与 #statusline 之间无分界线（无 border-top / border-bottom）', () => {
    const bar = rule(css('layout.css'), '#statusbar');
    expect(bar, '消息框与 statusline 的分界线必须没有').not.toMatch(/border-top\s*:/);
    const line = rule(css('statusline.css'), '#statusline,\n.statusline');
    expect(line, '#statusline 自身也不得画下边线').not.toMatch(/border-bottom\s*:/);
  });

  it('外框仍保留唯一的发丝线（合并成「一个」大框，而不是没有框）', () => {
    const shell = rule(css('layout.css'), '.chat-shell');
    expect(shell, '合并后的唯一可见边界 = 外框发丝线').toMatch(/border:\s*var\(--hairline\) solid var\(--border-l1\)/);
    expect(shell).toMatch(/background:\s*var\(--bg-layer-1\)/);
  });
});

/* ============================================================================
   W1466 增量：**运行态（插话）不得给输入条加任何装饰**。
   ----------------------------------------------------------------------------
   用户报障（原话）：「发完消息，输入框又变成了图片所示，噪声很大，不应该有变化才对」。
   根因：W1297/W1462 刚把 composer 扁平化，views.css 里 W514 的三条运行态规则没跟着改 ——
   发送后 #inputbar.interject 加内阴影线、#inputbar.interject #input 把描边 + 底色加回来、
   ::before 再补一个「插话」伪标签，于是扁平大框又退化回「一个框里套一个小框」。

   为什么必须机械：既有测试只断言 class 切换 / placeholder 文案 / DOM 结构不变
   （frontend-batch-a-dom、w846-composer-invariant），**没有一条碰样式** ——
   正是 AGENT.md 铁律 3「只数 DOM 节点会让不可见的 bug 全绿通过」要防的那类。

   几何为什么用声明式证明：jsdom 不应用外部样式表、不排版，所以「两态盒高相同」在这里
   用 box-sizing:border-box 下的声明式几何钉死：盒高 = max(min-height 96px, scrollHeight)，
   而 scrollHeight = 上下内边距 12+40 + 行数×行高（14px 字号约 20px）—— 一行 ≈ 72px、
   两行 ≈ 92px，**都被 96px 的下限吸收**，两态因此同高。一旦运行态加回 1px 描边，
   border-box 下正文盒宽高各缩 2px：宽缩 2px 让窄窗里的长 placeholder 更容易多折一行，
   高缩 2px 又把这行推过 96px 的下限 ⇒ 盒高被 autoGrow 顶上去（用户看到的「又变了」）。
   ========================================================================== */

/** 某选择器的声明表（后写的覆盖先写的）；无规则 ⇒ 空表。 */
function decls(text: string, selector: string): Map<string, string> {
  const want = selector.trim().replace(/\s+/g, ' ');
  const out = new Map<string, string>();
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? '').trim().replace(/\s+/g, ' ') !== want) continue;
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

/** 全部样式真源里「选择器带 interject 态**且命中输入条**」的规则（跨文件兜底）。 */
function interjectInputRules(): string[] {
  const hits: string[] = [];
  for (const f of readdirSync(STYLES)) {
    if (!f.endsWith('.css')) continue;
    const text = css(f);
    for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = (m[1] ?? '').trim().replace(/\s+/g, ' ');
      if (sel.includes('interject') && /#input\b|#inputbar\b/.test(sel)) hits.push(f + ' :: ' + sel);
    }
  }
  return hits;
}

describe('W1466 · 运行态（插话）不给输入条加装饰：idle 与 interject 视觉一致', () => {
  it('全站样式真源：没有任何 interject 选择器命中 #input / #inputbar（含伪元素）', () => {
    expect(interjectInputRules(), '运行态不得给输入条加样式（用户：不应该有变化）').toEqual([]);
  });

  it('#input 外观两态同源：恒无描边、恒无底色，且无运行态覆盖', () => {
    const input = decls(css('layout.css'), '#input');
    expect(input.get('border'), '扁平化不变量：输入框恒无描边').toBe('none');
    expect(input.get('background'), '扁平化不变量：输入框恒无底色').toBe('transparent');
    expect(decls(css('views.css'), '#inputbar.interject #input').size, '运行态描边/底色覆盖已删除').toBe(0);
  });

  it('#inputbar 本体不随运行态变化（无内阴影线 / 无描边 / 无底色覆盖）', () => {
    expect(decls(css('views.css'), '#inputbar.interject').size, 'W514 的内阴影线已删除').toBe(0);
    expect(decls(css('views.css'), '#inputbar.interject::before').size, '「插话」伪标签已删除').toBe(0);
    expect(decls(css('layout.css'), '#inputbar').get('box-shadow'), '输入条本体恒无阴影').toBeUndefined();
  });

  it('几何等价（声明式）：border-box 下两态盒高都 = min-height 96px', () => {
    const input = decls(css('layout.css'), '#input');
    expect(decls(css('base.css'), '*').get('box-sizing'), '全局 border-box（下面算术的前提）').toBe('border-box');
    expect(input.get('min-height'), '输入框高 = 96px，两态同源').toBe('96px');
    expect(input.get('height'), '不写显式 height：高度只由 min-height 决定').toBeUndefined();
    expect(input.get('border'), 'border none ⇒ 两态正文盒宽高都不缩').toBe('none');
    const pad: Array<[string, string]> = [
      ['padding-top', '12px'], ['padding-right', '8px'], ['padding-bottom', '40px'], ['padding-left', '8px'],
    ];
    for (const [prop, want] of pad) expect(input.get(prop), prop + ' 两态同源').toBe(want);
    // 无运行态覆盖 ⇒ 上面这些声明在两态下逐条相同（见下一条的机械兜底）
    expect(interjectInputRules()).toEqual([]);
  });

  it('保留项：消息气泡的运行态样式不动（用户只点名输入框）', () => {
    const bubble = decls(css('views.css'), '.msg.user.interject .bubble');
    expect(bubble.get('border'), '插话消息气泡仍可辨识').toContain('var(--c-border-strong)');
    expect(bubble.get('background')).toBe('var(--c-surface)');
  });
});
