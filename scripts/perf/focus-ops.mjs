// ============================================================================
// scripts/perf/focus-ops.mjs — **焦点复现**：工具卡流下 prunePaneDom 的净回收能力
// ----------------------------------------------------------------------------
// Q4 的曲线显示：150 轮之后 ops/mcols/nodes/rail 条**同时**在 600 附近震荡，
// 但每轮新增 4 列 ⇒ 600 的上限意味着净回收必须 ≥ 新增。这里把「回收」与「新增」
// 分开量：
//   · 每轮之后记录 (mcols, ops, railBars, DOM nodes)；
//   · 同时记录 prunePaneDom 的返回值（实际摘掉多少 ops 条目）；
//   · 关键判据：**DOM 里还有多少 .toolcard 的 col 不在 ctx.el 里**（应恒为 0）。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR } from './lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from './lib/stats.mjs';

const ONE = [
  'const M = window.__W9111M.messages;',
  'const T = window.__W9111M.toolcards;',
  'const ctx = ' + PANE_EXPR + ';',
  'const i = window.__W9111I;',
  'M.addUserMessage(ctx, "u" + i + " " + "x".repeat(400));',
  'ctx.streaming = true;',
  'M.appendThinking(ctx, "t" + i + " " + "y".repeat(3000));',
  'const a = M.ensureAssistant(ctx);',
  'M.appendText(ctx, a, "a" + i + " " + "z".repeat(3000));',
  'M.flushTextSegment(ctx);',
  'T.pushToolCard(ctx, { id: "tool-" + i, name: "read_file", args: { path: "f" + i + ".md", desc: "读文件" } });',
  'T.applyToolResult(ctx, { id: "tool-" + i, ok: true, value: "r" + i + " " + "w".repeat(2000) });',
  'M.endTurn(ctx);',
  'ctx.streaming = false;',
  'return 1;',
].join('\n');

const SNAP = [
  'const ctx = ' + PANE_EXPR + ';',
  'const M = window.__W9111M.messages;',
  'const R = window.__W9111M.railstate;',
  'const st = R.stateOfOnly(ctx);',
  'const cols = ctx.el.querySelectorAll(".mcol");',
  'let toolCols = 0;',
  'for (const c of cols) if (c.querySelector(".toolcard")) toolCols += 1;',
  'return { mcols: cols.length, toolCols: toolCols, nodes: ctx.el.querySelectorAll("*").length, ops: ctx.ops.size, railBars: st ? st.items.length : 0, railHolder: st ? st.holder.childNodes.length : 0, thinkChars: M.thinkRetained(ctx.el) };',
].join('\n');

const FORCE_PRUNE = [
  'const D = window.__W9111M.domcap;',
  'const ctx = ' + PANE_EXPR + ';',
  'const before = ctx.el.querySelectorAll(".mcol").length;',
  'const opsBefore = ctx.ops.size;',
  'const t0 = performance.now();',
  'const n = D.prunePaneDom(ctx, true);',
  'void ctx.el.offsetHeight;',
  'return { ms: performance.now()-t0, returned: n, before: before, after: ctx.el.querySelectorAll(".mcol").length, opsBefore: opsBefore, opsAfter: ctx.ops.size };',
].join('\n');

export async function focusOps() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const series = [];
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'toolcards', '/src/ui/toolcards.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    for (let i = 0; i < 260; i++) {
      await app.page.eval('(function(){ window.__W9111I = ' + i + '; ' + ONE + ' })()');
      if (i % 5 === 4 || i > 140) series.push({ round: i + 1, ...(await app.page.eval('(function(){ ' + SNAP + ' })()')) });
    }
    const force = [];
    for (let k = 0; k < 8; k++) force.push(await app.page.eval('(function(){ ' + FORCE_PRUNE + ' })()'));
    const afterForce = await app.page.eval('(function(){ ' + SNAP + ' })()');
    const out = { series, force, afterForce };
    saveRaw('focus-ops.json', out);
    saveRaw('focus-ops.md', mdTable(['轮次', 'mcol', '工具列', 'DOM 节点', 'ops', 'rail 条', 'rail holder'], series.map((s) => [s.round, s.mcols, s.toolCols, s.nodes, s.ops, s.railBars, s.railHolder])));
    return out;
  } finally {
    await app.close();
  }
}

const _r = await focusOps();
console.log(JSON.stringify({ series: _r.series.length, force: _r.force, afterForce: _r.afterForce }, null, 1));