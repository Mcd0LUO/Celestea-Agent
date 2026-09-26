// scripts/perf/focus-scroll.mjs — 焦点复现：600 列 vs 上限失效（3000 列）的**滚动**与**建列**代价
// ----------------------------------------------------------------------------
// Q2 的 level 表把「建列代价」与「滚动代价」混在一行，且 3000 列的 61s 需要独立复核。
// 这里拆开：
//   · 建列：addUserMessage N 次的总耗时（每 200 列采一次，看是否超线性）；
//   · 滚动：**不重建**，在已建好的容器上 rAF 往返滚动，量帧间隔（这才是用户可感的卡顿）。
//   · 同时读 rail 条数与 DOM 节点数，确认「不虚拟化」的实际规模。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, readSummary } from './lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from './lib/stats.mjs';

const BUILD = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'const from = window.__W9111N0, to = window.__W9111N1;',
  'const t0 = performance.now();',
  'for (let i = from; i < to; i++) M.addUserMessage(ctx, "第 " + i + " 条用户消息，撑列数用。");',
  'void ctx.el.offsetHeight;',
  'return { ms: performance.now() - t0, cols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length };',
].join('\n');

const SCROLL = [
  'const ctx = ' + PANE_EXPR + ';',
  'const el = ctx.el;',
  'const frames = [];',
  'let last = performance.now();',
  'const total = 240;',
  'let k = 0;',
  'const span = Math.max(1, el.scrollHeight - el.clientHeight);',
  'return await new Promise(function(resolve) {',
  '  function step(now) {',
  '    frames.push(now - last); last = now;',
  '    const frac = (k % 120) / 119;',
  '    const dir = Math.floor(k / 120) % 2 === 0 ? frac : 1 - frac;',
  '    el.scrollTop = Math.round(dir * span);',
  '    k++;',
  '    if (k >= total) {',
  '      const d = frames.slice(1).sort(function(a,b){return a-b;});',
  '      const long = d.filter(function(x){ return x > 50; });',
  '      resolve({ n: d.length, p50: d[Math.floor(d.length*0.5)], p95: d[Math.floor(d.length*0.95)], max: d[d.length-1], longFrames: long.length, longTotalMs: long.reduce(function(a,b){return a+b;},0), scrollHeight: el.scrollHeight });',
  '      return;',
  '    }',
  '    requestAnimationFrame(step);',
  '  }',
  '  requestAnimationFrame(step);',
  '});',
].join('\n');

export async function focusScroll() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const levels = [];
  try {
    for (const n of [600, 1200, 3000]) {
      await app.page.navigate(app.origin + '/');
      await new Promise((r) => setTimeout(r, 650));
      await pageModule(app.page, 'messages', '/src/ui/messages.ts');
      await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
      const chunks = [];
      const STEP = 200;
      await app.page.eval('window.__W9111N0 = 0;');
      for (let from = 0; from < n; from += STEP) {
        await app.page.eval('window.__W9111N0 = ' + from + '; window.__W9111N1 = ' + Math.min(n, from + STEP) + ';');
        chunks.push(await app.page.eval('(function(){ ' + BUILD + ' })()'));
      }
      const before = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; return { nodes: ctx.el.querySelectorAll("*").length, mcols: ctx.el.querySelectorAll(".mcol").length, railBars: document.querySelectorAll(".railv3-item").length }; })()');
      await readSummary(app.page, { reset: true });
      const scroll = await app.page.evalAsync(SCROLL);
      const summary = await readSummary(app.page);
      levels.push({ cols: n, chunks, before, scroll, summary });
      process.stdout.write('n=' + n + ' ');
    }
    const out = { levels };
    saveRaw('focus-scroll.json', out);
    saveRaw('focus-scroll.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const L2 = ['# 滚动退化曲线', ''];
  L2.push(mdTable(['列数', '建列总 ms', '每 200 列 ms', 'DOM 节点', 'rail 条', '滚动 p50', 'p95', 'max', '长帧', '长帧总 ms', 'scrollHeight'], out.levels.map((l) => [
    l.cols, fmt(l.chunks.reduce((a, c) => a + c.ms, 0), 0), l.chunks.map((c) => fmt(c.ms, 0)).join('/'), l.before.nodes, l.before.railBars,
    fmt(l.scroll.p50, 1), fmt(l.scroll.p95, 1), fmt(l.scroll.max, 1), l.scroll.longFrames, fmt(l.scroll.longTotalMs, 0), l.scroll.scrollHeight,
  ])));
  return L2.join('\n');
}

const _r = await focusScroll();
console.log(JSON.stringify(_r.levels.map((l) => ({ cols: l.cols, buildTotalMs: Math.round(l.chunks.reduce((a, c) => a + c.ms, 0)), chunks: l.chunks.map((c) => Math.round(c.ms)), nodes: l.before.nodes, railBars: l.before.railBars, scroll: { p50: +l.scroll.p50.toFixed(1), p95: +l.scroll.p95.toFixed(1), max: +l.scroll.max.toFixed(1), longFrames: l.scroll.longFrames, longTotalMs: Math.round(l.scroll.longTotalMs), scrollHeight: l.scroll.scrollHeight } })), null, 1));
