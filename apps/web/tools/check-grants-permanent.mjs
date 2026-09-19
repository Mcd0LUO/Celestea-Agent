#!/usr/bin/env node
/**
 * 门禁 · W773：授权「直接授予（永久）」守护。
 *
 * 背景（主人原话）：「授权太鸡肋了，没有永久选项；应该直接授予或不授予，不应该时长授予。」
 * 于是前端把**永久**变成主路径：授予按钮直接发 `ttl_sec: 0`，时长选项收进
 * 「临时授权…」次级入口；文案遇到 `expires_at === null` 一律说「永久（可随时撤销）」/
 * 「撤销前一直有效」，任何地方都不许退化成时刻。本门禁把这条产品语义钉死。
 *
 * i18n（Batch4）后的口径变化：**真源从源码字面量换成 i18n 字典**。语义断言一条未删，
 * 且**加强**为双语（zh + en）——旧门禁只测中文，英文侧可以写成「永久 ⇒ 30 分钟」而全绿。
 *
 * 做法（复用 vite 已带的 esbuild，不引入新依赖）：
 *   1) 把纯模块（caps / request / copy / presets / state / i18n）打成 ESM 包 ——
 *      它们零 DOM、零网络，因此能在 node 里**跑真实生产代码**而不是读源码猜；
 *   2) 断言：默认 ttlOf=0、默认请求体 `ttl_sec === 0`（unsandboxed 仍 uses_left=1）、
 *      显式选 30 分钟仍发 1800、TTL 首位是永久、临时档不含 0、预设一律 0；
 *   3) 断言文案（**zh 与 en 各跑一遍**）：永久 ⇒ 含该语言的永久语义词且**不出现 hh:mm**；
 *      限时 ⇒ 出现 hh:mm。精确值断言走 `localeDict('zh')` 且保持 `===`；
 *   4) 源码级不变量（新形态，更强）：
 *      · `src/ui/grants/**` 与 `src/ui/grants.ts` 里 **0 个**「永久」字面量；
 *      · `src/i18n/locales/zh/**` 之外**全仓 src/** 无「永久」字面量；
 *      · **反空转**：`caps.ts` 必须引用 i18n 的永久 key（否则「删掉字面量」就能骗过）；
 *      · `copy.ts` 不得调 hhmm；`rows.ts` 必须用 isPermanentExpiry / expiryParen / ttlTempChoices。
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
        "export * as i18n from './src/i18n';",
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
function checkDefaults({ request, caps, presets, i18n }) {
  const zh = i18n.localeDict('zh');
  const defs = caps.caps();
  check(defs.length === 6, `能力位数量异常：${defs.length}（期望 6）`);
  // 规范值断言（门禁可硬编码期望值；生产代码里不得出现该字面量）：zh 永久 label 必须就是「永久」。
  check(zh['grants.permanent.label'] === '永久', `zh["grants.permanent.label"] 必须是「永久」，实际：${zh['grants.permanent.label']}`);
  // permanentLabel() 是真实 UI（quick.ts 永久 chip / rows.ts「已授予永久」）用的那条路径，
  // 显式点一次（防御性；结构上 ttlChoices()[0] 已与它同路径）。
  check(caps.permanentLabel() === zh['grants.permanent.label'], `permanentLabel()(zh)=${caps.permanentLabel()}（期望 localeDict(zh) 的值）`);
  const ttl = caps.ttlChoices();
  check(
    ttl[0] !== undefined && ttl[0].sec === 0 && ttl[0].label === zh['grants.permanent.label'],
    'TTL 首位必须是 {sec:0,label: localeDict(zh)["grants.permanent.label"]}',
  );
  const temp = caps.ttlTempChoices();
  check(temp.every((c) => c.sec > 0) && temp.length >= 1, 'TTL 临时档不得包含 0');
  for (const def of defs) {
    const ttlSec = request.ttlOf(def);
    check(ttlSec === 0, `${def.cap}: 默认 ttlOf=${ttlSec}（应为 0 = 永久，defaultTtl 是否被改回 1800？）`);
    const body = request.reqFor(def, {}, ttlSec);
    check(body.ttl_sec === 0, `${def.cap}: 默认授予请求体 ttl_sec=${body.ttl_sec}（应为 0）`);
    if (def.cap === 'unsandboxed') {
      check(body.uses_left === 1, 'unsandboxed 必须仍带 uses_left=1（一次性）');
    }
  }
  for (const p of presets.presets()) {
    check(p.ttlSec === 0, `预设 ${p.id}: ttlSec=${p.ttlSec}（W773 起一律 0 = 永久）`);
  }
  check(
    presets.presetTtlSec({ ttlSec: 0 }, 900) === 0,
    '永久不得被服务端上限截断（presetTtlSec(0, 900) 必须是 0）',
  );
}

/** ⑤ W819-8：预留能力位（tool_extra）不得出现在「可授」集合里。 */
function checkReserved({ caps }) {
  const defs = caps.caps();
  const reserved = defs.filter((d) => d.reserved === true).map((d) => d.cap);
  check(
    reserved.length === 1 && reserved[0] === 'tool_extra',
    '预留能力位应恰为 tool_extra，实际 ' + JSON.stringify(reserved),
  );
  const offered = caps.offeredCaps();
  check(offered.every((d) => d.reserved !== true), 'offeredCaps() 不得包含预留能力位');
  check(!offered.some((d) => d.cap === 'tool_extra'), 'offeredCaps() 不得包含 tool_extra');
  check(offered.length === defs.length - reserved.length, 'offeredCaps() 与预留位数量不一致');
}

