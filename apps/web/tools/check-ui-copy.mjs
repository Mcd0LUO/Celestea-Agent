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
 * 护栏 D（W9109）——**HTML 里的 CJK**：index.html 的**文本节点 / title / placeholder /
 *   aria-label** 含中文即失败（同行 copy-gate-allow 豁免；HTML 注释不算文案）。
 *   为什么需要：护栏 A 只扫 apps/web/src/** 的字符串字面量，**不含 .html** —— 静态骨架里
 *   的硬编码中文因此完全逃过「必须走 i18n」的机械检查，这正是设置页在英文界面下残留
 *   中文能攒下来的结构性原因（W9109 实测：index.html 里 50 处 CJK，只有 11 个
 *   data-i18n* 属性）。文案一律走 data-i18n* + locales（locales 是唯一允许中文的地方）。
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

/**
 * 汉字区（guard A / guard C / 棘轮用）。
 *   **刻意不含全角标点**：`'、'` / `'：'` / `'（）'` 这类分隔符在 TS 里是合法的
 *   排版字符（实测 12 处，如 ui/usage/panel.ts:76 的 `join('、')`），把它们当「未抽到
 *   i18n 的中文」是误报 —— guard A 拦的是「整句中文文案」，不是标点。
 */
const CJK = /[\u3400-\u9fff]/;

/**
 * 界面文案面（guard D 用）—— 汉字 + 假名 + 韩文 + 全角标点/半角片假名。
 *
 * 为什么这里可以比 CJK 宽：guard D 扫的是**已经渲染给用户的位点**（HTML 属性/文本节点、
 * CSS content），全角标点出现在这些位置就是中文残留（英文界面不该有 `、` `：` `（）`），
 * 而在 TS 源码里它常常只是 `join` 的分隔符。实测：换成这一套后真实树的新增命中为
 * HTML 0 处、CSS 2 处（正是 views.css 的两句中文），无误报。
 *
 * `\u3000`（表意空格）刻意排除：它是纯排版空白，与文案无关。
 */
const CJK_UI = /[\u3001-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF01-\uFFEF\uFF61-\uFF9F]/;
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
  'ui/quote/model.ts',
  // ↑ 引用块的 wire 格式（序列化 + 正则解析）：协议 token，**不译**（翻译会破坏往返）
  'ui/text-attach.ts',
  // ↑ 仍含 4 处 wire 格式 token（注入块定界行 / 转义标记 /「[文件 …]」头）：协议不译
];

/** 相对 srcDir 的 POSIX 路径。 */
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

/**
 * 是否处在 `console.*` 调用的实参里。
 *   开发诊断（console.log/warn/error）**不会渲染给用户**，故不计入护栏 A（也不算 RULES）。
 *   注意：`throw new Error('中文')` **不豁免** —— 本仓多处 `err.message` 会经
 *   catch 渲染到界面（如 commands/goal.ts 的「目标没有保存：…」），属用户可见。
 *   向上只穿过表达式节点，遇到语句/源文件边界即停，避免误吞同语句里的其它字面量。
 */
