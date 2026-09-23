// ============================================================================
// tests/w1468-text-level-blocks.test.ts — W1468：工具块 / 思考块 = **文字级**
// （无块边界）；上下文注入块**只缩小**（保留块边界）。
//
// 用户原话：「我们的工具块，思考块都太大了，改为文字级大小，无块边界
// （上下文注入块只缩小」。
//
// 为什么必须机械：这些是**纯视觉**约定，DOM 结构一个节点都不变 ——
// 任何只断言 class / 结构的测试都会全绿放行（AGENT.md 铁律 3）。所以这里直接
// 读样式真源，断言「块边界属性不存在」与「尺寸确实收紧」。
//
// 反面对照（同文件内）：上下文注入块**必须保留** border-left / background /
// border-radius —— 否则就是把「只缩小」误做成「也拍平」。
// ============================================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(ROOT, 'apps', 'web', 'src', 'styles');
/** 去掉 CSS 注释：注释里没有花括号，但 [^{}]+ 会把注释一起吞进「选择器」组，
 *  于是带注释的规则永远匹配不上。用纯字符串切分（不写正则，避免转义坑）。 */
function stripComments(text: string): string {
  const parts = text.split('/*');
  return parts
    .map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf('*/');
      return end < 0 ? '' : part.slice(end + 2);
    })
    .join('');
}

const css = (f: string): string => stripComments(readFileSync(join(STYLES, f), 'utf8'));

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

describe('W1468 · 工具块 = 文字级（无块边界）', () => {
  it('工具卡不再是一张有表面的卡：无底色 / 无圆角 / 无 gutter 内缩 / 字号与正文同级', () => {
    const card = decls(css('components.css'), '.toolcard');
    expect(card.get('background'), '不再有 code-block 表面').toBeUndefined();
    expect(card.get('border-radius')).toBeUndefined();
    expect(card.get('padding-left'), '不再有 gutter 内缩').toBeUndefined();
    expect(card.get('font-size')).toBe('var(--fs-secondary)');
    expect(card.get('line-height')).toBe('var(--lh-secondary)');
  });

  it('折叠行**不得**出现横向滚动条（展开时「一瞬间的滑动条」的根因）', () => {
    // 用户真机报障：「展开的时候会晃动」——真机 CDP 定位到根因：.toolcard-head 只写了
    // overflow-y: auto，而按 CSS 规范另一轴是 visible 时**会计算成 auto**，于是折叠行
    // 也带上了横向滚动；展开后 .toolcard-row1 的 width:100% 出现 1~2px 亚像素取整溢出
    // （实测 scrollWidth 670→671→672），浏览器冒出一条 10px 横向滚动条，头部 22→32px，
    // 下方内容整体下移 10px。折叠行是单行摘要，必须显式关掉横向滚动。
    const head = decls(css('components.css'), '.toolcard > summary.toolcard-head');
    expect(head.get('overflow-x'), '必须显式 hidden（不能靠另一轴计算）').toBe('hidden');
    expect(head.get('overflow-y'), '纵向仍保留 auto').toBe('auto');
  });

  it('卡片头行与正文之间没有块边界（发丝线全去）', () => {
    const head = decls(css('components.css'), '.toolcard > summary.toolcard-head');
    expect(head.get('border-bottom')).toBeUndefined();
    expect(head.get('border-top-left-radius')).toBeUndefined();
    expect(head.get('margin-left'), '不再为 gutter 做负边距回拉').toBeUndefined();
    expect(decls(css('components.css'), '.toolcard:not(.running) > .toolcard-head').size).toBe(0);
    expect(decls(css('components.css'), '.tool-out').get('border-top')).toBeUndefined();
    expect(decls(css('components.css'), '.toolcard-result-preview.has').get('border-top')).toBeUndefined();
  });

  it('状态不再是 Pill（无底色 / 无圆角 / 无固定行高）', () => {
    const st = decls(css('components.css'), '.toolcard-state');
    expect(st.get('background')).toBeUndefined();
    expect(st.get('border-radius')).toBeUndefined();
    expect(st.get('height')).toBeUndefined();
  });

  it('状态点仍是行内流，且**保留自身定位上下文**（伪元素不许被拉伸成整卡横条）', () => {
    // 真机踩过：把 .ts-dot 改成 position:static，其 ::before/::after 的 inset:0
    // 会改用 .toolcard 作定位祖先 → 光晕层被拉伸成一条深色横条。
    expect(decls(css('components.css'), '.ts-dot').get('position'), '::before/::after 依赖它').toBe('relative');
    expect(decls(css('components.css'), '.toolcard-row1 .ts-dot').size, '不再绝对定位出流').toBe(0);
  });

  it('子调用树里也不再给子卡加底色', () => {
    expect(decls(css('tooltree.css'), '.toolcard-subs .toolcard').size).toBe(0);
  });
});

