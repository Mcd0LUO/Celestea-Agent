#!/usr/bin/env node
/**
 * 门禁 · 共用前端「面向用户的技术文案」检查（清单 3 / W517 §7.5；W886 i18n 改造）。
 *
 * 规则一（W517 §7.5）：**会渲染给用户看的文案**里禁止实现细节词：
 *   /api/ · SSE · HTTP␠ · 409 · jsonl · 热调 · 后端 · 前端 · 接口 ·
 *   modified · ev: · lagged · available.models · cache_read · prompt_tokens
 * 规则二（W795）：禁止**进度占位文案**（加载中 / 正在加载 / 切换中 / … / 进行中␠）。
 *   理由见 docs：能立即推出终态的交互一律先画终态；占位文案回流即口径被推翻。
 *
 * W886（i18n 之后，本门禁的扫描对象变了）：
 *   · i18n 之后组件里是英文 key（t('api.error.connect')），中文从组件消失；
 *     若仍只扫「含中文的组件字面量」，门禁会扫不到任何东西、形同虚设。
 *   因此：
 *   ① **规则搬到字典**：对 apps/web/src/i18n/locales/** 的**值**跑同一套 RULES，
 *      中英都扫（英文界面同样不得出现 SSE/409 这类实现细节词）；
 *   ② **护栏 A（防绕过）**：apps/web/src/** 里不得出现中文字符串字面量，
 *      白名单只有 i18n/locales/**（见下方 isLocaleFile）。新代码必须走 t()；
 *   ③ **护栏 B（跑脚本再兜一道）**：zh 与 en 的 key 集合必须一致（不只靠编译期）；
 *   ④ 现有 RULES 一条未删，copy-gate-allow 逃生标记语义不变（整行豁免）。
 *
 * 护栏 A 的过渡机制（方案 a：显式待迁移白名单）：i18n 是分批做的，还有约 90+ 个
 * 文件没抽完。PENDING_MIGRATION 逐文件列出「仍允许含中文」的组件，**棘轮只减不增**：
 *   · 不在名单里却出现中文 ⇒ 失败（新代码绕过 i18n）；
 *   · 名单里但已无中文 ⇒ 仅告警（可收紧，不阻塞 i18n 批次推进）。
 * 为什么选 (a) 而不是 (b)：把「还剩多少没做」变成一个可机械追踪的数字，且不会忘。
 *
 * 排除：注释（AST 层面不存在字符串字面量；HTML 侧先剥注释）；
 *       行内含 copy-gate-allow 标记（显式豁免，需在 review 中给出理由）。
 *
 * 用法：pnpm check:copy（frontend/ 目录下）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根可注入：测试用 CELESTEA_COPY_ROOT 指向 fixture 树；生产不设该变量。
const ROOT = process.env['CELESTEA_COPY_ROOT'] ? path.resolve(process.env['CELESTEA_COPY_ROOT']) : path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const HTML = path.join(ROOT, 'index.html');
const LOCALES = path.join(SRC, 'i18n', 'locales');
const ALLOW_MARK = 'copy-gate-allow';
// 收紧模式：陈旧白名单项（文件已无中文）也失败。默认只告警，避免阻塞 i18n 批次；
// CI 可置 CELESTEA_COPY_STRICT=1 强制「只减不增」。
const STRICT = process.env['CELESTEA_COPY_STRICT'] === '1';

/** 只扫含中文的字面量；下面是禁用词表（词 → 正则）。 */
const CJK = /[\u3400-\u9fff]/;
export const RULES = [
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
  // ---- W795：进度占位文案（守「先画终态、失败回滚」的交互口径） ----
  ['加载中', /加载中/],
  ['加载清单', /加载清单/],
  ['正在加载', /正在加载/],
  ['切换中', /切换中/],
  ['提交中', /提交中/],
  ['正在提交', /正在提交/],
  ['正在读取', /正在读取/],
  ['读取中', /读取中/],
  ['正在应用', /正在应用/],
  ['正在授予', /正在授予/],
  ['正在撤销', /正在撤销/],
  ['进行中（进度）', /进行中\s/],
];

/**
 * 待迁移白名单（方案 a；相对 apps/web/src 的路径）。棘轮只减不增：
 * 新增含中文的文件必须先把文案抽到 i18n/locales，或（确需）在 review 后加进本表。
 */
