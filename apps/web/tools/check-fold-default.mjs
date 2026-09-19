#!/usr/bin/env node
/**
 * 门禁 · W752：思考段 / 工具卡「默认折叠」守护。
 *
 * 背景：思考段与工具卡必须默认折叠（live 追加与历史恢复两条路径一致），
 * 可正常展开/收起。历史回归点有三个，任何一个被改回去都要机械失败：
 *   ① 折叠类挂错元素 —— CSS 选择器是 `.msg.think-seg.collapsed …`；把类挂在
 *      .mcol 根上选择器永不命中（= 点了没反应、永远展开，W752 修的就是这个）。
 *   ② 作者样式 `display:flex` 盖掉关闭态 <details> 的 UA 隐藏 → 工具卡「没 open
 *      却摊开正文」，所以必须有 `.toolcard:not([open]) > .toolcard-body`。
 *   ③ live 与恢复各写一份构造代码 → 默认态分叉（恢复会话后变回全展开）。
 *   W778 追加一条：工具卡折叠态必须**只有一行摘要** —— 参数/结果预览若回到 summary，
 *   折叠态就又变成「半截展开」（本条断言会机械失败，见下方 §4）。
 *
 * 做法（不引入任何新依赖 —— 复用 vite 已带的 esbuild）：
 *   1) 用 esbuild 把 src/ui/{messages,toolcards,restore}.ts 打成一份 ESM 包
 *      （node 不能直接 import 这些模块：相对导入无扩展名，且非纯函数模块）；
 *   2) 装上约 150 行最小 DOM 垫片（createElement / classList / details 的 open↔toggle）；
 *   3) **跑真实生产代码**：appendThinking（live 路径）、restoreSessionHistory
 *      （历史恢复路径，fetch 打桩喂固定历史）、buildToolCard/setToolResult，
 *      断言产出的 DOM 折叠态、箭头字形、aria-expanded 与 open 状态；
 *   4) 静态断言两条路径共用同一构造器 + CSS 兜底规则在位。
 *
 * 用法：node tools/check-fold-default.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ 最小 DOM */

