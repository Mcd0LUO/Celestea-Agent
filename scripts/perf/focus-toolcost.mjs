// scripts/perf/focus-toolcost.mjs — **P0 归因**：单次工具事件的处理代价随 DOM 规模怎么涨
// ----------------------------------------------------------------------------
// focus-toolrate.mjs 发现：工具卡流会造出 4–9 秒的**单帧**冻结（LoAF 归因到
// EventSource.ontool/ontool_result/ontext）。这里把代价拆开：
//
//   对 N = 50 / 100 / 200 / 300 / 400 张工具卡，逐个调 pushToolCard + applyToolResult，
//   逐次计时。若单次代价随 N **线性/超线性**增长 ⇒ 是「每次操作都遍历整棵容器」的
//   结构性代价（autoscroll 的强制布局 / prunePaneDom 的 querySelectorAll /
//   pruneToolCards 的 contains 扫描），而不是一次性的建卡成本。
//
//   同时把 autoscroll 单独拎出来量（它就是 ctx.el.scrollTop = ctx.el.scrollHeight），
//   它是唯一在每个事件里都跑一次的「强制同步布局」。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR } from './lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from './lib/stats.mjs';

/** 逐张建卡 + 回填，分别计时。 */
const PER_CARD = [
  'const M = window.__W9111M.messages;',
  'const T = window.__W9111M.toolcards;',
  'const S = window.__W9111M.scroll;',
  'const ctx = ' + PANE_EXPR + ';',
  'const from = window.__W9111N0, to = window.__W9111N1;',
  'const push = [], res = [], scroll = [];',
  'for (let i = from; i < to; i++) {',
  '  let a = performance.now();',
  '  T.pushToolCard(ctx, { id: "tc" + i, name: "read_file", args: { path: "f" + i + ".md", desc: "读取文件" } });',
  '  push.push(performance.now() - a);',
  '  a = performance.now();',
  '  T.applyToolResult(ctx, { id: "tc" + i, ok: true, value: "结果 " + i + " " + "v".repeat(200) });',
  '  res.push(performance.now() - a);',
  '  a = performance.now();',
  '  S.autoscroll(ctx);',
  '  scroll.push(performance.now() - a);',
  '}',
  'const stat = (arr) => { const s = arr.slice().sort(function(x,y){return x-y;}); return { n: s.length, first: s[0], last: s[s.length-1], median: s[Math.floor(s.length/2)], p95: s[Math.floor(0.95*s.length)], max: s[s.length-1], sum: s.reduce(function(x,y){return x+y;},0) }; };',
  'return { push: stat(push), res: stat(res), scroll: stat(scroll), mcols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length, ops: ctx.ops.size };',
].join('\n');

/** 只量 autoscroll 的代价随容器规模的变化（隔离变量）。 */
const SCROLL_COST = [
  'const S = window.__W9111M.scroll;',
  'const ctx = ' + PANE_EXPR + ';',
  'const times = [];',
  'for (let k = 0; k < 30; k++) { const a = performance.now(); S.autoscroll(ctx); times.push(performance.now() - a); }',
  'const s = times.slice().sort(function(x,y){return x-y;});',
  'return { median: s[15], max: s[s.length-1], nodes: ctx.el.querySelectorAll("*").length, scrollHeight: ctx.el.scrollHeight };',
].join('\n');

export async function focusToolCost() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const stages = [];
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'toolcards', '/src/ui/toolcards.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'scroll', '/src/ui/messages/scroll.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    await app.page.eval('window.__W9111N0 = 0;');
    const BATCH = 25;
    for (let from = 0; from < 400; from += BATCH) {
      await app.page.eval('window.__W9111N0 = ' + from + '; window.__W9111N1 = ' + (from + BATCH) + ';');
      const r = await app.page.eval('(function(){ ' + PER_CARD + ' })()');
      const sc = await app.page.eval('(function(){ ' + SCROLL_COST + ' })()');
      stages.push({ from, to: from + BATCH, ...r, scrollCost: sc });
      process.stdout.write((from + BATCH) + ' ');
    }
    const out = { stages };
    saveRaw('focus-toolcost.json', out);
    saveRaw('focus-toolcost.md', mdTable(
      ['累计卡数', 'push 中位 ms', 'push max', 'result 中位', 'result max', 'autoscroll 中位', 'autoscroll max', 'DOM 节点', 'ops', '纯 autoscroll 中位', 'scrollHeight'],
      stages.map((s) => [s.to, fmt(s.push.median, 2), fmt(s.push.max, 2), fmt(s.res.median, 2), fmt(s.res.max, 2), fmt(s.scroll.median, 2), fmt(s.scroll.max, 2), s.nodes, s.ops, fmt(s.scrollCost.median, 2), s.scrollCost.scrollHeight]),
    ));
    return out;
  } finally {
    await app.close();
  }
}

const _r = await focusToolCost();
console.log(JSON.stringify(_r.stages.map((s) => ({ n: s.to, pushMed: +s.push.median.toFixed(2), pushMax: +s.push.max.toFixed(2), resMed: +s.res.median.toFixed(2), resMax: +s.res.max.toFixed(2), scrollMed: +s.scroll.median.toFixed(2), scrollMax: +s.scroll.max.toFixed(2), pureScrollMed: +s.scrollCost.median.toFixed(2), nodes: s.nodes, ops: s.ops, scrollHeight: s.scrollCost.scrollHeight })), null, 0).replace(/},/g, '},\n'));
