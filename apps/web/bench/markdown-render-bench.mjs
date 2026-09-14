#!/usr/bin/env node
// ============================================================================
// bench/markdown-render-bench.mjs — W301 流式 markdown 渲染基准
//
// 对比两种渲染模式（不引入新依赖，直接从 frontend/node_modules 取 marked /
// highlight.js）：
//   全量（现状）：每个节拍对「整段累积文本」marked.parse + 所有代码块重高亮
//                 （innerHTML 重建 → dataset.hlDone 失效 → 无缓存可言）
//   增量（W301） ：MarkdownStream.update(累积全文) 只解析未固化尾部 +
//                 代码块内容键缓存（命中不重高亮）
//
// 用法：
//   node frontend/bench/markdown-render-bench.mjs            # 基准表 + 正确性校验
//   node frontend/bench/markdown-render-bench.mjs --verify   # 额外打印边界用例 HTML
//   node frontend/bench/markdown-render-bench.mjs --fuzz     # 额外跑确定性随机 fuzz
//
// 说明：这里只计量「解析 + 高亮」的 CPU（与架构师实测口径一致），不含浏览器
// 侧的 innerHTML 解析 / 布局 / 绘制 / scrollHeight 强制回流（真实环境会再放大）。
// 脚本只读、不写文件、无全局副作用，可重复运行。
// ============================================================================
import { readFileSync } from 'node:fs';
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
import { MarkdownStream, renderMarkdown } from '../src/utils/markdown.ts';

hljs.registerLanguage('rust', rust);

const pkg = (name) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
const VERIFY = process.argv.includes('--verify');
const FUZZ = process.argv.includes('--fuzz');

// ---- 计时工具 ----------------------------------------------------------------

