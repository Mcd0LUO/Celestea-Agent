// W847 · marked 4→18：标题 id retain（本地复刻 marked@4.3.0 Slugger）
//
// 背景：marked v4→v5 上游移除 headerIds/Slugger，v18 的 heading() 不再产出 id。
// 本项目 retain 标题 id（sanitize.ts 的 id 白名单 / 会话内定位都依赖它）。这里锁两道：
//   1) 差分：OUR v18 管线产出的 <hN id="…"> 序列逐字节等于 marked@4.3.0 参考向量。
//      参考向量以字面量冻结（由 marked@4.3.0 默认选项实测生成），不依赖 pnpm store
//      —— install prune / 换机 / CI 都不会让基准失效。
//   2) 流式：含重复标题的文档逐字符/多点喂 MarkdownStream，累计 HTML 与整段一次
//      renderMarkdown 逐字节相同（这正是原跨块 slugger 存在的理由）。
//
// 范式：pathToFileURL 动态 import 真实模块（与 tests/w846-latex-mathml.test.ts 一致）。
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const at = (rel: string): string => pathToFileURL(join(WEB, 'src', rel)).href;
const BT = String.fromCharCode(96);
const NL = String.fromCharCode(10);

const mdMod = (await import(at('utils/markdown.ts'))) as {
  renderMarkdown(text: string): string;
  MarkdownStream: new () => { update(text: string): string; reset(): void };
};

/**
 * 抽取 <h1..6 id="…"> 的 id 序列。差分只比 id、不比整段 HTML：v4→v18 在列表/换行等
 * 其他位置的输出本来就有差异，整段比会误判。
 */
function headingIds(html: string): string[] {
  const out: string[] = [];
  const re = /<h[1-6] id="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? '');
  return out;
}

interface Ref {
  name: string;
  src: string;
  ids: string[];
}

// 参考向量：由 marked@4.3.0（默认选项，headerPrefix 为空）实测冻结。
const REFS: Ref[] = [
  { name: '重复中文标题', src: ['# 标题', '', '## 标题', '', '### 标题'].join(NL), ids: ['标题', '标题-1', '标题-2'] },
  { name: 'ASCII 行内格式（raw 走 textRenderer，行内标记被剥离）', src: ['## Hello *World*', '', '## Hello World'].join(NL), ids: ['hello-world', 'hello-world-1'] },
  { name: 'HTML 实体（& 属被剥离标点；&amp; 被 v4 unescape 丢弃）', src: ['### A & B', '', '### A &amp; B'].join(NL), ids: ['a--b', 'a--b-1'] },
  { name: '标点与空 slug（空 id 的怪癖逐字节保留）', src: ['# !!!', '', '# ***'].join(NL), ids: ['', '-1'] },
  { name: '行尾井号', src: ['# trailing #'].join(NL), ids: ['trailing'] },
  { name: '中文连字符保留', src: ['# 中文-标题'].join(NL), ids: ['中文-标题'] },
  { name: 'setext h1/h2 同样生成 id', src: ['setext', '======', '', 'setext', '------'].join(NL), ids: ['setext', 'setext-1'] },
  { name: '行内代码取字面量', src: ['# a ' + BT + 'b' + BT + ' c'].join(NL), ids: ['a-b-c'] },
  { name: '链接与图片取可见文本', src: ['# [link](http://x)', '', '# ![alt](http://x)'].join(NL), ids: ['link', 'alt'] },
  { name: '行内 HTML 剥标签后 slug', src: ['# <b>bold</b> text'].join(NL), ids: ['bold-text'] },
  { name: '大小写折叠 + 连续空白', src: ['#  Foo   Bar  '].join(NL), ids: ['foo---bar'] },
  { name: '后缀碰撞（one-1 已被占用时递增到 one-1-1）', src: ['# One', '', '## One', '', '## One-1', '', '## One'].join(NL), ids: ['one', 'one-1', 'one-1-1', 'one-2'] },
];

describe('W847 · 标题 id 差分（v18 管线 vs marked@4.3.0 冻结向量）', () => {
  it('标题保留 id 属性（防 v18 静默降级）', () => {
    expect(mdMod.renderMarkdown('# 标题')).toContain('<h1 id="标题">');
  });
  for (const ref of REFS) {
    it('id 序列逐字节一致：' + ref.name, () => {
      expect(headingIds(mdMod.renderMarkdown(ref.src))).toEqual(ref.ids);
    });
  }
});

// 含 4 个重复标题、且标题间夹正文的文档：用于流式跨块 slug 计数。
const DOC = ['# 标题', '', '正文 A', '', '## 标题', '', '正文 B', '', '### 标题', '', '正文 C', '', '## 标题'].join(NL);
const DOC_IDS = ['标题', '标题-1', '标题-2', '标题-3'];

describe('W847 · 流式（MarkdownStream）标题 id 与整段一次解析逐字节一致', () => {
  it('逐字符前缀：每个前缀 update() 都等于 renderMarkdown(前缀)', () => {
    const s = new mdMod.MarkdownStream();
    for (let i = 1; i <= DOC.length; i++) {
      const prefix = DOC.slice(0, i);
      expect(s.update(prefix), 'prefix ' + String(i) + ' ' + JSON.stringify(prefix)).toBe(mdMod.renderMarkdown(prefix));
    }
    expect(headingIds(s.update(DOC))).toEqual(DOC_IDS);
  });

  it('多点切分（按行边界）：累计 HTML 与整段一次解析逐字节相同', () => {
    const cuts: number[] = [];
    let acc = 0;
    for (const part of DOC.split(NL)) {
      acc += part.length + NL.length;
      cuts.push(Math.min(acc, DOC.length));
    }
    const s = new mdMod.MarkdownStream();
    for (const c of cuts) {
      expect(s.update(DOC.slice(0, c)), 'cut ' + String(c)).toBe(mdMod.renderMarkdown(DOC.slice(0, c)));
    }
    const finalHtml = s.update(DOC);
    expect(finalHtml).toBe(mdMod.renderMarkdown(DOC));
    expect(headingIds(finalHtml)).toEqual(DOC_IDS);
  });
});
