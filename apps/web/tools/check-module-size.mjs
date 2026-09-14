#!/usr/bin/env node
/**
 * 门禁 · 前端模块体积棘轮（W758）。
 *
 * 规矩：src 下每个 .ts 单文件默认上限 400 行（默认值写在本文件 DEFAULT_LIMIT）。
 * 已经超大、但本轮不拆的文件登记在 `tools/module-size-baseline.json` 的
 * `limits` 表里，上限 = 登记时的真实行数（**棘轮：只许降不许升**）：
 *   · 任一文件超过自己的上限          → 打印 `文件:当前/上限`，退出码 1；
 *   · 例外表里的路径不存在 / 行数已 ≤ 默认上限（= 陈旧项） → 报警（⚠）；
 *   · 例外表上限高于当前行数（文件已变小）→ 报警「可收紧到 N」。
 *
 * 为什么「陈旧项」默认只报警而不失败：本仓是**多 worker 共用一个工作树**，
 * messages.ts / grants/panel.ts 正由别的 worker 拆分——它们一拆小，本门禁就会
 * 看到陈旧项。让别人的成功把自己的门禁搞红是错的，所以默认报⚠继续；
 * CI 要收紧时置 `CELESTEA_MODULE_SIZE_STRICT=1`，陈旧项即失败。
 *
 * 用法（frontend/ 目录下）：
 *   node tools/check-module-size.mjs                          # pnpm check:size
 *   CELESTEA_MODULE_SIZE_STRICT=1 node tools/check-module-size.mjs
 *   CELESTEA_MODULE_SIZE_BASELINE=/tmp/x.json node tools/check-module-size.mjs
 *   node tools/check-module-size.mjs --list                   # 只列出当前超标文件
 *
 * 行数口径 = `wc -l`（末尾换行不算新行），与 baseline 里的数字同一口径。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DEFAULT_LIMIT = 400;
const BASELINE = process.env['CELESTEA_MODULE_SIZE_BASELINE']
  ? path.resolve(process.env['CELESTEA_MODULE_SIZE_BASELINE'])
  : path.join(ROOT, 'tools', 'module-size-baseline.json');
const STRICT = process.env['CELESTEA_MODULE_SIZE_STRICT'] === '1';
const LIST_ONLY = process.argv.includes('--list');

/** 行数口径与 `wc -l` 一致：结尾换行不额外算一行。 */
function countLines(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function readBaseline() {
  if (!existsSync(BASELINE)) {
    console.error('✗ 找不到例外表：' + BASELINE);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (doc.kind !== 'frontend-module-size-baseline') {
    console.error(`✗ 例外表 kind 不是 frontend-module-size-baseline：${String(doc.kind)}`);
    process.exit(1);
  }
  const limits = doc.limits ?? {};
  for (const [rel, n] of Object.entries(limits)) {
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`✗ 例外表条目 ${rel} 的上限不是正整数：${String(n)}`);
      process.exit(1);
    }
    if (!rel.startsWith('src/')) {
      console.error(`✗ 例外表条目 ${rel} 必须以 src/ 开头（相对 frontend/ 的路径）`);
      process.exit(1);
    }
  }
  return { limits, defaultLimit: doc.defaultLimit ?? DEFAULT_LIMIT };
}

const { limits, defaultLimit } = readBaseline();
const files = walk(SRC).map((p) => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), lines: countLines(p) }));

if (LIST_ONLY) {
  for (const f of files.filter((f) => f.lines > defaultLimit)) {
    console.log(`${f.rel}:${f.lines}/${limits[f.rel] ?? defaultLimit}`);
  }
  process.exit(0);
}

const over = [];
const stale = [];
const tighten = [];
const unlisted = [];

for (const f of files) {
  const limit = limits[f.rel] ?? defaultLimit;
  if (f.lines > limit) over.push({ ...f, limit });
  if (limits[f.rel] === undefined && f.lines > defaultLimit) unlisted.push(f);
}
for (const [rel, limit] of Object.entries(limits)) {
  const f = files.find((x) => x.rel === rel);
  if (!f) stale.push({ rel, limit, why: '文件不存在（路径改了/文件已删）' });
  else if (f.lines <= defaultLimit) stale.push({ rel, limit, why: `已 ≤ ${defaultLimit} 行（当前 ${f.lines}），例外表条目应当删除` });
  else if (f.lines < limit) tighten.push({ rel, limit, lines: f.lines });
}

if (over.length > 0) {
  console.error(`\n✗ 前端模块体积门禁未通过（默认上限 ${defaultLimit} 行，棘轮例外表 ${path.relative(ROOT, BASELINE)}）\n`);
  for (const f of over) console.error(`  ${f.rel}:${f.lines}/${f.limit}` + (limits[f.rel] === undefined ? '  ← 未登记的超大文件：先拆分，或在例外表登记当前行数' : '  ← 超过登记上限（棘轮只许降不许升）'));
  console.error('');
  process.exit(1);
}

const note = (mark, text) => console.log(`  ${mark} ${text}`);
if (stale.length > 0 || tighten.length > 0) {
  console.log(`⚠ 例外表有可收紧项（不影响退出码${STRICT ? '；STRICT=1 时失败' : ''}）：`);
  for (const s of stale) note('·', `${s.rel}: 陈旧项 —— ${s.why}（登记上限 ${s.limit}）`);
  for (const t of tighten) note('·', `${t.rel}: 可收紧到 ${t.lines}（登记上限 ${t.limit}）`);
}
if (STRICT && stale.length > 0) {
  console.error('\n✗ CELESTEA_MODULE_SIZE_STRICT=1：例外表存在陈旧项，请删除后重跑\n');
  process.exit(1);
}
if (unlisted.length > 0) note('·', `（已登记的超大文件 ${Object.keys(limits).length} 个，均有上限约束）`);
const biggest = [...files].sort((a, b) => b.lines - a.lines).slice(0, 3).map((f) => `${f.rel} ${f.lines}`).join('，');
console.log(`✓ 前端模块体积门禁通过：${files.length} 个 .ts 文件，默认上限 ${defaultLimit} 行，例外表 ${Object.keys(limits).length} 项棘轮约束；最大三件：${biggest}`);
