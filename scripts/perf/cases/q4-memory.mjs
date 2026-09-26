// ============================================================================
// scripts/perf/cases/q4-memory.mjs — 问题 4：**内存是否无界增长**
// ----------------------------------------------------------------------------
// 采样手段（全部真机 CDP）：
//   · Performance.getMetrics  → JSHeapUsedSize / Nodes / Documents / JSEventListeners
//   · HeapProfiler.collectGarbage → **每次采样前强制 GC**，否则堆数字只是垃圾没回收
//   · HeapProfiler.startSampling/stopSampling → 把增长**归因到分配栈**（定位持有者）
//   · 页内直接读可疑持有者的**条目数**（ctx.ops.size / rail items / thinkRetained / panes）
//
// 为什么要页内读：WeakMap（thinkBudget / rail stateOf / itemByEl）在 CDP 堆快照里
// 只以 key 存活为前提出现，条目本身看不见。所以对每个 WeakMap 都配一个**可从页面读到
// 的等价计数器**，再拿堆总量去交叉验证：
//   若「所有可数持有者都有界」而堆仍线性增长 ⇒ 存在未被计数的持有者（必须继续挖）。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR } from '../lib/scenario.mjs';
import { saveRaw, mdTable, fmt, mm } from '../lib/stats.mjs';

/** 造一轮：用户消息 + 文本 + 工具卡 + 结果（走应用自己的渲染函数）。 */
const ONE_ROUND = [
  'const M = window.__W9111M.messages;',
  'const T = window.__W9111M.toolcards;',
  'const ctx = ' + PANE_EXPR + ';',
  'const i = window.__W9111I;',
  'M.addUserMessage(ctx, "第 " + i + " 轮提问：" + "x".repeat(200));',
  'ctx.streaming = true;',
  'M.appendThinking(ctx, "思考 " + i + " " + "y".repeat(2000));',
  'const a = M.ensureAssistant(ctx);',
  'M.appendText(ctx, a, "回答 " + i + " " + "z".repeat(2000));',
  'M.flushTextSegment(ctx);',
  'T.pushToolCard(ctx, { id: "tool-" + i, name: "read_file", args: { path: "f" + i + ".md", desc: "读文件" } });',
  'T.applyToolResult(ctx, { id: "tool-" + i, ok: true, value: "结果 " + i + " " + "w".repeat(1000) });',
  'M.endTurn(ctx);',
  'ctx.streaming = false;',
  'return ctx.el.querySelectorAll(".mcol").length;',
].join('\n');

/** 页内快照：可数持有者 + DOM 规模。 */
const HOLDERS = [
  'const ctx = ' + PANE_EXPR + ';',
  'const M = window.__W9111M.messages;',
  'const R = window.__W9111M.railstate;',
  'const V = window.__W9111M.viewctx;',
  'const st = R.stateOfOnly(ctx);',
  'const panes = V.allPanes();',
  'let ops = 0, mcols = 0, nodes = 0, thinkChars = 0, thinkSegs = 0, railBars = 0;',
  'for (const p of panes) {',
  '  ops += p.ops.size; mcols += p.el.querySelectorAll(".mcol").length;',
  '  nodes += p.el.querySelectorAll("*").length;',
  '  thinkChars += M.thinkRetained(p.el);',
  '  thinkSegs += p.el.querySelectorAll(".think-seg").length;',
  '  const s = R.stateOfOnly(p); railBars += s ? s.items.length : 0;',
  '}',
  'return { panes: panes.length, ops: ops, mcols: mcols, nodes: nodes, thinkChars: thinkChars, thinkSegs: thinkSegs, railBars: railBars, railItemsThisPane: st ? st.items.length : 0, railHolderChildren: st ? st.holder.childNodes.length : 0 };',
].join('\n');

/** 一次 CDP 指标采样（先强制 GC）。 */
async function sample(app, label, round) {
  await app.page.send('HeapProfiler.collectGarbage');
  const m = await app.page.send('Performance.getMetrics');
  const g = await app.page.send('Runtime.getHeapUsage');
  const byName = {};
  for (const x of m.metrics) byName[x.name] = x.value;
  const holders = await app.page.eval('(function(){ ' + HOLDERS + ' })()');
  return {
    label, round,
    JSHeapUsedSize: byName.JSHeapUsedSize, JSHeapTotalSize: byName.JSHeapTotalSize,
    Nodes: byName.Nodes, Documents: byName.Documents, JSEventListeners: byName.JSEventListeners,
    LayoutCount: byName.LayoutCount, RecalcStyleCount: byName.RecalcStyleCount,
    heapUsed: g.usedSize, heapTotal: g.totalSize,
    holders,
  };
}

