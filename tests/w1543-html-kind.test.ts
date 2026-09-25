// 纯函数：W1543 的 kind 拆分 —— html/htm 必须是**独立 kind**，不再落回 code。
//
// 为什么单独成文件：tests/preview-detect.test.ts 是 F2 的既有测试面（不属于本波
// 可改范围），而这条契约是本波新增的，放这里边界清楚、也不动别人的断言。
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface DetectMod {
  classifyByPath(p: string): string;
  looksLikePath(p: string): boolean;
  detectFromTool(name: string, args: unknown): { path: string; kind: string; source: string } | null;
  detectFromText(text: string): { path: string; kind: string; source: string }[];
}
const load = async (): Promise<DetectMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/detect.ts'))) as DetectMod;

describe('W1543 · html/htm 独立 kind', () => {
  it('★ classifyByPath：html/htm ⇒ kind=html（不是 code）', async () => {
    const m = await load();
    // 拆出独立 kind 的理由：.html 留在 CODE_EXT 里就只能当代码看（旧行为），
    // 而它需要「渲染预览 / 高亮源码」两种看法。见 ui/preview/detect.ts 头注。
    expect(m.classifyByPath('/a/index.html'), 'html 必须是独立 kind').toBe('html');
    expect(m.classifyByPath('/a/page.htm')).toBe('html');
    expect(m.classifyByPath('index.HTML'), '大小写不敏感').toBe('html');
    expect(m.classifyByPath('index.html'), '裸文件名也算').toBe('html');
    // ★ 反控：**绝不能**再是 code（旧行为就是这条把它当代码看）。
    expect(m.classifyByPath('/a/index.html'), '不得落回 code').not.toBe('code');
    expect(m.classifyByPath('/a/page.htm'), '不得落回 code').not.toBe('code');
  });

  it('拆 kind 不误伤相邻类型（xml 仍是 code、svg 仍归图片）', async () => {
    const m = await load();
    expect(m.classifyByPath('/a/x.xml')).toBe('code');
    expect(m.classifyByPath('/a/logo.svg'), 'svg 仍归图片查看器').toBe('image');
    expect(m.classifyByPath('/a/x.ts')).toBe('code');
    expect(m.classifyByPath('/a/x.md')).toBe('markdown');
  });

  it('候选识别：html 能作为候选被认出（路径启发式 + 工具 + 文本）', async () => {
    const m = await load();
    expect(m.looksLikePath('index.html'), 'html 必须能作为候选被识别').toBe(true);
    expect(m.looksLikePath('a/b/page.htm')).toBe(true);
    expect(m.detectFromTool('read_file', { path: '/a/index.html' })?.kind).toBe('html');
    expect(m.detectFromTool('read_file', { path: '/a/page.htm' })?.kind).toBe('html');
    expect(m.detectFromText('见 `/a/page.htm`')[0]?.kind).toBe('html');
  });
});
