#!/usr/bin/env node
/**
 * 门禁 · 构建产物必须携带「git 派生的版本号」，且构建元数据**只**在 index.html（W887）。
 *
 * 为什么是**构建后**的门禁而不是单测：根门禁的顺序是
 *   typecheck → lint → lint:arch → test → check:web(build 然后 check)
 * 也就是说 `pnpm test` 跑在 `pnpm --dir apps/web run build` **之前**。把
 * 「产物里含派生版本」写成 vitest 用例，读到的永远是**上一次**构建的 dist ⇒
 * 树一改（例如合并出新提交）就必红。这条断言因此属于 check:web（build 之后）。
 *
 * 为什么元数据在 index.html 而不在 JS：墙钟 buildTime 若进 JS bundle，**同一
 * 提交**的两次构建字节就不同（文件名哈希都变），精确字节的产物体积棘轮随即
 * 变成随机门禁（W887 实测 js 207427/207426 红）。元数据放 index.html 后，
 * JS/CSS 产物只由源码决定，可复现。
 *
 * W887d（比对基准确定性）：本门禁**不再调用 computeVersion()/git**。构建时
 * vite.config.ts 把同一份 BUILD_META 落盘为 dist/build-meta.json（构建期真值），
 * 本门禁只读产物：
 *   ① dist/index.html 的内联脚本 window.__CELESTEA_BUILD__ 携带该 meta，且在
 *      module script **之前**（version.ts 启动即读）；
 *   ② dist/assets/*.js **不得**含构建期元数据（buildTime ISO 串 / 短 sha）——
 *      这是「元数据没漏回 JS、构建可复现」的机械不变量；
 *   ③ 产物**自洽**：index.html 的 payload 与 dist/build-meta.json 逐字段一致。
 *
 * 代价（如实说明，见文件末）：产物与 HEAD 的「落后」不再被本门禁察觉。
 *
 * 用法：node tools/check-version.mjs        # 需要先 build（check:web 保证）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const DIST = path.join(WEB, 'dist');
const INDEX = path.join(DIST, 'index.html');
const ASSETS = path.join(DIST, 'assets');
const TRUTH = path.join(DIST, 'build-meta.json');

if (!existsSync(INDEX)) {
  console.error('✗ 版本门禁：dist/index.html 不存在 —— 先 `pnpm --dir apps/web run build`');
  process.exit(1);
}
if (!existsSync(TRUTH)) {
  console.error('✗ 版本门禁：dist/build-meta.json 不存在（构建期真值）—— 先 `pnpm --dir apps/web run build`');
  process.exit(1);
}

const html = readFileSync(INDEX, 'utf8');
let truth;
try {
  truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
} catch (e) {
  console.error('✗ 版本门禁：dist/build-meta.json 不是 JSON：' + String(e));
  process.exit(1);
}

const problems = [];
const BUILD_RE = /<script>\s*window\.__CELESTEA_BUILD__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;
const match = BUILD_RE.exec(html);
let info = null;
if (match === null) {
  problems.push('index.html 里找不到 window.__CELESTEA_BUILD__ = {...} 的内联脚本');
} else {
  try {
    info = JSON.parse(match[1]);
  } catch (e) {
    problems.push('window.__CELESTEA_BUILD__ 的 payload 不是 JSON：' + String(e));
  }
  const buildAt = html.indexOf(match[0]);
  const moduleAt = html.search(/<script\b[^>]*type="module"/);
  if (buildAt < 0 || moduleAt < 0 || buildAt > moduleAt) {
    problems.push('window.__CELESTEA_BUILD__ 不在 module script 之前（version.ts 启动时读不到）');
  }
}

// ③ 产物自洽：index.html 的 payload 必须逐字段等于构建期真值 build-meta.json。
if (info !== null) {
  for (const key of ['version', 'commits', 'sha', 'dirty', 'buildTime']) {
    if (info[key] !== truth[key]) {
      problems.push(`index.html 的 ${key} '${String(info[key])}' ≠ 构建期真值 '${String(truth[key])}'`);
    }
  }
}

if (!existsSync(ASSETS)) {
  console.error('✗ 版本门禁：dist/assets 不存在 —— 先 build');
  process.exit(1);
}
const jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const jsAll = jsFiles.map((f) => readFileSync(path.join(ASSETS, f), 'utf8')).join('\n');

// ② JS 产物不得含构建期元数据。
const buildTime = typeof truth.buildTime === 'string' ? truth.buildTime : '';
const sha = typeof truth.sha === 'string' ? truth.sha : '';
if (buildTime !== '' && jsAll.includes(buildTime)) {
  problems.push(`JS 产物含构建时间串 '${buildTime}'（构建元数据漏回 JS，破坏可复现性）`);
}
if (sha !== '' && jsAll.includes(sha)) {
  problems.push(`JS 产物含短 sha '${sha}'（构建元数据漏回 JS）`);
}

if (problems.length > 0) {
  for (const p of problems) console.error('✗ ' + p);
  console.error(`  （扫描 ${jsFiles.length} 个 js 产物；version=${truth.version} commits=${truth.commits} sha=${truth.sha}）`);
  process.exit(1);
}
console.log(`✓ 版本门禁通过：产物自洽（index.html meta === build-meta.json），version ${truth.version}${truth.commits > 0 ? '+' + truth.commits : ''}（sha=${truth.sha}），JS 产物不含构建期元数据`);

// 已知代价（W887d）：本门禁只比对产物内部一致性，不读 git。因此「dist 落后于
// HEAD」（改了代码/打了 tag 但没重新 build）**不再**由本门禁察觉。`pnpm check`
// 的 check:web 总是 build 之后立刻 check，所以常规路径不会拿到 stale dist；
// 但手工对旧 dist 跑本脚本时，它只保证「产物自身自洽」。
