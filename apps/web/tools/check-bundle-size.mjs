#!/usr/bin/env node
/**
 * 门禁 · 前端产物体积棘轮（W758）—— `dist/assets` 下 js / css 的 gzip 字节上限。
 *
 * 为什么按 gzip 而不是原始字节：真正走网络的是压缩后的体积；原始字节随
 * 注释/空行波动，gzip 才反映用户实际下载量。
 * 为什么按「同类合计」而不是单文件：vite 产物名带内容哈希（index-XXXX.js），
 * 每次构建都改名；合计值才稳定可棘轮（拆分/去重会让合计降，新增依赖会让它升）。
 *
 * 上限来自 `tools/bundle-size-baseline.json`（登记时真实 build 的值）：
 *   · 任一类的 gzip 合计 > 上限 → 打印 `js:当前/上限`，退出码 1；
 *   · dist 不存在（未构建）→ 跳过（退出码 0）并显著提示：本门禁只查产物，
 *     不替 build 做决定；CI 里要「没构建就算失败」时置 CELESTEA_BUNDLE_STRICT=1。
 *
 * 用法（frontend/ 目录下，先 pnpm build）：
 *   node tools/check-bundle-size.mjs
 *   CELESTEA_BUNDLE_STRICT=1 node tools/check-bundle-size.mjs
 *   CELESTEA_BUNDLE_BASELINE=/tmp/x.json node tools/check-bundle-size.mjs
 *
 * 压缩口径：node:zlib gzipSync level 9（与 `gzip -9` 同档），确定性输出。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'assets');
const BASELINE = process.env['CELESTEA_BUNDLE_BASELINE']
  ? path.resolve(process.env['CELESTEA_BUNDLE_BASELINE'])
  : path.join(ROOT, 'tools', 'bundle-size-baseline.json');
const STRICT = process.env['CELESTEA_BUNDLE_STRICT'] === '1';

function readBaseline() {
  if (!existsSync(BASELINE)) {
    console.error('✗ 找不到产物体积基准：' + BASELINE);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (doc.kind !== 'frontend-bundle-size-baseline') {
    console.error(`✗ 基准 kind 不是 frontend-bundle-size-baseline：${String(doc.kind)}`);
    process.exit(1);
  }
  const gzip = doc.gzip ?? {};
  for (const kind of ['js', 'css']) {
    if (!Number.isInteger(gzip[kind]) || gzip[kind] <= 0) {
      console.error(`✗ 基准缺少 ${kind} 的 gzip 上限（正整数）`);
      process.exit(1);
    }
  }
  return gzip;
}

if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  if (STRICT) {
    console.error('✗ CELESTEA_BUNDLE_STRICT=1 但 dist/assets 不存在：请先 pnpm build');
    process.exit(1);
  }
  console.log('⚠ 产物体积门禁跳过：dist/assets 不存在（先跑 pnpm build；CELESTEA_BUNDLE_STRICT=1 时算失败）');
  process.exit(0);
}

const limits = readBaseline();
const files = readdirSync(DIST).filter((f) => /\.(js|css)$/.test(f)).sort();
const totals = { js: 0, css: 0 };
const rows = [];
for (const f of files) {
  const kind = f.endsWith('.css') ? 'css' : 'js';
  const raw = readFileSync(path.join(DIST, f));
  const gz = gzipSync(raw, { level: 9 }).length;
  totals[kind] += gz;
  rows.push({ f, kind, raw: raw.length, gz });
}

const over = ['js', 'css'].filter((k) => totals[k] > limits[k]);
if (rows.length === 0) {
  console.error('✗ dist/assets 里没有 js/css 产物（构建是否失败？）');
  process.exit(1);
}
if (over.length > 0) {
  console.error(`\n✗ 前端产物体积门禁未通过（gzip，基准 ${path.relative(ROOT, BASELINE)}）\n`);
  for (const k of over) console.error(`  ${k}:${totals[k]}/${limits[k]}  ← 超出 ${totals[k] - limits[k]} 字节，需解释并显式上调基准`);
  console.error('');
  for (const r of rows) console.error(`    ${r.f}  raw ${r.raw}  gzip ${r.gz}`);
  console.error('');
  process.exit(1);
}
const shrink = ['js', 'css']
  .filter((k) => totals[k] < limits[k])
  .map((k) => `${k} 可收紧到 ${totals[k]}（基准 ${limits[k]}，-${limits[k] - totals[k]}）`);
for (const r of rows) console.log(`    ${r.f}  raw ${r.raw}  gzip ${r.gz}`);
if (shrink.length > 0) console.log('⚠ 基准有可收紧项（不影响退出码）：' + shrink.join('；'));
console.log(`✓ 前端产物体积门禁通过（gzip level 9 合计）：js ${totals.js}/${limits.js}，css ${totals.css}/${limits.css}`);