/** 返回一次调用的中位耗时（ms）：1 次预热 + 3 次计时。 */
function medianMs(fn, reps = 3) {
  const ts = [];
  for (let r = 0; r <= reps; r += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    if (r > 0) ts.push(Number(t1 - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const ms = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

// ---- 样本文本构造 -------------------------------------------------------------

/** 一段 rust 代码（≈1.1K 字符）。 */
function rustSnippet(i) {
  const out = [
    `fn handler_${i}(input: &str) -> Result<String, Box<dyn std::error::Error>> {`,
    `    let mut acc = String::with_capacity(input.len());`,
    `    let mut count = 0usize;`,
  ];
  for (let k = 0; k < 5; k += 1) {
    out.push(`    for (idx, line) in input.lines().enumerate().skip(${k * 7}) {`);
    out.push(`        acc.push_str(&format!("{}:{}:{}", ${k}, idx, line.trim()));`);
    out.push(`        count += line.matches("abcdefgh").count();`);
    out.push(`    }`);
  }
  out.push(`    Ok(format!("{}:{}", acc.len(), count))`);
  out.push('}');
  return out.join('\n') + '\n';
}

/** 每 ~1500 字符一个 rust 代码块的自然语言 + 代码混排文本。 */
function buildText(target) {
  const parts = [];
  let n = 0;
  let i = 0;
  while (n < target) {
    i += 1;
    // 自然语言段落（≈350 字符）+ rust 代码块（≈1.1K 字符）→ 平均每 ~1500 字符一块
    const prose =
      `## 小节 ${i}\n\n` +
      `这是第 ${i} 段说明文字，用于模拟真实回答里的自然语言段落：含行内 \`code\`、` +
      `**强调**、[链接](https://example.com) 以及一段中文描述，长度与常见模型输出接近。\n\n` +
      `补充说明第 ${i} 点：这段文字继续拉长以匹配真实回答的段落密度，并保持每约 ` +
      `1500 字符插入一个 rust 代码块的结构；再加一句用于凑足长度的普通中文描述，` +
      `使样本密度与真实长回答（含多个代码块）一致。\n\n`;
    const code = '```rust\n' + rustSnippet(i) + '```\n\n';
    parts.push(prose, code);
    n += prose.length + code.length;
  }
  return parts.join('').slice(0, target);
}

/** 抽出所有「已闭合」的围栏代码块（未闭合块不计）。 */
function codeBlocksOf(text) {
  const out = [];
  const re = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ lang: m[1] || 'plaintext', code: m[2] ?? '' });
  return out;
}

/** 高亮所有代码块；cache 为 null 表示无缓存（= 现状全量路径）。 */
function highlightBlocks(blocks, cache) {
  for (const b of blocks) {
    if (b.code.length > 32768) continue; // 与 hljs.ts 的跳过阈值一致
    const key = b.lang + '\u0000' + b.code;
    if (cache !== null && cache.has(key)) continue;
    try {
      const html = hljs.highlight(b.code, { language: b.lang, ignoreIllegals: true }).value;
      if (cache !== null) cache.set(key, html);
    } catch {
      /* 未知语言：与 hljs.ts 的 catch 分支一致（跳过） */
    }
  }
}

/** 全量路径单次渲染（= 现状 renderTextView 的 CPU 部分）。 */
function renderFull(text) {
  const html = renderMarkdown(text);
  highlightBlocks(codeBlocksOf(text), null);
  return html;
}

/** 把文本切成每 delta 字符一片（最后一片为全文，模拟逐 tick 追加）。 */
function slices(text, delta) {
  const out = [];
  for (let end = delta; end < text.length; end += delta) out.push(text.slice(0, end));
  out.push(text);
  return out;
}

// ---- 边界用例（增量正确性校验） -----------------------------------------------

const EDGE_CASES = [
  ['未闭合围栏 ```', '先说明一下这个函数的用途。\n\n```rust\nfn main() {\n    let a = 1;\n'],
  ['未闭合列表', '要点如下：\n\n- 第一条要点\n- 第二条要点\n'],
  ['行内 ** 未闭合', '这里是一段 **加粗未闭合的文字\n\n下一段普通文本。\n'],
  ['已闭合围栏（可固化）', '说明：\n\n```rust\nfn a() {}\n```\n\n后续段落。\n'],
  ['引用式链接 + 文末定义', '见 [文档][1] 的说明。\n\n[1]: https://example.com\n'],
  ['表格行（可能成为表头）', '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n\n后续段落。\n'],
  ['缩进续行（跨空行）', '- 列表项\n\n  续行内容\n\n后续段落。\n'],
  ['未闭合 HTML 容器', '<pre>\n\nfoo\n'],
  ['表格整块 + 后续段落', '| a | b |\n| - | - |\n| 1 | 2 |\n\n后续段落。\n'],
  ['标题重复（slug 连续）', '# A\n\npara\n\n# A\n\npara2\n\n# A\n'],
];

/**
 * 逐字符前缀校验：每个前缀下 增量输出 === 全量输出。
 * 返回 { ok, firstDiff, stableLen, total }。
 */
function verifyCase(text) {
  const stream = new MarkdownStream();
  let firstDiff = null;
  for (let i = 1; i <= text.length; i += 1) {
    const prefix = text.slice(0, i);
    const inc = stream.update(prefix);
    const full = renderMarkdown(prefix);
    if (inc !== full && firstDiff === null) {
      firstDiff = { at: i, inc, full };
    }
  }
  return { ok: firstDiff === null, firstDiff, stableLen: stream.stableLength, total: text.length };
}

// ---- 主流程 -------------------------------------------------------------------

const DELTA = 1024; // 每 tick 追加字符数（模拟 SSE 增量节拍）
const SIZES = [8000, 16000, 32000, 64000, 128000];

console.log('Celestea Studio · 流式 markdown 渲染基准（W301）');
console.log(
  `node ${process.version} · marked ${pkg('marked')} · highlight.js ${pkg('highlight.js')} · 每 tick 追加 ${DELTA} 字符`,
);

const rows = [];
let perBlockChars = 0;

for (const size of SIZES) {
  const text = buildText(size);
  const blocks = codeBlocksOf(text);
  perBlockChars += text.length / Math.max(1, blocks.length);

  // 全量：单次渲染（整段文本）
  const fullMs = medianMs(() => renderFull(text));

  // 增量：模拟逐 tick 追加，取「末次 tick」与「峰值 tick」耗时（3 次取中位）
  const lastRuns = [];
  const peakRuns = [];
  for (let r = 0; r < 3; r += 1) {
    const stream = new MarkdownStream();
    const cache = new Map();
    let last = 0;
    let peak = 0;
    for (const s of slices(text, DELTA)) {
      const t0 = process.hrtime.bigint();
      stream.update(s);
      highlightBlocks(codeBlocksOf(s), cache);
      const t1 = process.hrtime.bigint();
      last = Number(t1 - t0) / 1e6;
      if (last > peak) peak = last;
    }
    lastRuns.push(last);
    peakRuns.push(peak);
  }
  lastRuns.sort((a, b) => a - b);
  peakRuns.sort((a, b) => a - b);
  const incMs = lastRuns[1];
  const incPeakMs = peakRuns[1];

  rows.push({ size, blocks: blocks.length, fullMs, incMs, incPeakMs });
}

const label = (n) => (n >= 1000 ? `${n / 1000}K` : String(n));
console.log('');
console.log(
  pad('文本长度', 10) +
    padL('代码块', 8) +
    padL('全量单次(ms)', 14) +
    padL('增量末次(ms)', 14) +
    padL('增量峰值(ms)', 14) +
    padL('加速比', 10),
);
console.log('-'.repeat(72));
for (const r of rows) {
  console.log(
    pad(label(r.size), 10) +
      padL(r.blocks, 8) +
      padL(ms(r.fullMs), 14) +
      padL(ms(r.incMs), 14) +
      padL(ms(r.incPeakMs), 14) +
      padL((r.fullMs / Math.max(r.incMs, 1e-6)).toFixed(1) + '×', 10),
  );
}
console.log('');
console.log(
  `样本：平均每 ${Math.round(perBlockChars / rows.length)} 字符一个 rust 代码块；` +
    '增量末次 = 全文到位那一 tick 的耗时，增量峰值 = 整个流式过程中最慢的一 tick。',
);

// 一次 128K 回答的累计 CPU
const bigText = buildText(128000);
const bigSlices = slices(bigText, DELTA);
let fullTotal = 0;
for (const s of bigSlices) {
  const t0 = process.hrtime.bigint();
  renderFull(s);
  const t1 = process.hrtime.bigint();
  fullTotal += Number(t1 - t0) / 1e6;
}
let incTotal = 0;
{
  const stream = new MarkdownStream();
  const cache = new Map();
  for (const s of bigSlices) {
    const t0 = process.hrtime.bigint();
    stream.update(s);
    highlightBlocks(codeBlocksOf(s), cache);
    const t1 = process.hrtime.bigint();
    incTotal += Number(t1 - t0) / 1e6;
  }
}
console.log('');
console.log(
  `一次 128K 回答的累计 CPU（${bigSlices.length} 个 tick，仅解析+高亮）：` +
    `全量 ${fullTotal.toFixed(0)} ms vs 增量 ${incTotal.toFixed(0)} ms` +
    `（省 ${(100 * (1 - incTotal / fullTotal)).toFixed(0)}%，加速 ${(fullTotal / incTotal).toFixed(1)}×）`,
);

// ---- 正确性校验 ---------------------------------------------------------------

console.log('');
console.log('增量正确性（逐字符前缀：增量输出必须逐字节等于全量输出）');
console.log('-'.repeat(56));
let allOk = true;
for (const [name, text] of EDGE_CASES) {
  const r = verifyCase(text);
  allOk = allOk && r.ok;
  const fixed = `${r.stableLen}/${r.total}`;
  console.log(
    `${r.ok ? 'OK  ' : 'FAIL'} ${pad(name, 26)} 已固化前缀 ${padL(fixed, 9)}` +
      (r.ok ? '' : `  首个不一致 @${r.firstDiff?.at}`),
  );
  if (VERIFY && !r.ok) {
    console.log('   增量：' + JSON.stringify(r.firstDiff?.inc));
    console.log('   全量：' + JSON.stringify(r.firstDiff?.full));
  }
  if (VERIFY && r.ok) {
    const s = new MarkdownStream();
    console.log('   输出：' + JSON.stringify(s.update(text)));
  }
}
// done 全文覆盖语义（applyFinalText）：非前缀全文必须整体重渲染且与全量一致
{
  const stream = new MarkdownStream();
  stream.update('流式第一段\n\n第二段');
  const finalText = '引擎规范化后的**全文**\n\n第二段不同';
  const ok = stream.update(finalText) === renderMarkdown(finalText);
  allOk = allOk && ok;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${pad('done 全文覆盖（非前缀）', 26)} 已固化前缀 ${padL('0/' + finalText.length, 9)}`);
  // 长度回退
  const stream2 = new MarkdownStream();
  stream2.update('一二三四五六\n\n七八九十');
  const back = '一二三四\n\n';
  const ok2 = stream2.update(back) === renderMarkdown(back);
  allOk = allOk && ok2;
  console.log(`${ok2 ? 'OK  ' : 'FAIL'} ${pad('长度回退（编辑/重放）', 26)}`);
}

// 基准样本本身也做逐 tick 校验（8K）
{
  const t = buildText(8000);
  const stream = new MarkdownStream();
  let ok = true;
  for (const s of slices(t, 512)) {
    if (stream.update(s) !== renderMarkdown(s)) {
      ok = false;
      break;
    }
  }
  allOk = allOk && ok;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${pad('基准样本逐 tick（8K）', 26)}`);
}
console.log('');

// ---- 可选：确定性随机 fuzz（--fuzz） ------------------------------------------
if (FUZZ) {
  console.log('随机 fuzz（确定性种子，逐字符前缀：增量输出必须逐字节等于全量输出）');
  console.log('-'.repeat(56));
  const TOK = [
    'a', 'b', '中', ' ', '  ', '\t', '\n', '\n\n', '\r\n', '#', '##', '-', '*', '+', '_', '>',
    '`', '``', '```', '```rust', '~~~', '~~~rust', '|', '[', ']', '(', ')', '!', '1', '2', '.', '\\',
    '<', '>', '</', 'pre>', 'div>', '<!--', '-->', '~~', '**', '---', '===', '    ', 'x', 'y',
    '[1]:', 'http://x', '<?', '?>', '<![CDATA[', ']]>', '<!X', '1.', '2)', 'kbd>', 'script>',
  ];
  let seed = 0x2f6e2b1;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // LCG：确定性、可重复
    return seed % n;
  };
  const DOCS = 2000;
  let fuzzFail = 0;
  let fuzzChars = 0;
  for (let doc = 0; doc < DOCS && fuzzFail === 0; doc += 1) {
    let text = '';
    const n = 3 + rnd(28);
    for (let i = 0; i < n; i += 1) text += TOK[rnd(TOK.length)];
    fuzzChars += text.length;
    const stream = new MarkdownStream();
    for (let i = 1; i <= text.length; i += 1) {
      const prefix = text.slice(0, i);
      if (stream.update(prefix) !== renderMarkdown(prefix)) {
        fuzzFail += 1;
        console.log('DIFF doc#' + doc + ' @' + i + ' stable=' + stream.stableLength);
        console.log('  p   :', JSON.stringify(prefix));
        break;
      }
    }
  }
  console.log(`fuzz：${DOCS} 文档 / ${fuzzChars} 字符，失败 ${fuzzFail} 例`);
  console.log('');
  allOk = allOk && fuzzFail === 0;
}

console.log(allOk ? '增量渲染正确性：全部通过' : '增量渲染正确性：存在不一致（见上）');
process.exitCode = allOk ? 0 : 1;