class ClassList {
  constructor(node) {
    this.node = node;
  }
  _list() {
    return String(this.node.className || '')
      .split(/\s+/)
      .filter((s) => s !== '');
  }
  add(...cls) {
    const l = this._list();
    for (const c of cls) if (c && !l.includes(c)) l.push(c);
    this.node.className = l.join(' ');
  }
  remove(...cls) {
    this.node.className = this._list()
      .filter((c) => !cls.includes(c))
      .join(' ');
  }
  contains(c) {
    return this._list().includes(c);
  }
  toggle(c, force) {
    const has = this.contains(c);
    const on = force === undefined ? !has : !!force;
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
  toString() {
    return this.node.className;
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.attrs = new Map();
    this._text = '';
    this._listeners = new Map();
    this.classList = new ClassList(this);
    this.style = {};
    this.dataset = {};
    this.tabIndex = 0;
    this.title = '';
    this.type = '';
    this.id = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
    if (this.tagName === 'DETAILS') this._open = false;
  }
  get open() {
    return this._open === true;
  }
  set open(v) {
    const next = !!v;
    if (next === this._open) return;
    this._open = next;
    if (next) this.attrs.set('open', ''); // 属性与状态同步（浏览器同款语义）
    else this.attrs.delete('open');
    this.fire('toggle'); // 浏览器在展开态变化后派发 toggle
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = v === undefined || v === null ? '' : String(v);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get children() {
    return this.childNodes.filter((c) => c instanceof El);
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n, ref) {
    const i = this.childNodes.indexOf(ref);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }
  after(node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p.insertBefore(node, p.childNodes[i + 1] ?? null);
  }
  setAttribute(k, v) {
    this.attrs.set(String(k), String(v));
  }
  getAttribute(k) {
    return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(String(k));
  }
  removeAttribute(k) {
    this.attrs.delete(String(k));
  }
  compareDocumentPosition() {
    return 0; // 垫片不做文档序：appendThinking 的重排分支自然跳过
  }
  addEventListener(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(cb);
  }
  fire(type, ev = {}) {
    for (const cb of this._listeners.get(type) ?? []) {
      cb({
        type,
        preventDefault() {},
        stopPropagation() {},
        ...ev,
      });
    }
  }
  click() {
    this.fire('click');
  }
  matches(sel) {
    return sel.split(',').some((one) => {
      const s = one.trim();
      if (s === '') return false;
      const m = /^([a-zA-Z]+)?((?:\.[\w-]+)*)$/.exec(s);
      if (!m) throw new Error('垫片不支持的选器：' + sel);
      const tag = m[1];
      const classes = m[2];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const c of classes.split('.').filter(Boolean)) {
        if (!this.classList.contains(c)) return false;
      }
      return true;
    });
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c instanceof El) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function installDom() {
  globalThis.document = {
    createElement: (tag) => new El(tag),
    createDocumentFragment: () => new El('#fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
  };
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  globalThis.window = globalThis;
  // node 自带只读 navigator（复制按钮点击路径才用得到，这里只是备好垫片）
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
}

/* -------------------------------------------------------------- 断言小工具 */

const problems = [];
const checks = [];
function ok(name) {
  checks.push(name);
}
function eq(actual, expected, name) {
  if (actual === expected) ok(name);
  else
    problems.push(
      `${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`,
    );
}
function truthy(v, name) {
  if (v) ok(name);
  else problems.push(`${name}（实际为假值 ${JSON.stringify(v)}）`);
}

/* ------------------------------------------------------------------ 主流程 */

/* W765：折叠指示由字形（▸/▾）改为内联 SVG chevron，方向落在 data-fold 上。
   断言从「字形文本相等」等价迁移为「折叠态取值相等」+「确实是 SVG」，
   语义一一对应：collapsed ≡ 旧 ▸（指向右），expanded ≡ 旧 ▾（指向下）。 */
const FOLD_COLLAPSED = 'collapsed'; // 折叠态 data-fold（等价旧 ▸）
const FOLD_EXPANDED = 'expanded'; // 展开态 data-fold（等价旧 ▾）

async function loadBundle() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'w752-fold-'));
  const out = path.join(tmp, 'bundle.mjs');
  const entry = `
export { buildThinkSeg, appendThinking, endTurn, THINK_FOLD_COLLAPSED, THINK_FOLD_EXPANDED, thinkFoldedHint } from './src/ui/messages.ts';
export { buildToolCard, setToolResult, toolDescLabel, descFromArgs } from './src/ui/toolcards.ts';
export { restoreSessionHistory } from './src/ui/restore.ts';
`;
  await build({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'w752-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: out,
    logLevel: 'warning',
  });
  const mod = await import(pathToFileURL(out).href);
  rmSync(tmp, { recursive: true, force: true });
  return mod;
}

/** 造一个够 restoreSessionHistory / appendThinking 用的假会话容器。 */
function fakePane(host) {
  return {
    id: 'w752-fixture',
    el: host,
    hint: new El('div'),
    streaming: false,
    assistant: null,
    lastTextCol: null,
    thinkSeg: null,
    restoreOps: new Map(),
    histToolStep: 0,
    restored: false,
    dedup: { tail: null, guardActive: false, guardBuf: '', guardAll: false },
  };
}