describe('W1468 · 思考块 = 文字级（无块边界）', () => {
  it('思考正文不再是一个可滚动块（无 max-height / 无 overflow）', () => {
    const body = decls(css('components.css'), '.think-seg-body');
    expect(body.get('max-height')).toBeUndefined();
    expect(body.get('overflow-y')).toBeUndefined();
    expect(body.get('font-size')).toBe('var(--fs-secondary)');
  });

  it('子调用树的从属关系必须**看得见**：导引线不是近乎不可见的 hairline', () => {
    // 用户真机报障：「缩进关系似乎没了」。工具卡去掉底色后，父卡与子卡完全同形，
    // 导引线成了唯一的从属线索 —— 它原本用 --c-hairline-*（rgba(0,0,0,.09)，
    // 是为 0.5px 分隔线设计的近乎不可见色），于是树结构在视觉上消失。
    const subs = decls(css('tooltree.css'), '.toolcard-subs');
    const guide = subs.get('border-left') ?? '';
    expect(guide, '导引线必须存在').toContain('solid');
    expect(guide, '不得用 hairline 当唯一从属线索').not.toContain('--c-hairline');
    expect(Number.parseInt(subs.get('padding-left') ?? '0', 10), '缩进要够看出层级').toBeGreaterThanOrEqual(16);
  });

  it('思考头行不再占固定 24px 行高', () => {
    const head = decls(css('components.css'), '.msg.think-seg .think-head');
    expect(head.get('height')).toBe('auto');
    expect(head.get('line-height')).toBe('var(--lh-secondary)');
  });

  it('折叠提示住在**头行之内**（cap），不是独占第二行 —— 折叠段因此只占一行', () => {
    // 源码级断言：DOM 归属是纯结构事实，CSS 断言看不见它。回归点很具体——
    // 把提示挪回 bubble.appendChild 就等于恢复「折叠占两行」的旧形态。
    const src = readFileSync(join(ROOT, 'apps/web/src/ui/messages.ts'), 'utf8');
    expect(src).toMatch(/cap\.appendChild\(el\('span', 'think-seg-folded'/);
    expect(src).not.toMatch(/bubble\.appendChild\(el\('div', 'think-seg-folded'/);
    // 展开态默认不显示；折叠态是行内（不是 block，否则仍会另起一行）。
    expect(decls(css('components.css'), '.think-seg-folded').get('display')).toBe('none');
    expect(decls(css('components.css'), '.think-seg-folded').get('padding'), '不再有独占行的内边距').toBeUndefined();
    expect(decls(css('components.css'), '.msg.think-seg.collapsed .think-seg-folded').get('display')).toBe('inline');
  });
});

describe('W1468 · 上下文注入块只缩小（**保留**块边界）', () => {
  it('左侧语义条 / 底色 / 圆角都还在（没被误拍平）', () => {
    const info = decls(css('components.css'), '.info-bubble');
    expect(info.get('border-left'), '语义条保留').toContain('var(--c-warn)');
    expect(info.get('background'), '底色保留').toBe('var(--c-layer-2)');
    expect(info.get('border-radius'), '圆角保留').toBe('var(--r-md)');
  });

  it('尺寸确实收紧了（padding 8px12px→5px10px、字号 13→12.5）', () => {
    expect(decls(css('components.css'), '.info-bubble').get('padding')).toBe('5px 10px');
    expect(decls(css('components.css'), '.info-content').get('font-size')).toBe('12.5px');
    expect(decls(css('components.css'), '.info-content').get('line-height')).toBe('18px');
  });
});