function inConsoleCall(node) {
  let p = node.parent;
  while (p) {
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      ts.isIdentifier(p.expression.expression) &&
      p.expression.expression.text === 'console'
    ) {
      return true;
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
    p = p.parent;
  }
  return false;
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
      if (inConsoleCall(node)) return; // 开发诊断：不渲染给用户，护栏 A 与 RULES 都不适用
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

/**
 * 护栏 C（W1520）：**死键检测** —— 字典里定义了、但没有任何消费方引用的 key。
 *
 * 为什么需要：护栏 B 只保证 zh/en 两边 key **集合一致**，两边一起长一个没人用的
 * key 它是看不见的。W1520 就是这样攒出来的 —— 删掉成功提示的调用点后，
 * `statusline.mode.switched` 只剩两条字典定义悬在那里；而它**不是孤例**：
 * 首次跑本门禁时全仓已有 12 个这样的键（跨 6 个批次攒下来的）。
 *
 * 判定口径（刻意保守，宁可漏报不可误报）：
 *   · 引用语料 = apps/web/**（含 index.html 的 data-i18n*）+ tests/** + scripts/**，
 *     **排除 i18n/locales/** 自身 —— 否则每个 key 都会「引用自己」而全部通过；
 *   · 支持三种字面量写法（'k' / "k" / `k`），因为 data-i18n 属性走双引号；
 *   · 不做动态拼接识别：全仓 0 处 t(`...${...}`)，若将来出现，这里会**误报**，
 *     届时把该 key 加进 DEAD_KEY_ALLOW（并在注释里写明为什么它无法被静态看到）。
 *
 * `common.brand` 是**已知且刻意**的例外：i18n/index.ts:9 明文规定品牌名不译、
 * 原样出现在两种字典里 —— 它没有调用点是正确的，不是债务。
 */
const DEAD_KEY_ALLOW = new Set(['common.brand']);

/**
 * 动态构造的 key **前缀**（W1520 补）。全仓只有一处：
 * `plugins/descriptor.ts:130` 的 `('settings.plugins.cat.' + c)`（c ∈ CLIENT_PLUGIN_CATEGORIES）。
 * 静态扫描看不见这种拼接，会把 4 个**活的**分类键误判成死键 —— 这是本门禁第一版
 * 真实踩到的坑（把 4 个键删了，tests/w895l-plugin-library.test.ts 立刻红）。
 * 前缀命中即视为「可能被引用」，宁可漏报不可误报。
 * 新增动态拼接时必须在此登记，并在注释里写明拼接点。
 */
const DYNAMIC_KEY_PREFIXES = ['settings.plugins.cat.'];

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

/**
 * 测试文件**不进产物**，所以它们的用例名（it("中文")）永远不可能渲染给用户 ——
 * 护栏 A 的语义是「新代码把用户可见文案写死」，对测试不适用（W895：给 apps/web 开测试面时暴露）。
 * 只排除 `*.test.ts`；断言里的中文文案仍由「组件文件」路径覆盖。
 */
function isTestFile(name) {
  return name.endsWith('.test.ts');
}

/** 护栏 C 的语料遍历：任意文本文件，含 index.html / tests / scripts。 */
function* walkAny(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walkAny(p);
    else if (/\.(ts|mjs|js|html|json)$/.test(name)) yield p;
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith('.ts') && !isTestFile(name)) yield p;
  }
}

/**
 * 剥 HTML 注释，但**保持字符偏移与行号**：每个注释换成等长的空格（换行保留）。
 *
 * 为什么不能直接删（旧的 `replace(/<!--[\s\S]*?-->/g, '')`）：删掉多行注释会挪动
 * 后续所有字符的偏移与行号，报告里的 `:行号` 会指到别的行。等长替换后偏移与行号
 * 都与原文一致，**行文本仍取自原文**（这样 `copy-gate-allow` 写在 HTML 注释里也认）。
 */
