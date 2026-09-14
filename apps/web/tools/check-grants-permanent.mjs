#!/usr/bin/env node
/**
 * 门禁 · W773：授权「直接授予（永久）」守护。
 *
 * 背景（主人原话）：「授权太鸡肋了，没有永久选项；应该直接授予或不授予，不应该时长授予。」
 * 于是前端把**永久**变成主路径：授予按钮直接发 `ttl_sec: 0`，时长选项收进
 * 「临时授权…」次级入口；文案遇到 `expires_at === null` 一律说「永久（可随时撤销）」/
 * 「撤销前一直有效」，任何地方都不许退化成时刻。本门禁把这条产品语义钉死。
 *
 * 做法（复用 vite 已带的 esbuild，不引入新依赖）：
 *   1) 把三个**纯模块**（caps / request / copy）连同 presets、state 打成一个 ESM 包 ——
 *      它们零 DOM、零网络，因此能在 node 里**跑真实生产代码**而不是读源码猜；
 *   2) 断言：默认 ttlOf=0、默认请求体 `ttl_sec === 0`（unsandboxed 仍 uses_left=1）、
 *      显式选 30 分钟仍发 1800、TTL_CHOICES 首位是永久、临时档不含 0、预设一律 0；
 *   3) 断言文案：永久 ⇒ 含「永久」/「撤销前一直有效」且**不出现 hh:mm**；限时 ⇒ 出现 hh:mm；
 *   4) 源码级不变量：「永久」字面量只许出现在 caps.ts（唯一真源），copy.ts 不得自己
 *      调 hhmm，rows.ts 必须用 caps 的 isPermanentExpiry / expiryParen 且临时时长
 *      选择器只列 TTL_TEMP_CHOICES。
 *
 * 用法：pnpm check:permanent（或 node tools/check-grants-permanent.mjs）
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRANTS = path.join(ROOT, 'src', 'ui', 'grants');
const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** 时刻形状（HH:MM）：永久文案里出现它 = 语义回退。 */
const HHMM = /\d{1,2}:\d{2}/;
const PERMANENT_WORDS = ['永久', '撤销前一直有效'];

