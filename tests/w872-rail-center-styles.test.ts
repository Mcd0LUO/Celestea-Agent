/**
 * W872 · thread-rail 中间判定的**样式机械门禁**（纯 fs 扫描，不需要 jsdom）。
 *
 * 三条：
 *   ① 中间指示线的规则必须在 rail.css 里、且用**实线**（全站禁虚线：w847 的门禁
 *      扫 dashed/dotted 字样，这里对 rail.css 再钉一遍，防止有人给指示线加虚线）；
 *   ② 指示线的圆角只走 --r-* 刻度（复用 tests/w847-w8-styles.test.ts 的写法）；
 *   ③ 命中条 .is-center **只改颜色/描边**：规则块里不得出现任何几何属性
 *      （width/height/top/left/right/bottom/margin/padding/transform/inset），
 *      这是「与 fisheye 宽度解耦」的机械证据（行为侧另见 w872-rail-center.test.ts ④）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');
const RAIL = readFileSync(join(STYLES, 'rail.css'), 'utf8');
const TOKENS = readFileSync(join(STYLES, 'tokens.css'), 'utf8');

/** 取出某个选择器开头的规则块（到第一个右花括号为止；本文件规则都是平铺的）。 */
function ruleOf(css: string, selector: string): string {
  const i = css.indexOf(selector + ' {');
  expect(i, '必须存在规则：' + selector).toBeGreaterThan(-1);
  const end = css.indexOf('}', i);
  return css.slice(i, end);
}

describe('W872 · rail 中间判定 · 样式门禁', () => {
  it('指示线用实线：rail.css 里不出现虚线关键字', () => {
    const bad: string[] = [];
    RAIL.split('\n').forEach((line, i) => {
      if (/\b(dashed|dotted)\b/.test(line)) bad.push('rail.css:' + String(i + 1));
    });
    expect(bad).toEqual([]);
  });

  it('指示线规则存在：横向 1px 发丝线 + 单值定位 + 不挡指针', () => {
    const rule = ruleOf(RAIL, '.railv3-mid');
    expect(rule, '高度 = 1px 发丝').toMatch(/height:\s*1px/);
    expect(rule, '宽度跟着轨道走（--mid-w 由 layout 写入）').toContain('var(--mid-w');
    expect(rule, '交互统一走 #main 级监听').toMatch(/pointer-events:\s*none/);
    expect(rule, '绝对定位（位置由 JS 的 transform 单值写）').toMatch(/position:\s*absolute/);
  });

  it('指示线圆角只走 --r-*（不得出现硬编码 px 圆角，999px 胶囊除外）', () => {
    const bad: string[] = [];
    const rule = ruleOf(RAIL, '.railv3-mid');
    for (const m of rule.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
      const v = (m[1] ?? '').trim();
      if (/\d+px/.test(v) && !v.includes('999px')) bad.push('railv3-mid -> ' + v);
    }
    expect(bad).toEqual([]);
    expect(rule, '用语义圆角刻度').toContain('var(--r-');
    expect(TOKENS, '刻度本身仍在').toContain('--r-sm:');
  });

  it('命中条 .is-center 只改颜色/描边：规则块里没有任何几何属性', () => {
    const GEOM = /\b(width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|inset|margin|padding|transform|translate|scale|flex|gap)\b/;
    for (const sel of ['.railv3-item.is-center', '.railv3-item.railv3-fold.is-center']) {
      const rule = ruleOf(RAIL, sel);
      const decls = rule.slice(rule.indexOf('{') + 1);
      for (const decl of decls.split(';')) {
        const prop = (decl.split(':')[0] ?? '').trim();
        if (prop === '') continue;
        expect(GEOM.test(prop), sel + ' 不得改几何，出现：' + prop).toBe(false);
      }
      expect(rule, '只改颜色/描边').toMatch(/(background|box-shadow|color|border)/);
    }
  });

  it('端点兜底只是降对比（不改几何、不隐藏）', () => {
    const rule = ruleOf(RAIL, '.railv3-mid.is-out');
    expect(rule).toMatch(/opacity/);
    expect(rule, '端点态不得隐藏指示线').not.toMatch(/display:\s*none/);
    expect(rule, '端点态不得改几何').not.toMatch(/\b(width|height|top|left|transform)\b\s*:/);
  });
});