export const PENDING_MIGRATION = [
  'api.ts',
  'chat.ts',
  'main.ts',
  'plugins/apply.ts',
  'plugins/descriptor.ts',
  'plugins/store.ts',
  'theme.ts',
  'ui/attachment-view.ts',
  'ui/attachments.ts',
  'ui/batchresult.ts',
  'ui/chatcol.ts',
  'ui/commands/builtin.ts',
  'ui/commands/files.ts',
  'ui/commands/goal.ts',
  'ui/commands/index.ts',
  'ui/commands/run.ts',
  'ui/compact.ts',
  'ui/confirm.ts',
  'ui/contextview.ts',
  'ui/fsbrowser.ts',
  'ui/grants/caps.ts',
  'ui/grants/copy.ts',
  'ui/grants/flow.ts',
  'ui/grants/panel/body.ts',
  'ui/grants/panel/phrase.ts',
  'ui/grants/panel/quick.ts',
  'ui/grants/panel/rows.ts',
  'ui/grants/panel/shield.ts',
  'ui/grants/panel/warnings.ts',
  'ui/grants/presets.ts',
  'ui/grants/scope.ts',
  'ui/inputbar.ts',
  'ui/messages/info.ts',
  'ui/messages/scroll.ts',
  'ui/messages/user.ts',
  'ui/messages.ts',
  'ui/mode/copy.ts',
  'ui/preview/panel.ts',
  'ui/preview/renderers.ts',
  'ui/question/card.ts',
  'ui/question/controls.ts',
  'ui/question/format.ts',
  'ui/quote/model.ts',
  'ui/quote/select.ts',
  'ui/quote/tray.ts',
  'ui/rail-card.ts',
  'ui/rail-center.ts',
  'ui/rail.ts',
  'ui/restore.ts',
  'ui/send.ts',
  'ui/sessionbar.ts',
  'ui/sessions.ts',
  'ui/sessiontree/actions.ts',
  'ui/sessiontree/live.ts',
  'ui/sessiontree/newsession.ts',
  'ui/sessiontree/render.ts',
  'ui/sessiontree/workers.ts',
  'ui/sidebar.ts',
  'ui/statusbar.ts',
  'ui/text-attach.ts',
  'ui/toolcards.ts',
  'ui/viewctx.ts',
  'ui/workbench/browser.ts',
  'ui/workbench/files.ts',
  'ui/workbench/menu.ts',
  'ui/workbench/panel.ts',
  'ui/workbench/state.ts',
  'ui/workbench/terminal.ts',
  'ui/worker-strip.ts',
];

/** 相对 SRC 的 POSIX 路径。 */
function relOf(srcDir, file) {
  return path.relative(srcDir, file).split(path.sep).join('/');
}

/** i18n 字典目录：护栏 A 的唯一白名单（这里的中文是**数据**，不是绕过）。 */
export function isLocaleFile(rel) {
  return rel === 'i18n/locales' || rel.startsWith('i18n/locales/');
}

/** 行内逃生标记（整行豁免 RULES 与护栏 A）。 */
function allowMarked(lines, node, sf) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return (lines[line] ?? '').includes(ALLOW_MARK);
}

/** 一行问题（与旧输出格式一致）。 */
function report(problems, where, label, text) {
  problems.push(where + '  [' + label + ']  ' + JSON.stringify(text));
}

/** 对一个字符串字面量跑 RULES。 */
function rulesOf(problems, text, where, exempt) {
  if (exempt) return;
  for (const entry of RULES) {
    if (entry[1].test(text)) report(problems, where, entry[0], text);
  }
}

/** 收集一个字符串/模板节点的文本片段。 */
function piecesOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    const out = [node.head.text];
    for (const span of node.templateSpans) out.push(span.literal.text);
    return out;
  }
  return null;
}

/**
 * 扫一个组件文件：
 *   · 对**含中文**的字面量跑 RULES（与旧行为一致）；
 *   · 护栏 A：中文字面量必须落在待迁移白名单里，否则失败。
 */