async function main() {
  installDom();
  const M = await loadBundle();

  const HISTORY = {
    messages: [
      { role: 'thinking', content: '恢复路径：先想一下 A 再做 B。' },
      {
        role: 'tool',
        kind: 'call',
        tool_call_id: 'c1',
        tool_name: 'read_file',
        tool_args: { path: 'a.ts', desc: '读取 a.ts 的头部' },
      },
      { role: 'tool', kind: 'result', tool_call_id: 'c1', tool_value: 'file body' },
    ],
  };

  /* ---- 1 恢复路径（真实 restoreSessionHistory + 真实渲染器） ---------------- */
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => HISTORY });
  const host = new El('div');
  const pane = fakePane(host);
  await M.restoreSessionHistory(pane);

  const restoredThink = host.querySelector('.msg.think-seg');
  truthy(restoredThink !== null, '恢复路径：渲染出思考段');
  truthy(
    restoredThink.classList.contains('collapsed'),
    '恢复路径：思考段根节点带 collapsed（默认折叠）',
  );
  eq(
    restoredThink.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_COLLAPSED,
    '恢复路径：折叠态 data-fold=collapsed（等价旧「实心三角 ▸」）',
  );
  truthy(
    /<svg/.test(String(restoredThink.querySelector('.think-fold-mark').innerHTML)) &&
      M.THINK_FOLD_COLLAPSED === FOLD_COLLAPSED &&
      /\.think-fold-mark\[data-fold='collapsed'\]\s+svg\s*\{[^}]*rotate\(0deg\)/.test(
        readFileSync(path.join(ROOT, 'src/styles/components.css'), 'utf8'),
      ),
    '恢复路径：折叠指示是内联 SVG chevron（不再是字形），且 CSS 按 data-fold 定方向',
  );
  eq(
    restoredThink.querySelector('.think-head').getAttribute('aria-expanded'),
    'false',
    '恢复路径：aria-expanded=false',
  );
  eq(
    restoredThink.querySelector('.think-seg-folded').textContent,
    M.thinkFoldedHint(),
    '恢复路径：折叠占位文案在位',
  );
  eq(
    restoredThink.querySelector('.think-seg-body').textContent,
    '恢复路径：先想一下 A 再做 B。',
    '恢复路径：正文内容保留（折叠不丢内容）',
  );
  truthy(
    !restoredThink.parentNode.classList.contains('collapsed'),
    '恢复路径：折叠类不在 .mcol 根上（CSS 选择器能命中）',
  );

  const restoredCard = host.querySelector('.toolcard');
  truthy(restoredCard !== null, '恢复路径：渲染出工具卡');
  eq(restoredCard.tagName, 'DETAILS', '恢复路径：工具卡是 details 元素');
  eq(restoredCard.open, false, '恢复路径：工具卡 open=false（默认折叠）');
  truthy(!restoredCard.hasAttribute('open'), '恢复路径：工具卡没有 open 属性');
  eq(
    restoredCard.querySelector('.toolcard-head').getAttribute('aria-expanded'),
    'false',
    '恢复路径：工具卡 aria-expanded=false',
  );
  // W778：历史恢复路径同样吃 args.desc，且折叠行只有一行（预览不在 summary 里）
  eq(
    restoredCard.querySelector('.toolcard-name').textContent,
    '读取 a.ts 的头部',
    '恢复路径：折叠行标签取 args.desc',
  );
  const restoredHead = restoredCard.querySelector('.toolcard-head');
  truthy(
    restoredHead.querySelector('.toolcard-args-preview') === null &&
      restoredHead.querySelector('.toolcard-result-preview') === null,
    '恢复路径：参数/结果预览不在 summary 里（折叠态是单行）',
  );
  eq(
    restoredCard.querySelector('.toolcard-fold').getAttribute('data-fold'),
    'collapsed',
    '恢复路径：折叠指示 data-fold=collapsed',
  );
  truthy(
    /<svg/.test(String(restoredCard.querySelector('.toolcard-fold').innerHTML)),
    '恢复路径：折叠指示是内联 SVG chevron（不是字形）',
  );
  eq(restoredHead.children.length, 1, '恢复路径：summary 只有一个行容器（真单行）');

  /* ---- 2 live 路径：流式期间自动展开，结束自动折回 -------------------------- */
  const liveHost = new El('div');
  const live = fakePane(liveHost);
  live.streaming = true; // 本轮正在跑
  M.appendThinking(live, '先看目录');
  M.appendThinking(live, '，再改文件。');
  const liveSeg = liveHost.querySelector('.msg.think-seg');
  truthy(liveSeg !== null, 'live 路径：appendThinking 产出思考段');
  truthy(
    !liveSeg.classList.contains('collapsed'),
    'live 路径（流式中）：自动展开，让用户实时看到思考',
  );
  eq(
    liveSeg.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_EXPANDED,
    'live 路径（流式中）：data-fold=expanded（等价旧「空心三角 ▾」）',
  );
  eq(
    liveSeg.querySelector('.think-seg-body').textContent,
    '先看目录，再改文件。',
    'live 路径：增量拼接正文（同一段，不重建）',
  );

  M.endTurn(live); // 流式结束（段落封口 / 新轮开始都会走这里）
  truthy(liveSeg.classList.contains('collapsed'), 'live 路径（结束）：自动折回 collapsed 终态');
  eq(
    liveSeg.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_COLLAPSED,
    'live 路径（结束）：data-fold 回到 collapsed（等价旧「实心三角 ▸」）',
  );
  eq(
    liveSeg.querySelector('.think-head').getAttribute('aria-expanded'),
    'false',
    'live 路径（结束）：aria-expanded=false',
  );

  // 用户手动点击折叠/展开必须真的生效（老代码把类挂在 .mcol 根上 → 点了没反应）
  liveSeg.querySelector('.think-head').click();
  truthy(
    !liveSeg.classList.contains('collapsed'),
    '交互：点击标题行展开（折叠类挂在 .msg.think-seg 上，CSS 能命中）',
  );
  eq(
    liveSeg.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_EXPANDED,
    '交互：展开后 data-fold=expanded',
  );
  liveSeg.querySelector('.think-head').click();
  truthy(liveSeg.classList.contains('collapsed'), '交互：再点收回');
  eq(
    liveSeg.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_COLLAPSED,
    '交互：收回后 data-fold=collapsed',
  );
  liveSeg.querySelector('.think-head').click(); // 用户手动展开
  M.endTurn(live);
  truthy(
    !liveSeg.classList.contains('collapsed'),
    '交互：用户手动展开后，段结束的自动折叠不覆盖用户意图',
  );

  // 非流式到达（重连补发 / 无 status start）→ 创建即折叠
  const coldHost = new El('div');
  const cold = fakePane(coldHost); // streaming = false
  M.appendThinking(cold, '离线补发的思考');
  const coldSeg = coldHost.querySelector('.msg.think-seg');
  truthy(coldSeg.classList.contains('collapsed'), 'live 路径（非流式）：创建即折叠');
  eq(
    coldSeg.querySelector('.think-fold-mark').getAttribute('data-fold'),
    FOLD_COLLAPSED,
    'live 路径（非流式）：data-fold=collapsed',
  );

  // 折叠态建好后转为流式（重连补发场景）→ 后续增量自动展开
  cold.streaming = true;
  M.appendThinking(cold, '…继续想');
  truthy(!coldSeg.classList.contains('collapsed'), 'live 路径：折叠态建好后转入流式 → 增量自动展开');
  // 用户手动收起后，流式增量不得强行展开（用户意图优先）
  coldSeg.querySelector('.think-head').click();
  truthy(coldSeg.classList.contains('collapsed'), '交互：流式中用户手动收起生效');
  M.appendThinking(cold, '…再补一段');
  truthy(coldSeg.classList.contains('collapsed'), '交互：用户收起后，流式增量不强行展开');
  eq(
    coldSeg.querySelector('.think-seg-body').textContent,
    '离线补发的思考…继续想…再补一段',
    'live 路径：收起状态下增量仍然累积（展开即见全文）',
  );

  /* ---- 3 两条路径默认态一致（同一构造器 = 结构上不可能分叉） ---------------- */
  const a = M.buildThinkSeg({ text: 'x' });
  const b = M.buildThinkSeg({ text: 'y', collapsed: true });
  eq(a.msg.className, b.msg.className, '构造器：缺省参数与显式 collapsed:true 同态');
  eq(
    a.msg.className,
    restoredThink.className,
    '一致性：live 构造器默认类名 == 恢复路径产出的类名',
  );
  eq(
    a.foldMark.textContent,
    restoredThink.querySelector('.think-fold-mark').textContent,
    '一致性：两条路径箭头字形相同',
  );
  truthy(
    !M.buildThinkSeg({ collapsed: false }).msg.classList.contains('collapsed'),
    '构造器：collapsed:false 时确实不折叠',
  );

  /* ---- 4 工具卡：单行折叠态 + 预览在展开区 + 全程不丢 open ------------------ */
  const ref = M.buildToolCard({
    step: 1,
    name: 'read_file',
    argsText: '{"path":"a.ts"}',
    desc: '  读取   a.ts 头部  ',
  });
  eq(ref.card.open, false, '工具卡：构建即 open=false');
  eq(
    ref.card.querySelector('.toolcard-head').getAttribute('aria-expanded'),
    'false',
    '工具卡：构建 aria-expanded=false',
  );
  M.setToolResult(ref, 'file body', false);
  eq(ref.card.open, false, '工具卡：结果到达不自动展开');
  eq(
    ref.card.querySelector('.toolcard-head').getAttribute('aria-expanded'),
    'false',
    '工具卡：结果到达后 aria 仍为 false',
  );
  eq(ref.resultPv.textContent, '结果：file body', '工具卡：结果预览照旧回填（元素没换）');
  truthy(ref.body.querySelector('.tool-out') !== null, '工具卡：结果全文进 body');
  // W778：折叠态单行 —— 预览必须在 body 里，summary 里一个都不许有
  truthy(
    ref.body.querySelector('.toolcard-args-preview') !== null &&
      ref.body.querySelector('.toolcard-result-preview') !== null,
    '工具卡 W778：参数/结果预览都在 .toolcard-body 内（仅展开可见）',
  );
  const refHead = ref.card.querySelector('.toolcard-head');
  truthy(
    refHead.querySelector('.toolcard-args-preview') === null &&
      refHead.querySelector('.toolcard-result-preview') === null,
    '工具卡 W778：summary 里没有任何预览行（折叠态不是半截展开）',
  );
  eq(refHead.children.length, 1, '工具卡 W778：summary 只有一个行容器（真单行）');
  eq(
    ref.card.querySelector('.toolcard-name').textContent,
    '读取 a.ts 头部',
    '工具卡 W778：折叠行标签 = args.desc（折叠空白）',
  );
  eq(
    M.toolDescLabel('x'.repeat(80), 'read_file'),
    'x'.repeat(60) + '…',
    '工具卡 W778：desc 超过 60 字符即截断',
  );
  eq(
    M.toolDescLabel('   ', 'read_file'),
    'read_file',
    '工具卡 W778：desc 空白 → 回落工具名',
  );
  eq(M.toolDescLabel(undefined, 'read_file'), 'read_file', '工具卡 W778：desc 缺失 → 回落工具名');
  eq(
    M.descFromArgs({ path: 'a.ts', desc: '读文件' }),
    '读文件',
    '工具卡 W778：descFromArgs 从对象取 desc',
  );
  eq(
    M.descFromArgs({ path: 'a.ts' }),
    '',
    '工具卡 W778：descFromArgs 无 desc 时返回空串',
  );
  eq(
    ref.card.querySelector('.toolcard-fold').getAttribute('data-fold'),
    'collapsed',
    '工具卡 W778：构建即 data-fold=collapsed',
  );
  truthy(
    /<svg/.test(String(ref.card.querySelector('.toolcard-fold').innerHTML)),
    '工具卡 W778：折叠指示是内联 SVG chevron',
  );
  ref.card.open = true;
  eq(
    ref.card.querySelector('.toolcard-head').getAttribute('aria-expanded'),
    'true',
    '工具卡：展开后 aria-expanded=true（toggle 同步）',
  );
  eq(
    ref.card.querySelector('.toolcard-fold').getAttribute('data-fold'),
    'expanded',
    '工具卡 W778：展开后 chevron 方向翻成 expanded',
  );
  ref.body.appendChild(new El('div'));
  eq(ref.card.open, true, '工具卡：同一节点更新 DOM 不丢 open 状态');
  ref.card.open = false;
  eq(
    ref.card.querySelector('.toolcard-head').getAttribute('aria-expanded'),
    'false',
    '工具卡：收起后 aria-expanded=false',
  );
  eq(
    ref.card.querySelector('.toolcard-fold').getAttribute('data-fold'),
    'collapsed',
    '工具卡 W778：收起后 chevron 方向回到 collapsed',
  );

  /* ---- 5 静态断言：CSS 兜底 + 两条路径共用构造器（防回归） ------------------ */
  const css = readFileSync(path.join(ROOT, 'src/styles/components.css'), 'utf8');
  truthy(
    /\.msg\.think-seg\.collapsed\s+\.think-seg-body\s*\{\s*display:\s*none/.test(css),
    'CSS：折叠态隐藏思考正文（.msg.think-seg.collapsed）',
  );
  truthy(
    /\.msg\.think-seg\.collapsed\s+\.think-seg-folded\s*\{\s*display:\s*block/.test(css),
    'CSS：折叠态显示占位行',
  );
  truthy(
    /\.toolcard:not\(\[open\]\)\s*>\s*\.toolcard-body\s*\{\s*display:\s*none/.test(css),
    'CSS：关闭态工具卡正文强制隐藏（作者 display:flex 会盖掉 UA 隐藏）',
  );
  truthy(
    /\.toolcard-fold\[data-fold='collapsed'\]\s*>\s*svg\s*\{[^}]*rotate\(0deg\)/.test(css),
    'CSS：工具卡 chevron 收起态指右（0deg）',
  );
  truthy(
    /\.toolcard-fold\[data-fold='expanded'\]\s*>\s*svg\s*\{[^}]*rotate\(90deg\)/.test(css),
    'CSS：工具卡 chevron 展开态指下（90deg）',
  );

  const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
  const messagesSrc = src('src/ui/messages.ts');
  const restoreSrc = src('src/ui/restore.ts');
  const toolcardsSrc = src('src/ui/toolcards.ts');
  truthy(
    /export function buildThinkSeg\(/.test(messagesSrc),
    '源码：messages.ts 导出共用构造器 buildThinkSeg',
  );
  truthy(
    /buildThinkSeg\(\{\s*time: fmtNow\(\), collapsed: !ctx\.streaming\s*\}\)/.test(messagesSrc),
    '源码：live 路径经 buildThinkSeg + collapsed=!streaming',
  );
  truthy(
    /buildThinkSeg\(\{\s*text: content,\s*collapsed: true\s*\}\)/.test(restoreSrc),
    '源码：恢复路径经 buildThinkSeg + collapsed:true',
  );
  truthy(!/['"]msg think-seg['"]/.test(restoreSrc), '源码：恢复路径不再自建 .think-seg（杜绝默认态分叉）');
  truthy(!/['"]think-fold-mark['"]/.test(restoreSrc), '源码：恢复路径不再自建折叠箭头');
  truthy(
    !/\.classList\.toggle\(['"]collapsed['"]\)/.test(messagesSrc + restoreSrc),
    '源码：折叠类不再 toggle 到 .mcol 根上（老 bug 回归即失败）',
  );
  truthy(/card\.open = false;/.test(toolcardsSrc), '源码：工具卡构建期显式 open=false');

  /* ------------------------------------------------------------------ 结果 */

  if (problems.length) {
    console.error('\n\u2717 W752 默认折叠守护未通过\n');
    for (const p of problems) console.error('  \u2717 ' + p);
    console.error(`\n  通过 ${checks.length} 项，失败 ${problems.length} 项\n`);
    process.exit(1);
  }
  console.log(
    `\u2713 W752 默认折叠守护通过（${checks.length} 项断言：恢复路径 / live 路径 / 交互 / 工具卡 / CSS 兜底 / 源码结构）`,
  );
}

main().catch((err) => {
  console.error('\u2717 W752 默认折叠守护异常终止：', err);
  process.exit(1);
});
