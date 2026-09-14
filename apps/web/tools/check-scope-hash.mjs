#!/usr/bin/env node
/**
 * 门禁 · 提权范围哈希漂移守护（前端侧）—— W745 / W733 F2。
 *
 * 契约：`src/security/scope-hash.ts` 的 canonicalScopeJson + SHA-256 必须与服务端
 * `apps/studio/src/store/grants.ts` 的 canonicalScopeJson / canonicalScopeHash
 * **逐字一致**。两者不同 ⇒ 一次性令牌绑定的是前端哈希、提交时服务端按自己的公式
 * 重算 ⇒ 每次授予都 403（历史事故 commit 692f19c，手动修完但零测试保护）。
 *
 * 做法（简报方案②）：两端各自核对**同一份冻结向量**——
 *   真源   /src/celestea_studio-ts/contracts/scope-hash-vectors.json
 *   前端侧 本脚本（已接进 package.json 的 check / check:scope-hash）
 *   服务端侧 /src/celestea_studio-ts/tests/scope-hash-vectors.test.ts（vitest）
 * 任一端的形状/算法偏离该文件 ⇒ 那一端的门禁机械失败（非零退出）。
 *
 * 本脚本同时覆盖三条路径，都要求等于冻结 sha256：
 *   ① scopeHashOf（浏览器是 WebCrypto，node 里同样是 WebCrypto 分支）
 *   ② 自带的 sha256Hex（非安全上下文回落实现，浏览器里唯一可用的一份）
 *   ③ node:crypto 独立算一遍**冻结 json**（防止冻结文件本身写错）
 *
 * 用法：
 *   node tools/check-scope-hash.mjs              # 对拍（CI/`pnpm check` 用）
 *   node tools/check-scope-hash.mjs --self-test  # 另证「能机械失败」：故意改一侧必失败
 *   CELESTEA_SCOPE_VECTORS=/path/to/vectors.json node tools/check-scope-hash.mjs
 *
 * 依赖：Node ≥ 22.6（原生 TS 类型剥离，直接 import 前端纯函数；纯函数零 import/零 DOM）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 仓根：apps/web/tools/ -> apps/web -> apps -> <repo>。 */
const REPO = path.resolve(ROOT, '..', '..');
const MODULE = path.join(ROOT, 'src', 'security', 'scope-hash.ts');
const VECTOR_CANDIDATES = [
  process.env['CELESTEA_SCOPE_VECTORS'] ?? '',
  // W781：真源已并入同一仓（contracts/scope-hash-vectors.json），不再跨仓。
  path.join(REPO, 'contracts', 'scope-hash-vectors.json'),
].filter((p) => p !== '');

const SELF_TEST = process.argv.includes('--self-test');
const HEX64 = /^[0-9a-f]{64}$/;

function fail(lines) {
  console.error('\n✗ 范围哈希漂移守护未通过\n');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  process.exit(1);
}

function locateVectors() {
  for (const p of VECTOR_CANDIDATES) if (existsSync(p)) return p;
  fail([
    '找不到冻结向量文件 contracts/scope-hash-vectors.json（真源在 TS 仓）。',
    '  找过：',
    ...VECTOR_CANDIDATES.map((p) => '    ' + p),
    '  若 TS 仓不在同级目录，用 CELESTEA_SCOPE_VECTORS=<path> 指定。',
    '  （向量缺失 = 守护失效，故这里直接失败而不是跳过。）',
  ]);
}

function readVectors() {
  const file = locateVectors();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  if (doc.kind !== 'scope-hash-frozen-vectors') problems.push(`向量文件 kind 不是 scope-hash-frozen-vectors：${String(doc.kind)}`);
  if (!Array.isArray(doc.vectors) || doc.vectors.length === 0) problems.push('向量文件没有 vectors 数组');
  const seen = new Set();
  for (const v of doc.vectors ?? []) {
    const at = `vector '${String(v && v.name)}'`;
    if (!v || typeof v !== 'object') { problems.push(`${at}: 不是对象`); continue; }
    if (seen.has(v.name)) problems.push(`${at}: 名字重复`);
    seen.add(v.name);
    if (typeof v.cap !== 'string') problems.push(`${at}: cap 缺失`);
    if (typeof v.canonical_json !== 'string') problems.push(`${at}: canonical_json 缺失`);
    if (!HEX64.test(String(v.sha256))) problems.push(`${at}: sha256 不是 64 位小写十六进制`);
  }
  if (problems.length) fail([`向量文件不合法：${file}`, ...problems]);
  return { file, doc };
}

async function loadFrontend() {
  try {
    const m = await import(pathToFileURL(MODULE).href);
    for (const fn of ['canonicalScopeJson', 'scopeHashOf', 'sha256Hex']) {
      if (typeof m[fn] !== 'function') fail([`${path.relative(ROOT, MODULE)} 未导出 ${fn}（导出面被改动？）`]);
    }
    return m;
  } catch (err) {
    fail([
      `无法导入 ${path.relative(ROOT, MODULE)}：${err && err.message ? err.message : String(err)}`,
      '  本门禁依赖 Node ≥ 22.6 的原生 TS 类型剥离（不依赖构建产物，也不起后端）。',
    ]);
  }
}