/** ② 显式选择临时时长时，请求体必须照发（30 分钟 = 1800）。 */
function checkExplicitTtl({ request, state, caps }) {
  const defs = caps.caps();
  const net = defs.find((d) => d.cap === 'network');
  const sandboxed = defs.find((d) => d.cap === 'unsandboxed');
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
  state.ttlPick.set('unsandboxed', 3600);
  try {
    check(request.ttlOf(sandboxed) <= 900, `unsandboxed 临时时长未按上限收敛：${request.ttlOf(sandboxed)}`);
  } finally {
    state.ttlPick.delete('unsandboxed');
  }
  check(request.ttlOf(net) === 0, '清掉临时选择后必须回到默认永久');
}

/** ③ 文案：永久不出现时刻，限时仍出现时刻 —— **zh 与 en 各跑一遍**。 */
function checkCopy({ copy, caps, i18n }) {
  const zh = i18n.localeDict('zh');
  const en = i18n.localeDict('en');
  const scope = { roots: ['/srv/x'], hosts: ['localhost'], tools: ['browser'] };
  const timed = 1_700_001_800;
  const defs = caps.caps();
  const net = defs.find((d) => d.cap === 'network');

  // ---- zh ----
  i18n.setLocale('zh');
  const zhPermWords = [zh['grants.permanent.label'], zh['grants.until.permanent']];
  const zhTtlLabels = caps.ttlTempChoices().map((c) => c.label);
  for (const def of defs) {
    const perm = copy.confirmMessageFor(def, scope, null);
    check(
      zhPermWords.some((w) => perm.includes(w)) && !HHMM.test(perm),
      `${def.cap}(zh): 永久确认文案必须说「永久/撤销前一直有效」且不含时刻，实际：${perm}`,
    );
    check(!zhTtlLabels.some((l) => perm.includes(l)), `${def.cap}(zh): 永久确认文案不得含任何临时时长档标签，实际：${perm}`);
    const limited = copy.confirmMessageFor(def, scope, timed);
    check(HHMM.test(limited), `${def.cap}(zh): 限时确认文案应含时刻，实际：${limited}`);
    check(!limited.includes(zh['grants.until.permanent']), `${def.cap}(zh): 限时确认文案不该说「撤销前一直有效」`);
  }
  const zhOk = copy.successText(net, { grant: { cap: 'network', expires_at: null } });
  check(
    zhOk.includes(zh['grants.permanent.label']) && !HHMM.test(zhOk),
    `(zh) 永久授予回执必须含「永久」且不含时刻，实际：${zhOk}`,
  );
  const zhTimed = copy.successText(net, { grant: { cap: 'network', expires_at: timed } });
  check(HHMM.test(zhTimed), `(zh) 限时授予回执应含时刻，实际：${zhTimed}`);
  const zhPreset = copy.presetConfirmMessage(zh['grants.preset.net.label'], [{ def: net, scope: {}, expiresAt: null }]);
  check(
    zhPreset.includes(zh['grants.permanent.label']) && !HHMM.test(zhPreset),
    `(zh) 永久预设的确认正文必须含「永久」且不含时刻，实际：${zhPreset}`,
  );
  // 精确值（全等，不降级 includes）
  check(caps.expiryParen(null) === zh['grants.permanent.paren'], `expiryParen(null)=${caps.expiryParen(null)}（期望 zh["grants.permanent.paren"]）`);
  check(!HHMM.test(caps.expiryParen(null)), 'expiryParen(null) 不得含时刻');
  check(HHMM.test(caps.expiryParen(timed)), 'expiryParen(限时) 应含时刻');
  check(caps.untilPhrase(null) === zh['grants.until.permanent'], `untilPhrase(null)=${caps.untilPhrase(null)}`);

  // ---- en（(A) 相对旧门禁的净增价值） ----
  i18n.setLocale('en');
  const enPermWords = [en['grants.permanent.label'].toLowerCase(), en['grants.until.permanent'].toLowerCase()];
  const enTtlLabels = caps.ttlTempChoices().map((c) => c.label);
  for (const def of defs) {
    const raw = copy.confirmMessageFor(def, scope, null);
    const perm = raw.toLowerCase();
    check(
      enPermWords.some((w) => perm.includes(w)) && !HHMM.test(perm),
      `${def.cap}(en): 永久确认文案必须含英文永久语义词且不含时刻，实际：${raw}`,
    );
    check(!enTtlLabels.some((l) => raw.includes(l)), `${def.cap}(en): 永久确认文案不得含任何临时时长档标签，实际：${raw}`);
    const limited = copy.confirmMessageFor(def, scope, timed);
    check(HHMM.test(limited), `${def.cap}(en): 限时确认文案应含时刻，实际：${limited}`);
  }
  const enOk = copy.successText(net, { grant: { cap: 'network', expires_at: null } });
  check(
    enOk.toLowerCase().includes(en['grants.permanent.paren'].trim().toLowerCase()) && !HHMM.test(enOk),
    `(en) 永久授予回执必须含英文永久语义且不含时刻，实际：${enOk}`,
  );
  const enTimed = copy.successText(net, { grant: { cap: 'network', expires_at: timed } });
  check(HHMM.test(enTimed), `(en) 限时授予回执应含时刻，实际：${enTimed}`);
  check(caps.permanentLabel() === en['grants.permanent.label'], `permanentLabel()(en)=${caps.permanentLabel()}`);
  check(caps.expiryParen(null) === en['grants.permanent.paren'], `expiryParen(null)(en)=${caps.expiryParen(null)}`);
  check(caps.untilPhrase(null) === en['grants.until.permanent'], `untilPhrase(null)(en)=${caps.untilPhrase(null)}`);
  const enPreset = copy.presetConfirmMessage(en['grants.preset.net.label'], [{ def: net, scope: {}, expiresAt: null }]);
  check(
    enPreset.toLowerCase().includes(en['grants.permanent.label'].toLowerCase()) && !HHMM.test(enPreset),
    `(en) 永久预设的确认正文必须含英文永久语义且不含时刻，实际：${enPreset}`,
  );
  // zh/en key 集合一致
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  check(zhKeys.join(',') === enKeys.join(','), 'zh/en key 集合必须一致（含 grants 域）');
  i18n.setLocale('zh'); // 复位，避免影响后续
}

