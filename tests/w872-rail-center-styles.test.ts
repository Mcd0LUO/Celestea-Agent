/**
 * W872/W886 · thread-rail 中间判定的**样式机械门禁**（纯 fs 扫描，不需要 jsdom）。
 *
 * 三条：
 *   ① W886 用户否掉了中间指示线 ⇒ rail.css 里**不得再有任何指示线规则**（类名/变量）；
 *   ② rail.css 里不出现虚线关键字（全站禁虚线：w847 的门禁扫 dashed/dotted 字样，
 *      这里对 rail.css 再钉一遍）；
 *   ③ 命中条 .is-center **只改颜色/描边**：规则块里不得出现任何几何属性
 *      （width/height/top/left/right/bottom/margin/padding/transform/inset），
 *      这是「与 fisheye 宽度解耦」的机械证据（行为侧另见 rail-center.test.ts ④）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');
const RAIL = readFileSync(join(STYLES, 'rail.css'), 'utf8');

/** 取出某个选择器开头的规则块（到第一个右花括号为止；本文件规则都是平铺的）。 */
function ruleOf(css: string, selector: string): string {
  const i = css.indexOf(selector + ' {');
  expect(i, '必须存在规则：' + selector).toBeGreaterThan(-1);
  const end = css.indexOf('}', i);
  return css.slice(i, end);
}

describe('W872/W886 · rail 中间判定 · 样式门禁', () => {
  it('W886：rail.css 里不存在中间指示线规则（类名与长度变量都清干净）', () => {
    expect(RAIL, '不得再有 .railv3-mid 规则').not.toContain('.railv3-mid');
    expect(RAIL, '不得再有 --mid-w 变量').not.toContain('--mid-w');
  });

  it('rail.css 里不出现虚线关键字', () => {
    const bad: string[] = [];
    RAIL.split('\n').forEach((line, i) => {
      if (/\b(dashed|dotted)\b/.test(line)) bad.push('rail.css:' + String(i + 1));
    });
    expect(bad).toEqual([]);
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
});
