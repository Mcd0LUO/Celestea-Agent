#!/usr/bin/env node
/**
 * 门禁 · 共用前端「面向用户的技术文案」正则检查（清单 3 / W517 §7.5）。
 *
 * 规则：**含中文的字符串字面量**（= 会渲染给用户看的文案）里，禁止出现实现细节词：
 *   /api/ · SSE · HTTP␠ · 409 · jsonl · 热调 · 后端 · 前端 · 接口 ·
 *   modified · ev: · lagged · available.models · cache_read · prompt_tokens
 *
 * 为什么只查「含中文」的字面量：
 *   本仓库的 UI 文案一律是中文；纯 ASCII 字面量是协议常量/日志标签
 *   （api.ts 的 fetch URL、console.warn 标签、types.ts 的 wire 值 'lagged' 等），
 *   清单 §6.1 明确把它们排除在文案之外。这样既零误报，又正好卡住真正的泄漏面。
 *
 * 排除：
 *   - 注释（AST 层面不存在字符串字面量；HTML 侧先剥注释）
 *   - 行内含 `copy-gate-allow` 标记的行（显式豁免，需在 review 中给出理由）
 *
 * 用法：pnpm check:copy（frontend/ 目录下）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const HTML = path.join(ROOT, 'index.html');
const ALLOW_MARK = 'copy-gate-allow';

/** 只扫含中文的字面量；下面是禁用词表（词 → 说明）。 */
const CJK = /[\u3400-\u9fff]/;
const RULES = [
  ['/api/', /\/api\//],
  ['SSE', /SSE/],
  ['HTTP ', /HTTP\s/],
  ['409', /\b409\b/],
  ['jsonl', /jsonl/i],
  ['热调', /热调/],
  ['后端', /后端/],
  ['前端', /前端/],
  ['接口', /接口/],
  ['modified', /modified/],
  ['ev:', /ev:/],
  ['lagged', /lagged/],
  ['available.models', /available\.models/],
  ['cache_read', /cache_read/],
  ['prompt_tokens', /prompt_tokens/],
];

/** @type {string[]} */
const problems = [];

function check(text, where, lineText) {
  if (!CJK.test(text)) return;
  if (lineText.includes(ALLOW_MARK)) return;
  for (const [label, re] of RULES) {
    if (re.test(text)) problems.push(`${where}  [${label}]  ${JSON.stringify(text)}`);
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

function scanTs(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const rel = path.relative(ROOT, file);
  const at = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${rel}:${line + 1}`;
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // 模块路径
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const where = at(node);
      check(node.text, where, lines[Number(where.split(':')[1]) - 1] ?? '');
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const where = at(node);
      const lineText = lines[Number(where.split(':')[1]) - 1] ?? '';
      check(node.head.text, where, lineText);
      for (const span of node.templateSpans) check(span.literal.text, where, lineText);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function scanHtml(file) {
  const raw = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ''); // 注释不算文案
  const rel = path.relative(ROOT, file);
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
  const lineTextOf = (idx) => raw.split('\n')[lineOf(idx) - 1] ?? '';
  for (const m of raw.matchAll(/(?:title|placeholder|aria-label)\s*=\s*"([^"]*)"/g)) {
    check(m[1], `${rel}:${lineOf(m.index)}`, lineTextOf(m.index));
  }
  for (const m of raw.matchAll(/>([^<>]+)</g)) {
    check(m[1].trim(), `${rel}:${lineOf(m.index)}`, lineTextOf(m.index));
  }
}

for (const f of walk(SRC)) scanTs(f);
scanHtml(HTML);

if (problems.length) {
  console.error('✗ UI 文案门禁未通过：以下「会渲染给用户的中文文案」含实现细节词\n');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n共 ${problems.length} 处。改用用户语言，或（确有理由时）在同行加 ${ALLOW_MARK} 标记。`);
  process.exit(1);
}
console.log('✓ UI 文案门禁通过：src/**/*.ts 与 index.html 的用户可见中文文案无实现细节词。');
