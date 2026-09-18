#!/usr/bin/env node
/**
 * 门禁 · 构建产物必须携带「git 派生的版本号」（W887）。
 *
 * 为什么是**构建后**的门禁而不是单测：根门禁的顺序是
 *   typecheck → lint → lint:arch → test → check:web(build 然后 check)
 * 也就是说 `pnpm test` 跑在 `pnpm --dir apps/web run build` **之前**。把
 * 「产物里含派生版本」写成 vitest 用例，读到的永远是**上一次**构建的 dist ⇒
 * 树一改（例如合并出新提交）就必红。这条断言因此属于 check:web（build 之后）。
 *
 * 断言：
 *   ① dist/assets/*.js 至少有一个文件含 `scripts/version.mjs` 派生出的 version；
 *   ② 不在 tag 上时（commitsSinceTag > 0）还要含提交数——这正是「自动维护」的
 *      可见证据：改了代码、没打新 tag，UI 上的 +N 会跟着变；
 *   ③ dist 里**不得**出现「源码里被写死的 semver」那种退化——用 ②/① 的组合
 *      已足够：派生值必然来自注入，硬编码不会等于它（除非有人手改成同值）。
 *
 * 用法：node tools/check-version.mjs        # 需要先 build（check:web 保证）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const DIST = path.join(WEB, 'dist', 'assets');

const { computeVersion } = await import(path.resolve(HERE, '..', '..', '..', 'scripts', 'version.mjs'));
const v = computeVersion({ cwd: path.resolve(HERE, '..', '..', '..') });

if (!existsSync(DIST)) {
  console.error('✗ 版本门禁：dist/assets 不存在 —— 先 `pnpm --dir apps/web run build`');
  process.exit(1);
}

const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));
const blobs = files.map((f) => readFileSync(path.join(DIST, f), 'utf8'));
const all = blobs.join('\n');

const problems = [];
if (!all.includes(v.version)) {
  problems.push(`产物里找不到派生版本 '${v.version}'（describe=${v.describe}）`);
}
if (v.commitsSinceTag > 0 && !all.includes(String(v.commitsSinceTag))) {
  problems.push(`产物里找不到距 tag 的提交数 '${v.commitsSinceTag}'`);
}

if (problems.length > 0) {
  for (const p of problems) console.error('✗ ' + p);
  console.error(`  （扫描 ${files.length} 个 js 产物；version=${v.version} commits=${v.commitsSinceTag} sha=${v.sha} source=${v.source}）`);
  process.exit(1);
}
console.log(`✓ 版本门禁通过：产物携带 git 派生版本 ${v.version}${v.commitsSinceTag > 0 ? '+' + v.commitsSinceTag : ''}（describe=${v.describe}，source=${v.source}）`);
