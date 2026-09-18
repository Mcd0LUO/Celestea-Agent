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
 * 断言：
 *   ① dist/index.html 的内联脚本 window.__CELESTEA_BUILD__ 携带派生 version / commits / sha；
 *   ② 该脚本必须在 module script **之前**（version.ts 启动即读）；
 *   ③ dist/assets/*.js **不得**含构建期元数据（buildTime ISO 串 / 短 sha）——
 *      这正是「元数据没有漏回 JS、构建可复现」的机械不变量；
 *   ④ 不在 tag 上时（commitsSinceTag > 0）提交数也要对上——「自动维护」的可见证据。
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

const { computeVersion } = await import(path.resolve(HERE, '..', '..', '..', 'scripts', 'version.mjs'));
const v = computeVersion({ cwd: path.resolve(HERE, '..', '..', '..') });

if (!existsSync(INDEX)) {
  console.error('✗ 版本门禁：dist/index.html 不存在 —— 先 `pnpm --dir apps/web run build`');
  process.exit(1);
}

const html = readFileSync(INDEX, 'utf8');

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
}

if (info !== null) {
  if (info.version !== v.version) {
    problems.push(`index.html 的 version '${String(info.version)}' ≠ 派生值 '${v.version}'（describe=${v.describe}）`);
  }
  if ((info.commits ?? 0) !== (v.commitsSinceTag ?? 0)) {
    problems.push(`index.html 的 commits '${String(info.commits)}' ≠ 派生值 '${String(v.commitsSinceTag ?? 0)}'`);
  }
  if (info.sha !== v.sha) {
    problems.push(`index.html 的 sha '${String(info.sha)}' ≠ 派生值 '${v.sha}'`);
  }
  const buildAt = match === null ? -1 : html.indexOf(match[0]);
  const moduleAt = html.search(/<script\b[^>]*type="module"/);
  if (buildAt < 0 || moduleAt < 0 || buildAt > moduleAt) {
    problems.push('window.__CELESTEA_BUILD__ 不在 module script 之前（version.ts 启动时读不到）');
  }
}

if (!existsSync(ASSETS)) {
  console.error('✗ 版本门禁：dist/assets 不存在 —— 先 build');
  process.exit(1);
}
const jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const jsAll = jsFiles.map((f) => readFileSync(path.join(ASSETS, f), 'utf8')).join('\n');

if (info !== null) {
  const buildTime = typeof info.buildTime === 'string' ? info.buildTime : '';
  const sha = typeof info.sha === 'string' ? info.sha : '';
  if (buildTime !== '' && jsAll.includes(buildTime)) {
    problems.push(`JS 产物含构建时间串 '${buildTime}'（构建元数据漏回 JS，破坏可复现性）`);
  }
  if (sha !== '' && jsAll.includes(sha)) {
    problems.push(`JS 产物含短 sha '${sha}'（构建元数据漏回 JS）`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error('✗ ' + p);
  console.error(`  （扫描 ${jsFiles.length} 个 js 产物；version=${v.version} commits=${v.commitsSinceTag} sha=${v.sha} source=${v.source}）`);
  process.exit(1);
}
console.log(`✓ 版本门禁通过：index.html 携带 git 派生版本 ${v.version}${v.commitsSinceTag > 0 ? '+' + v.commitsSinceTag : ''}（describe=${v.describe}，source=${v.source}），JS 产物不含构建期元数据`);