async function loadProductionModules() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w773-permanent-'));
  const built = await build({
    stdin: {
      contents: [
        "export * as caps from './src/ui/grants/caps';",
        "export * as request from './src/ui/grants/request';",
        "export * as copy from './src/ui/grants/copy';",
        "export * as presets from './src/ui/grants/presets';",
        "export * as state from './src/ui/grants/state';",
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'w773-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  const out = path.join(dir, 'modules.mjs');
  writeFileSync(out, built.outputFiles[0].text);
  const mod = await import(pathToFileURL(out).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** ① 默认路径：直接授予 = 永久（ttl_sec: 0）。 */
function checkDefaults({ request, caps, presets }) {
  const defs = caps.CAPS;
  check(defs.length === 6, `能力位数量异常：${defs.length}（期望 6）`);
  check(
    caps.TTL_CHOICES[0] && caps.TTL_CHOICES[0].sec === 0 && caps.TTL_CHOICES[0].label === '永久',
    'TTL_CHOICES 首位必须是 {sec:0,label:"永久"}',
  );
  check(
    caps.TTL_TEMP_CHOICES.every((c) => c.sec > 0) && caps.TTL_TEMP_CHOICES.length >= 1,
    'TTL_TEMP_CHOICES（临时档）不得包含 0',
  );
  for (const def of defs) {
    const ttl = request.ttlOf(def);
    check(ttl === 0, `${def.cap}: 默认 ttlOf=${ttl}（应为 0 = 永久，defaultTtl 是否被改回 1800？）`);
    const body = request.reqFor(def, {}, ttl);
    check(body.ttl_sec === 0, `${def.cap}: 默认授予请求体 ttl_sec=${body.ttl_sec}（应为 0）`);
    if (def.cap === 'unsandboxed') {
      check(body.uses_left === 1, 'unsandboxed 必须仍带 uses_left=1（一次性）');
    }
  }
  for (const p of presets.PRESETS) {
    check(p.ttlSec === 0, `预设 ${p.id}: ttlSec=${p.ttlSec}（W773 起一律 0 = 永久）`);
  }
  check(
    presets.presetTtlSec({ ttlSec: 0 }, 900) === 0,
    '永久不得被服务端上限截断（presetTtlSec(0, 900) 必须是 0）',
  );
}

/** ② 显式选择临时时长时，请求体必须照发（30 分钟 = 1800）。 */
function checkExplicitTtl({ request, state, caps }) {
  const net = caps.CAPS.find((d) => d.cap === 'network');
  const sandboxed = caps.CAPS.find((d) => d.cap === 'unsandboxed');
  state.ttlPick.set('network', 1800);
  try {
    check(request.ttlOf(net) === 1800, `临时 30 分钟：ttlOf=${request.ttlOf(net)}（应为 1800）`);
    check(
      request.reqFor(net, {}, request.ttlOf(net)).ttl_sec === 1800,
      '临时 30 分钟：请求体 ttl_sec 应为 1800',
    );
  } finally {
    state.ttlPick.delete('network');
  }
  // 临时档也要按该能力的服务端上限收敛（unsandboxed 上限 900）
  state.ttlPick.set('unsandboxed', 3600);
  try {
    check(request.ttlOf(sandboxed) <= 900, `unsandboxed 临时时长未按上限收敛：${request.ttlOf(sandboxed)}`);
  } finally {
    state.ttlPick.delete('unsandboxed');
  }
  check(request.ttlOf(net) === 0, '清掉临时选择后必须回到默认永久');
}

/** ③ 文案：永久不出现时刻，限时仍出现时刻。 */
function checkCopy({ copy, caps }) {
  const scope = { roots: ['/srv/x'], hosts: ['localhost'], tools: ['browser'] };
  const timed = 1_700_001_800;
  for (const def of caps.CAPS) {
    const perm = copy.confirmMessageFor(def, scope, null);
    check(
      PERMANENT_WORDS.some((w) => perm.includes(w)) && !HHMM.test(perm),
      `${def.cap}: 永久确认文案必须说「永久/撤销前一直有效」且不含时刻，实际：${perm}`,
    );
    const limited = copy.confirmMessageFor(def, scope, timed);
    check(HHMM.test(limited), `${def.cap}: 限时确认文案应含时刻，实际：${limited}`);
    check(!limited.includes('撤销前一直有效'), `${def.cap}: 限时确认文案不该说「撤销前一直有效」`);
  }
  const net = caps.CAPS.find((d) => d.cap === 'network');
  const permOk = copy.successText(net, { grant: { cap: 'network', expires_at: null } });
  check(
    permOk.includes('永久') && !HHMM.test(permOk),
    `永久授予回执必须含「永久」且不含时刻，实际：${permOk}`,
  );
  const timedOk = copy.successText(net, { grant: { cap: 'network', expires_at: timed } });
  check(HHMM.test(timedOk), `限时授予回执应含时刻，实际：${timedOk}`);
  const presetMsg = copy.presetConfirmMessage('联网', [{ def: net, scope: {}, expiresAt: null }]);
  check(
    presetMsg.includes('永久') && !HHMM.test(presetMsg),
    `永久预设的确认正文必须含「永久」且不含时刻，实际：${presetMsg}`,
  );
  // 面板侧的到期短语（rows.ts 用的就是这两个）
  check(caps.expiryParen(null) === '（永久，可随时撤销）', `expiryParen(null)=${caps.expiryParen(null)}`);
  check(!HHMM.test(caps.expiryParen(null)), 'expiryParen(null) 不得含时刻');
  check(HHMM.test(caps.expiryParen(timed)), 'expiryParen(限时) 应含时刻');
  check(caps.untilPhrase(null) === '撤销前一直有效', `untilPhrase(null)=${caps.untilPhrase(null)}`);
}

/** 取一个 .ts 文件里**字符串字面量**含 `needle` 的情况（注释不算：注释里可以随便提「永久」）。 */
function literalHas(file, needle) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let hit = false;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // 模块路径不算文案
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.includes(needle)) hit = true;
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (node.head.text.includes(needle)) hit = true;
      for (const sp of node.templateSpans) if (sp.literal.text.includes(needle)) hit = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}

/** ④ 源码级不变量：唯一真源 + 面板必须走统一出口。 */
function checkSources() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) files.push(p);
    }
  };
  walk(GRANTS);
  files.push(path.join(ROOT, 'src', 'ui', 'grants.ts'));
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel === path.join('src', 'ui', 'grants', 'caps.ts')) continue; // 唯一真源
    if (literalHas(f, '永久')) offenders.push(rel);
  }
  check(
    offenders.length === 0,
    `「永久」字面量只许出现在 src/ui/grants/caps.ts（唯一真源），却出现在：${offenders.join(', ')}`,
  );
  const copySrc = read('src/ui/grants/copy.ts');
  check(!/\bhhmm\b/.test(copySrc), 'copy.ts 不得自行调用 hhmm（到期短语必须走 caps.ts）');
  const rowsSrc = read('src/ui/grants/panel/rows.ts');
  check(
    rowsSrc.includes('isPermanentExpiry(') && rowsSrc.includes('expiryParen('),
    'rows.ts 必须用 caps 的 isPermanentExpiry / expiryParen（否则永久条目会显示时刻）',
  );
  check(
    rowsSrc.includes('TTL_TEMP_CHOICES'),
    'rows.ts 的时长选择器只许列 TTL_TEMP_CHOICES（永久不得回到选择器里）',
  );
}

const { mod, cleanup } = await loadProductionModules();
try {
  checkDefaults(mod);
  checkExplicitTtl(mod);
  checkCopy(mod);
  checkSources();
} finally {
  cleanup();
}

if (problems.length) {
  console.error('✗ 授权「默认永久」门禁未通过\n');
  for (const p of problems) console.error('  ' + p);
  console.error(`\n共 ${problems.length} 处。`);
  process.exit(1);
}
console.log(
  '✓ 授权默认永久门禁通过：默认授予 ttl_sec=0（6 个能力位 + 预设）、永久文案不含时刻、临时档仍可按显式时长授予。',
);