/** 取一个 .ts 文件里**字符串字面量**含 `needle` 的情况（注释不算）。 */
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

function walkTs(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** ④ 源码级不变量（新形态：真源搬进 i18n 字典，且反空转）。 */
function checkSources() {
  // (a) grants/** 与 grants.ts：0 个「永久」字面量（原来的 caps.ts 白名单项已取消）
  const grantFiles = walkTs(GRANTS);
  grantFiles.push(path.join(ROOT, 'src', 'ui', 'grants.ts'));
  const offenders = grantFiles
    .filter((f) => literalHas(f, '永久'))
    .map((f) => path.relative(ROOT, f));
  check(
    offenders.length === 0,
    `「永久」字面量不得出现在 src/ui/grants/**（真源已搬进 i18n 字典），却出现在：${offenders.join(', ')}`,
  );
  // (b) src/i18n/locales/zh/** 之外全仓 src：0 个「永久」字面量
  const zhLocale = path.join(ROOT, 'src', 'i18n', 'locales', 'zh');
  const outside = walkTs(path.join(ROOT, 'src'))
    .filter((f) => !f.startsWith(zhLocale + path.sep))
    .filter((f) => literalHas(f, '永久'))
    .map((f) => path.relative(ROOT, f));
  check(
    outside.length === 0,
    `「永久」字面量只许出现在 src/i18n/locales/zh/**，却出现在：${outside.join(', ')}`,
  );
  // (c) 反空转：caps.ts 必须真的引用 i18n 的永久 key
  const capsSrc = read('src/ui/grants/caps.ts');
  check(
    capsSrc.includes("'grants.permanent.label'") || capsSrc.includes("'grants.until.permanent'"),
    'caps.ts 必须引用 i18n 的永久 key（否则「删掉字面量」就能骗过本门禁）',
  );
  // (d) 面板必须走统一出口（原三条，语义不变；常量名随惰性化改为函数）
  check(!/\bhhmm\b/.test(read('src/ui/grants/copy.ts')), 'copy.ts 不得自行调用 hhmm（到期短语必须走 caps.ts）');
  const rowsSrc = read('src/ui/grants/panel/rows.ts');
  check(
    rowsSrc.includes('isPermanentExpiry(') && rowsSrc.includes('expiryParen('),
    'rows.ts 必须用 caps 的 isPermanentExpiry / expiryParen（否则永久条目会显示时刻）',
  );
  check(
    rowsSrc.includes('ttlTempChoices('),
    'rows.ts 的时长选择器只许列 ttlTempChoices()（永久不得回到选择器里）',
  );
}

const { mod, cleanup } = await loadProductionModules();
try {
  // Node 下 detectLocale() 会读到 navigator.language=en-US；先钉到 zh 再跑精确值断言。
  mod.i18n.setLocale('zh');
  checkDefaults(mod);
  checkReserved(mod);
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
  '✓ 授权默认永久门禁通过：默认授予 ttl_sec=0（6 个能力位 + 预设）、zh/en 永久文案均不含时刻、临时档仍可按显式时长授予。',
);