function scanComponent(problems, file, rel, allow) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const at = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return rel + ':' + (line + 1);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // 模块路径
    const pieces = piecesOf(node);
    if (pieces !== null) {
      const exempt = allowMarked(lines, node, sf);
      const cjk = pieces.find((p) => CJK.test(p));
      if (cjk !== undefined) {
        rulesOf(problems, cjk, at(node), exempt);
        if (!exempt && !allow.has(rel)) {
          report(problems, at(node), '中文未抽到 i18n（护栏 A）', cjk);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * 扫一个字典文件：只对**属性值**跑 RULES（中英都扫，不过 CJK 门）。
 * key 本身是标识符，不扫。
 */
function scanLocale(problems, file, rel) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const at = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return rel + ':' + (line + 1);
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const pieces = piecesOf(node.initializer);
      if (pieces !== null) {
        const exempt = allowMarked(lines, node.initializer, sf);
        for (const piece of pieces) rulesOf(problems, piece, at(node.initializer), exempt);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** 收集一个字典文件里所有字符串 key（护栏 B 用）。 */
function keysOf(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const keys = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) keys.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

function scanHtml(problems, file) {
  const raw = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ''); // 注释不算文案
  const rel = path.relative(ROOT, file);
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
  const lineTextOf = (idx) => raw.split('\n')[lineOf(idx) - 1] ?? '';
  for (const m of raw.matchAll(/(?:title|placeholder|aria-label)\s*=\s*"([^"]*)"/g)) {
    rulesOf(problems, m[1], rel + ':' + lineOf(m.index), lineTextOf(m.index).includes(ALLOW_MARK));
  }
  for (const m of raw.matchAll(/>([^<>]+)</g)) {
    rulesOf(problems, m[1].trim(), rel + ':' + lineOf(m.index), lineTextOf(m.index).includes(ALLOW_MARK));
  }
}

/**
 * 跑整道门禁，返回 { problems, warnings, stats }。root 可注入（测试用）。
 */
export function runGate(root = ROOT) {
  const src = path.join(root, 'src');
  const html = path.join(root, 'index.html');
  const allow = new Set(PENDING_MIGRATION);
  const problems = [];
  const warnings = [];
  const stats = { scanned: 0, localeFiles: 0, componentFiles: 0, pending: allow.size, remaining: 0, stale: 0 };
  const zhKeys = [];
  const enKeys = [];
  for (const file of walk(src)) {
    const rel = relOf(src, file);
    stats.scanned += 1;
    if (isLocaleFile(rel)) {
      stats.localeFiles += 1;
      scanLocale(problems, file, rel);
      if (rel.startsWith('i18n/locales/zh/')) zhKeys.push(...keysOf(file));
      if (rel.startsWith('i18n/locales/en/')) enKeys.push(...keysOf(file));
    } else {
      stats.componentFiles += 1;
      scanComponent(problems, file, rel, allow);
    }
  }
  scanHtml(problems, html);
  // 护栏 B：zh 与 en 的 key 集合必须一致。
  const zh = [...new Set(zhKeys)].sort();
  const en = [...new Set(enKeys)].sort();
  const onlyZh = zh.filter((k) => !en.includes(k));
  const onlyEn = en.filter((k) => !zh.includes(k));
  for (const k of onlyZh) problems.push('i18n key 只有 zh 有（en 漏译）：' + k);
  for (const k of onlyEn) problems.push('i18n key 只有 en 有（zh 缺失）：' + k);
  // 棘轮：名单里但已无中文 ⇒ 仅告警。
  for (const rel of allow) {
    let hasCjk = false;
    const file = path.join(src, rel);
    try {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
      const visit = (node) => {
        const pieces = piecesOf(node);
        if (pieces !== null) { if (pieces.some((p) => CJK.test(p))) hasCjk = true; return; }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    } catch {
      warnings.push(rel + ': 文件不存在（白名单陈旧）');
      stats.stale += 1;
      continue;
    }
    if (hasCjk) stats.remaining += 1;
    else { warnings.push(rel + ': 已无中文，可从 PENDING_MIGRATION 移除（棘轮收紧）'); stats.stale += 1; }
  }
  stats.zhKeys = zh.length;
  stats.enKeys = en.length;
  return { problems, warnings, stats };
}

function main() {
  const { problems, warnings, stats } = runGate();
  if (STRICT && stats.stale > 0) {
    console.error('✗ CELESTEA_COPY_STRICT=1：PENDING_MIGRATION 有 ' + stats.stale + ' 个陈旧项（文件已无中文），请移除后重跑\n');
    for (const w of warnings) console.error('  ⚠ ' + w);
    process.exit(1);
  }
  if (problems.length) {
    console.error('✗ UI 文案门禁未通过：以下「会渲染给用户的中文文案」含实现细节词，或有绕过 i18n 的中文\n');
    for (const p of problems) console.error('  ' + p);
    console.error('\n共 ' + problems.length + ' 处。改用用户语言，或（确有理由时）在同行加 ' + ALLOW_MARK + ' 标记；' +
      '新文案请抽到 i18n/locales（zh/en 都要，key 一致）。');
    process.exit(1);
  }
  for (const w of warnings) console.log('  ⚠ ' + w);
  console.log('✓ UI 文案门禁通过：locales 值（zh ' + stats.zhKeys + ' / en ' + stats.enKeys + ' 条，中英同扫）无实现细节词；' +
    'src 组件无绕过 i18n 的中文（待迁移白名单 ' + stats.pending + ' 个，其中仍有中文 ' + stats.remaining + ' 个，陈旧 ' + stats.stale + ' 个）；' +
    'zh/en key 集合一致。');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
