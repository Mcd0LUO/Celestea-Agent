// ============================================================================
// scripts/perf/cases/q2-virtual.mjs — 问题 2：**虚拟滚动是否合理**
// ----------------------------------------------------------------------------
// 本仓刻意不虚拟化（dom-cap.ts 文件头）。本用例只回答「在这个具体实现下现状够不够」：
//   · 600 列（当前上限）的滚动帧率 / 长帧；
//   · 600 的 2x / 5x（1200 / 3000 列）的退化曲线 —— 模拟上限失效；
//   · 600 列 + 头部 200 列被 prunePaneDom 回收时的代价（回收那一刻的长帧）；
//   · rail 长条记账随回收是否同步（rail-state.dropColsInState）。
// 数据全部来自真机 CDP（headless Chrome 153），列由应用自己的渲染函数造。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, readSummary, readLoafByInvoker } from '../lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from '../lib/stats.mjs';

/** 造 N 列：每列 = 一条用户消息（走应用自己的 addUserMessage）。 */
const BUILD_COLS = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'const n = window.__W9111N;',
  'const t0 = performance.now();',
  'for (let i = 0; i < n; i++) M.addUserMessage(ctx, "第 " + i + " 条用户消息，用于撑列数。");',
  'void ctx.el.offsetHeight;',
  'return { ms: performance.now() - t0, cols: ctx.el.querySelectorAll(".mcol").length };',
].join('\n');

/** 造 N 列工具卡（走应用自己的 pushToolCard）。 */
const BUILD_TOOLS = [
  'const T = window.__W9111M.toolcards;',
  'const ctx = ' + PANE_EXPR + ';',
  'const n = window.__W9111N;',
  'const t0 = performance.now();',
  'for (let i = 0; i < n; i++) T.pushToolCard(ctx, { id: "tc" + i, name: "read_file", args: { path: "f" + i + ".md", desc: "读取文件" } });',
  'void ctx.el.offsetHeight;',
  'return { ms: performance.now() - t0, cols: ctx.el.querySelectorAll(".mcol").length };',
].join('\n');

/** 真·平滑滚动：用 rAF 驱动 scrollTop 往返，量帧间隔。 */
const SCROLL_PROBE = [
  'const ctx = ' + PANE_EXPR + ';',
  'const el = ctx.el;',
  'const frames = [];',
  'let last = performance.now();',
  'const total = 120;',
  'let k = 0;',
  'return await new Promise(function(resolve) {',
  '  function step(now) {',
  '    frames.push(now - last); last = now;',
  '    const frac = (k % 60) / 59;',
  '    const dir = Math.floor(k / 60) % 2 === 0 ? frac : 1 - frac;',
  '    el.scrollTop = Math.round(dir * (el.scrollHeight - el.clientHeight));',
  '    void el.scrollHeight;',
  '    k++;',
  '    if (k >= total) {',
  '      const sorted = frames.slice(1).sort(function(a,b){return a-b;});',
  '      const long = sorted.filter(function(d){ return d > 50; });',
  '      resolve({ frames: sorted.length, p50: sorted[Math.floor(sorted.length*0.5)], p95: sorted[Math.floor(sorted.length*0.95)], max: sorted[sorted.length-1], longFrames: long.length, longTotalMs: long.reduce(function(a,b){return a+b;},0) });',
  '      return;',
  '    }',
  '    requestAnimationFrame(step);',
  '  }',
  '  requestAnimationFrame(step);',
  '});',
].join('\n');

/** 模拟上限失效：强制 prune 只保留 100 列 / 关闭 prune。 */
const PRUNE_ONCE = [
  'const D = window.__W9111M.domcap;',
  'const ctx = ' + PANE_EXPR + ';',
  'const before = ctx.el.querySelectorAll(".mcol").length;',
  'const t0 = performance.now();',
  'const dropped = D.prunePaneDom(ctx, true);',
  'void ctx.el.offsetHeight;',
  'const ms = performance.now() - t0;',
  'return { ms: ms, before: before, after: ctx.el.querySelectorAll(".mcol").length, dropped: dropped };',
].join('\n');

export async function q2() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const out = { levels: [], prune: null, railSync: null };
  try {
    for (const n of [600, 1200, 3000]) {
      await app.page.navigate(app.origin + '/');
      await new Promise((r) => setTimeout(r, 700));
      await pageModule(app.page, 'messages', '/src/ui/messages.ts');
      await pageModule(app.page, 'toolcards', '/src/ui/toolcards.ts');
      await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
      await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
      await app.page.eval('window.__W9111N = ' + n + ';');
      const built = await app.page.eval('(function(){ ' + BUILD_COLS + ' })()');
      const nodes = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; return { nodes: ctx.el.querySelectorAll("*").length, railBars: ctx.el.ownerDocument.querySelectorAll(".railv3-item").length }; })()');
      await readSummary(app.page, { reset: true });
      const scroll = await app.page.evalAsync(SCROLL_PROBE);
      const summary = await readSummary(app.page);
      const loaf = await readLoafByInvoker(app.page);
      out.levels.push({ cols: n, built, nodes, scroll, summary, loaf });
      process.stdout.write('cols=' + n + ' ');
    }

    // --- 上限失效：1200 列时反复强制 prune（每次最多回收 100 条）
    //     同时验 rail 记账是否同步（railDropCols → dropColsInState）。
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 700));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
    await app.page.eval('window.__W9111N = 1200;');
    await app.page.eval('(function(){ ' + BUILD_COLS + ' })()');
    const railBefore = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; const R = window.__W9111M.railstate; const st = R.stateOfOnly(ctx); return { items: st ? st.items.length : 0, cols: ctx.el.querySelectorAll(".mcol").length }; })()');
    await readSummary(app.page, { reset: true });
    const pruneRuns = [];
    for (let i = 0; i < 6; i++) pruneRuns.push(await app.page.eval('(function(){ ' + PRUNE_ONCE + ' })()'));
    const railAfter = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; const R = window.__W9111M.railstate; const st = R.stateOfOnly(ctx); return { items: st ? st.items.length : 0, cols: ctx.el.querySelectorAll(".mcol").length }; })()');
    out.prune = { runs: pruneRuns, summary: await readSummary(app.page), railBefore, railAfter };

    saveRaw('q2-virtual.json', out);
    saveRaw('q2-virtual.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const rows = out.levels.map((r) => [
    r.cols, r.built.ms.toFixed(0), r.nodes.nodes, fmt(r.scroll.p50, 1), fmt(r.scroll.p95, 1), fmt(r.scroll.max, 1), r.scroll.longFrames, fmt(r.scroll.longTotalMs, 0), r.summary.longFrames,
  ]);
  return ['# Q2 虚拟滚动', '', mdTable(['列数', '建列 ms', '容器节点数', '滚动 p50 ms', 'p95', 'max', '长帧数', '长帧总 ms', '建列期间长帧'], rows), ''].join('\n');
}