export async function q4() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const samples = [];
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'toolcards', '/src/ui/toolcards.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    await app.page.eval('window.__W9111I = 0;');
    samples.push(await sample(app, 'baseline', 0));

    // 每轮产出 4 条 .mcol（user / think / assistant / tool）。
    // 跑 300 轮 = 1200 列 ⇒ **越过 MAX_DOM_COLS=600**，prunePaneDom 必须开始回收。
    const BATCH = 10;
    const BATCHES = 30;
    for (let b = 0; b < BATCHES; b++) {
      for (let k = 0; k < BATCH; k++) {
        await app.page.eval('(function(){ window.__W9111I = ' + (b * BATCH + k) + '; ' + ONE_ROUND + ' })()');
      }
      samples.push(await sample(app, 'rounds-' + ((b + 1) * BATCH), (b + 1) * BATCH));
      process.stdout.write('r' + ((b + 1) * BATCH) + ' ');
    }

    // ---- 分配采样：把增长归因到分配栈 ----
    await app.page.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
    for (let k = 0; k < 30; k++) {
      await app.page.eval('(function(){ window.__W9111I = 1000 + ' + k + '; ' + ONE_ROUND + ' })()');
    }
    const prof = await app.page.send('HeapProfiler.stopSampling');
    const top = topAllocSites(prof.profile, 15);
    samples.push(await sample(app, 'after-sampling', 330));

    // ---- 强制裁剪 + GC：堆会不会掉下来？ ----
    await app.page.eval('(function(){ const D = window.__W9111M.domcap; const ctx = ' + PANE_EXPR + '; let n = 0; for (let i = 0; i < 20; i++) n += D.prunePaneDom(ctx, true); return n; })()');
    const afterPrune = await sample(app, 'after-prune', 330);
    samples.push(afterPrune);

    const out = { samples, allocTop: top };
    saveRaw('q4-memory.json', out);
    saveRaw('q4-memory.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

/** 从采样 profile 里取 self size 最大的分配栈。 */
function topAllocSites(profile, n) {
  if (!profile || !profile.head) return [];
  const nodes = new Map();
  for (const node of profile.head ? [profile.head, ...(profile.samples ?? [])] : []) nodes.set(node.id, node);
  // V8 的采样 profile 结构：head 是树，按 children 递归；selfSize 在 node 上。
  const out = [];
  const walk = (node, stack) => {
    const cf = node.callFrame ?? {};
    const frame = (cf.functionName || '(anon)') + ' @ ' + (cf.url || '').split('/').slice(-2).join('/') + ':' + (cf.lineNumber ?? -1);
    const next = cf.url || cf.functionName ? stack.concat([frame]) : stack;
    if ((node.selfSize ?? 0) > 0) out.push({ selfSize: node.selfSize, stack: next.slice(-4).join(' <- ') });
    for (const c of node.children ?? []) walk(c, next);
  };
  walk(profile.head, []);
  out.sort((a, b) => b.selfSize - a.selfSize);
  return out.slice(0, n);
}

function renderMd(out) {
  const rows = out.samples.map((s) => [
    s.label, s.round, fmt(s.JSHeapUsedSize / 1048576, 2), fmt(s.Nodes), fmt(s.Documents), fmt(s.JSEventListeners),
    s.holders.panes, s.holders.ops, s.holders.mcols, s.holders.nodes, s.holders.thinkSegs, s.holders.railBars,
  ]);
  const alloc = out.allocTop.map((a) => [fmt(a.selfSize / 1048576, 2), a.stack]);
  return ['# Q4 内存', '', mdTable(['样本', '轮次', 'JSHeapUsed MB', 'Nodes', 'Documents', 'JSEventListeners', 'panes', 'ops', 'mcols', 'DOM 节点', 'think 段', 'rail 条'], rows), '', '# 分配归因（selfSize MB）', '', mdTable(['MB', '分配栈'], alloc), ''].join('\n');
}