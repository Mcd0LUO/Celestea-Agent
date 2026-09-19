// 纯函数：F2 候选文件识别（零 DOM）。收窄策略见 ui/preview/detect.ts 头注。
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface Candidate { path: string; kind: string; source: string }
interface DetectMod {
  classifyByPath(p: string): string;
  looksLikePath(p: string): boolean;
  detectFromTool(name: string, args: unknown): Candidate | null;
  detectFromText(text: string): Candidate[];
  dedupeCandidates(list: readonly Candidate[]): Candidate[];
}

const load = async (): Promise<DetectMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/detect.ts'))) as DetectMod;

describe('F2 · 候选文件识别（纯函数）', () => {
  it('classifyByPath 按扩展名分类（大小写不敏感，未知 = unknown）', async () => {
    const m = await load();
    expect(m.classifyByPath('/a/b.ts')).toBe('code');
    expect(m.classifyByPath('README.md')).toBe('markdown');
    expect(m.classifyByPath('/a/logo.PNG')).toBe('image');
    expect(m.classifyByPath('/a/x.diff')).toBe('diff');
    expect(m.classifyByPath('/a/x.unknownext')).toBe('unknown');
    expect(m.classifyByPath('noext')).toBe('unknown');
  });

  it('looksLikePath 收窄：URL / 裸词 / 带空格 不算', async () => {
    const m = await load();
    expect(m.looksLikePath('apps/web/src/ui/rail.ts')).toBe(true);
    expect(m.looksLikePath('./a.md')).toBe(true);
    expect(m.looksLikePath('README.md')).toBe(true);
    expect(m.looksLikePath('config.json')).toBe(true);
    expect(m.looksLikePath('https://example.com/a.ts')).toBe(false);
    expect(m.looksLikePath('Array.map')).toBe(false);
    expect(m.looksLikePath('node.js')).toBe(false);
    expect(m.looksLikePath('带 空格.ts')).toBe(false);
  });

  it('detectFromTool：read_file 的 args.path（对象 / JSON 文本）；非文件工具 null', async () => {
    const m = await load();
    expect(m.detectFromTool('read_file', { path: '/a/b.ts' })).toMatchObject({ path: '/a/b.ts', kind: 'code', source: 'tool' });
    expect(m.detectFromTool('read_file', '{"path":"/a/b.md"}')).toMatchObject({ path: '/a/b.md', kind: 'markdown' });
    expect(m.detectFromTool('read_file', {})).toBeNull();
    expect(m.detectFromTool('run_code', { path: '/a/b.ts' })).toBeNull();
  });

  it('detectFromText：链接 / 反引号 / 「文件：x」，并排除 URL 与无扩展名词', async () => {
    const m = await load();
    const text = '看 [入口](apps/web/src/main.ts) 与 `lib/x.py`；文件：docs/a.md。不要认 [链接](https://e.com/a.ts) 或 `Array.map`。';
    const paths = m.detectFromText(text).map((c) => c.path);
    expect(paths).toContain('apps/web/src/main.ts');
    expect(paths).toContain('lib/x.py');
    expect(paths).toContain('docs/a.md');
    expect(paths).not.toContain('https://e.com/a.ts');
    expect(paths).not.toContain('Array.map');
  });

  it('dedupeCandidates 保留首个（工具来源优先）', async () => {
    const m = await load();
    const out = m.dedupeCandidates([
      { path: 'a.ts', kind: 'code', source: 'tool' },
      { path: 'a.ts', kind: 'code', source: 'link' },
      { path: 'b.md', kind: 'markdown', source: 'label' },
    ]);
    expect(out.map((c) => c.path)).toEqual(['a.ts', 'b.md']);
    expect(out[0]?.source).toBe('tool');
  });
});