/** 对拍一组向量；返回失败描述数组（空 = 全通过）。impl 只要求那三个函数。 */
async function compare(vectors, impl) {
  const fails = [];
  const encoder = new TextEncoder();
  for (const v of vectors) {
    const json = impl.canonicalScopeJson(v.cap, v.scope);
    if (json !== v.canonical_json) {
      fails.push(`${v.name}: canonical_json 不一致\n      冻结: ${v.canonical_json}\n      前端: ${json}`);
    }
    const frozenByNode = createHash('sha256').update(v.canonical_json, 'utf8').digest('hex');
    if (frozenByNode !== v.sha256) {
      fails.push(`${v.name}: 冻结文件自相矛盾（json 与 sha256 不是一对）\n      冻结 sha256: ${v.sha256}\n      node 重算 : ${frozenByNode}`);
    }
    const byWebcrypto = await impl.scopeHashOf(v.cap, v.scope);
    if (byWebcrypto !== v.sha256) fails.push(`${v.name}: scopeHashOf 摘要不一致\n      冻结: ${v.sha256}\n      前端: ${byWebcrypto}`);
    const byBuiltin = impl.sha256Hex(encoder.encode(json));
    if (byBuiltin !== v.sha256) fails.push(`${v.name}: 自带 sha256Hex 摘要不一致\n      冻结: ${v.sha256}\n      前端: ${byBuiltin}`);
  }
  return fails;
}

/** 自证「能机械失败」：改一侧 / 改向量都必须被抓到。 */
async function selfTest(front, vectors) {
  const notes = [];
  const expectFail = async (label, impl, mutated, wantNames) => {
    const got = await compare(mutated, impl);
    const names = [...new Set(got.map((g) => g.split(':')[0]))];
    const missed = wantNames.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !wantNames.includes(n));
    if (missed.length || extra.length) {
      fail([`自证失败（${label}）`, `  期望被抓到：${wantNames.join(', ')}`, `  实际抓到  ：${names.join(', ') || '(无)'}`, ...(extra.length ? [`  误报      ：${extra.join(', ')}`] : [])]);
    }
    notes.push(`  ✓ ${label} → 机械失败（${names.length} 条：${names.join(', ')}）`);
  };

  // ① 冻结向量被改（模拟其中一端偷偷换了期望值）
  const mutated = JSON.parse(JSON.stringify(vectors));
  mutated[0].sha256 = mutated[0].sha256.replace(/.$/, mutated[0].sha256.endsWith('0') ? '1' : '0');
  mutated[1].canonical_json = mutated[1].canonical_json + ' ';
  await expectFail('改冻结向量（sha256 + canonical_json）', front, mutated, [vectors[0].name, vectors[1].name]);

  // ② 前端实现漂移：回到 692f19c 之前的形状（只序列化 scope，没有 cap/scope 包裹）
  const legacyShape = {
    canonicalScopeJson: (_cap, scope) => JSON.stringify(scope),
    scopeHashOf: async (cap, scope) => createHash('sha256').update(JSON.stringify(scope), 'utf8').digest('hex'),
    sha256Hex: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  };
  const legacyNames = vectors.map((v) => v.name);
  await expectFail('前端漂移：回到 692f19c 之前的旧形状', legacyShape, vectors, legacyNames);

  // ③ 前端实现漂移：忘了排序（保留 trim/去重）
  const noSort = {
    canonicalScopeJson: (cap, scope) => {
      const key = cap === 'read_roots' || cap === 'write_roots' ? 'roots' : cap === 'net_hosts' ? 'hosts' : cap === 'tool_extra' ? 'tools' : null;
      const inner = {};
      if (key !== null) inner[key] = Array.from(new Set((scope[key] ?? []).map((x) => x.trim()).filter((x) => x !== '')));
      return JSON.stringify({ cap, scope: inner });
    },
    scopeHashOf: null,
    sha256Hex: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  };
  noSort.scopeHashOf = async (cap, scope) => createHash('sha256').update(noSort.canonicalScopeJson(cap, scope), 'utf8').digest('hex');
  // 「漏排序」真正会失败的集合 = noSort 的值序列 ≠ 冻结值序列的向量（精确判定，避免误报期望）
  const keyOf = (cap) => (cap === 'read_roots' || cap === 'write_roots' ? 'roots' : cap === 'net_hosts' ? 'hosts' : cap === 'tool_extra' ? 'tools' : null);
  const noSortValues = (v) => {
    const k = keyOf(v.cap);
    if (k === null) return [];
    return Array.from(new Set((v.scope[k] ?? []).map((x) => x.trim()).filter((x) => x !== '')));
  };
  const unsorted = vectors.filter(
    (v) => JSON.stringify(noSortValues(v)) !== JSON.stringify(JSON.parse(v.canonical_json).scope[keyOf(v.cap)] ?? []),
  );
  await expectFail('前端漂移：漏了排序（乱序输入）', noSort, vectors, unsorted.map((v) => v.name));

  console.log('✓ 自证「能机械失败」：故意改一侧/改向量都会被本门禁抓到');
  for (const n of notes) console.log(n);
}

const { file, doc } = readVectors();
const front = await loadFrontend();
const fails = await compare(doc.vectors, front);
if (fails.length) {
  fail([`${doc.vectors.length} 条冻结向量中有 ${fails.length} 条不一致（前端 ${path.relative(ROOT, MODULE)} vs 真源 ${file}）：`, ...fails.map((f) => '  ' + f)]);
}
console.log(`✓ 范围哈希漂移守护通过：${doc.vectors.length} 条冻结向量，前端 canonicalScopeJson + sha256（WebCrypto 与自带实现两条路径）逐字等于真源 ${file}`);
if (!SELF_TEST) for (const v of doc.vectors) console.log(`    ${v.name}  ${v.sha256.slice(0, 16)}…  ${v.canonical_json}`);
if (SELF_TEST) await selfTest(front, JSON.parse(JSON.stringify(doc.vectors)));