function blankHtmlComments(raw) {
  return raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

/** HTML 扫描的公共取数：注释已抹平的正文 + 原文行表（行号/行文本同源）。 */
function htmlScanText(file) {
  const raw = readFileSync(file, 'utf8');
  return { body: blankHtmlComments(raw), rawLines: raw.split('\n') };
}

/**
 * 剥 CSS 注释，同样**等长替换**（换行保留）—— 与 blankHtmlComments 同一理由：
 * styles 下 30% 的字节是注释、且注释里大量出现中文（views.css 一个文件就有 382 个
 * CJK 字符全是注释）。若直接删注释，行号会整体前移，报告里的 `:行号` 全部指错。
 */
function blankCssComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

/** 解码 HTML 实体（命名 5 个 + 十进制 + 十六进制）。
 *  为什么必须解：`&#x901a;&#x7528;` 在源码里是纯 ASCII，CJK 正则看不见它，
 *  但浏览器会渲染成「通用」—— 实测这是 guard D 最现实的绕过路径。 */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const cp = parseInt(d, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** 解码 CSS 字符串里的转义（`\4e0b` / `\00b7`）。
 *  为什么必须解：CSS 允许用十六进制转义写任意字符，`content: '\4e0b\4e00\6b65'`
 *  源码里同样全是 ASCII —— 与 HTML 实体是同一类绕过。 */
function decodeCssEscapes(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ ]?/g, (m, h) => {
    const cp = parseInt(h, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

/**
 * 非文案属性白名单（**结构/技术**属性，其值不是给用户看的文字）。
 *   · class/id/style/src/href/... 是机器标识或资源地址；
 *   · data-i18n* 的值是 **key**（不是文案）—— key 的存在性由
 *     tests/w9109-i18n-static-dom.test.ts 与 guard B 分别兜住，本处不重复判；
 *   · aria-hidden/role/tabindex/... 是语义开关，值取自固定枚举。
 * 默认**全扫**（fail-safe）：将来新增的文案属性（如 aria-valuetext）自动被覆盖，
 * 只有显式登记在这里的属性才跳过。
 */
const NOT_COPY_ATTRS = new Set([
  'class', 'id', 'style', 'src', 'href', 'name', 'type', 'rel', 'charset', 'content',
  'tabindex', 'role', 'spellcheck', 'focusable', 'lang',
  'data-theme', 'data-page', 'data-pane',
  'data-i18n', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-placeholder',
  'aria-hidden', 'aria-haspopup', 'aria-live', 'aria-atomic', 'aria-orientation',
  'aria-modal', 'aria-labelledby',
  'viewBox', 'transform', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height',
  'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
]);

/** 取 HTML 里**所有文案位点**（属性值 + 文本节点），值已做实体解码。 */
function* htmlCopySites(body) {
  for (const m of body.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (NOT_COPY_ATTRS.has(m[1])) continue;
    yield { text: decodeEntities(m[2] ?? m[3] ?? ''), index: m.index, attr: m[1] };
  }
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    yield { text: decodeEntities(m[1]).trim(), index: m.index, attr: null };
  }
}

function scanHtml(problems, file, root = ROOT) {
  const { body, rawLines } = htmlScanText(file);
  const rel = relOf(root, file);
  const lineOf = (idx) => body.slice(0, idx).split('\n').length;
  const lineTextOf = (idx) => rawLines[lineOf(idx) - 1] ?? '';
  for (const m of body.matchAll(/(?:title|placeholder|aria-label)\s*=\s*"([^"]*)"/g)) {
    rulesOf(problems, m[1], rel + ':' + lineOf(m.index), lineTextOf(m.index).includes(ALLOW_MARK));
  }
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    rulesOf(problems, m[1].trim(), rel + ':' + lineOf(m.index), lineTextOf(m.index).includes(ALLOW_MARK));
  }
}

/**
 * 护栏 D（W9109）：index.html 里**面向用户**的文本节点 / title / placeholder / aria-label
 * 不得含 CJK。
 *
 * 口径（与 scanHtml 共用同一套提取，保证「规则一扫到的」与「护栏 D 扫到的」是同一批文本）：
 *   · 先剥 HTML 注释（注释是给维护者看的，不是文案，剥法与 scanHtml 逐字相同）；
 *   · 属性取 title / placeholder / aria-label；文本节点取 >…< 之间的内容；
 *   · 同行含 copy-gate-allow ⇒ 整条豁免（逃生标记语义与护栏 A 一致，不新增口径）；
 *   · 只拦 CJK：英文界面下的残留中文是本次要治的病；英文文案由规则一继续管。
 *
 * 不查 data-i18n* 的**值**（那是 key，不是文案）——key 的存在性/双语覆盖由
 * tests/w9109-i18n-static-dom.test.ts 与护栏 B 分别机械兜住。
 */
function scanHtmlCjk(problems, file, root = ROOT) {
  const { body, rawLines } = htmlScanText(file);
  const rel = relOf(root, file);
  const lineOf = (idx) => body.slice(0, idx).split('\n').length;
  const lineTextOf = (idx) => rawLines[lineOf(idx) - 1] ?? '';
  const check = (text, idx, attr) => {
    const value = text.trim();
    if (value === '' || !CJK_UI.test(value)) return;
    if (lineTextOf(idx).includes(ALLOW_MARK)) return;
    const where = attr === null ? '' : ' @' + attr;
    report(problems, rel + ':' + lineOf(idx) + where, '中文未抽到 i18n（护栏 D）', value);
  };
  for (const site of htmlCopySites(body)) check(site.text, site.index, site.attr);
}

/**
 * 护栏 D 的 **CSS 面**（W9203）：styles 下的 `content:` 文案不得含 CJK。
 *
 * 为什么必须有：`.who::after { content: ' · 下一步送达' }` 这类中文既不是 DOM 文本节点、
 * 也不是 .ts 字面量 —— guard A 的 walk() 只 yield `*.ts`，guard D 原先只读 index.html，
 * 于是它**同时**落在两道护栏的缝里，并随产物发布（dist 的 CSS 里实测 11 个 CJK 字符，
 * 英文界面下每个插话/排队气泡的用户名后面都跟着中文后缀）。
 *
 * 口径（与 HTML 面共用同一套判定）：
 *   · 先**等长**剥注释（styles 下 30% 字节是注释，且注释里大量中文 —— 直接删会挪行号）；
 *   · 只取**带引号的字符串**（`content: '…'` / `"…"`），并解 CSS 十六进制转义
 *     （`\4e0b` 与 HTML 实体是同一类绕过）；
 *   · 空串 / 纯符号（`'·'` `'▸'` `'\00b7'`）天然不含 CJK，不会误报；
 *   · 同行含 copy-gate-allow ⇒ 豁免（与 guard A/D 同语义）。
 *
 * 不扫 CSS 的注释、选择器、属性名与数值 —— 那些不是文案，且实测真实树 0 命中。
 */
function scanCssCjk(problems, file, root = ROOT) {
  const raw = readFileSync(file, 'utf8');
  const body = blankCssComments(raw);
  const rawLines = raw.split('\n');
  const rel = relOf(root, file);
  const lineOf = (idx) => body.slice(0, idx).split('\n').length;
  const check = (text, idx) => {
    const value = decodeCssEscapes(text).trim();
    if (value === '' || !CJK_UI.test(value)) return;
    if ((rawLines[lineOf(idx) - 1] ?? '').includes(ALLOW_MARK)) return;
    report(problems, rel + ':' + lineOf(idx), '中文未抽到 i18n（护栏 D · CSS）', value);
  };
  for (const m of body.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) check(m[1] ?? m[2] ?? '', m.index);
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
  scanHtml(problems, html, root);
  scanHtmlCjk(problems, html, root); // 护栏 D：静态骨架不得含未抽到 i18n 的中文
  // 护栏 D · CSS 面（W9203）：styles 的 content 文案同样不得含未抽到 i18n 的中文。
  // 注意 styles 目录**不在** walk(src) 里（那个 walk 只 yield *.ts），故这里单独遍历。
  const stylesDir = path.join(src, 'styles');
  try {
    for (const name of readdirSync(stylesDir).sort()) {
      if (!name.endsWith('.css')) continue;
      stats.cssFiles = (stats.cssFiles ?? 0) + 1;
      scanCssCjk(problems, path.join(stylesDir, name), src);
    }
  } catch {
    /* 没有 styles 目录（fixture 树常见）不阻塞 */
  }
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
      const lines = text.split('\n');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
      const visit = (node) => {
        const pieces = piecesOf(node);
        if (pieces !== null) {
          // 与护栏 A 同口径：console 实参与 copy-gate-allow 行都不算「未迁移的中文」。
          if (!inConsoleCall(node) && !allowMarked(lines, node, sf) && pieces.some((p) => CJK.test(p))) hasCjk = true;
          return;
        }
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
  // 护栏 C：死键（定义了但无消费方）。语料**必须排除 locales 自身** —— 否则每个 key
  // 都在字典里「引用自己」，全部通过（这是本门禁第一版的真实 bug，注入死键仍报绿）。
  const localesDir = path.join(src, 'i18n', 'locales');
  const refFiles = [];
  for (const r of [src, path.join(root, '..', '..', 'tests'), path.join(root, '..', '..', 'scripts')]) {
    try { for (const f of walkAny(r)) refFiles.push(f); } catch { /* 目录缺失不阻塞 */ }
  }
  refFiles.push(html);
  const consumers = refFiles.filter((f) => !f.startsWith(localesDir));
  const refText = consumers.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const deadKeys = [];
  for (const k of zh) {
    if (DEAD_KEY_ALLOW.has(k)) continue;
    if (DYNAMIC_KEY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (!refText.includes("'" + k + "'") && !refText.includes('"' + k + '"') && !refText.includes('`' + k + '`')) deadKeys.push(k);
  }
  for (const k of deadKeys) problems.push('i18n 死键（定义了但无任何消费方）：' + k + ' —— 删掉它，或若确为刻意保留则加进 DEAD_KEY_ALLOW 并写明理由');
  stats.deadKeys = deadKeys.length;
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
    'index.html 文本/属性（全属性 + 单双引号 + 实体解码）与 styles 的 content（' +
    (stats.cssFiles ?? 0) + ' 个 CSS）无未抽到 i18n 的中文（护栏 D）；' +
    'zh/en key 集合一致；死键 ' + (stats.deadKeys ?? 0) + ' 个。');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
