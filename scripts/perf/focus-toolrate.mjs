// scripts/perf/focus-toolrate.mjs — **P0 复现**：工具卡到达速率 vs 主线程冻结
// ----------------------------------------------------------------------------
// verify.mjs 的 C1 用例（900 step × 3 帧 / 4ms）里出现了一个 ~50s 的长帧。
// 这里做**速率扫描**，找「多快开始卡死」的阈值，并把长帧归因到脚本。
//
// 每 step = tool + tool_result + text 三帧（就是一次工具调用的最小真实序列）。
// 速率用帧间隔表达：20 / 10 / 6 / 4 ms。每档 300 step。
//
// 观测：
//   · 墙钟（Node 侧，包含 CDP 阻塞）；
//   · rAF 帧间隔分布 + >50ms 长帧数 + 最长帧；
//   · LoAF（含 startTime 与脚本归因），用它区分「本档造成的」与「上一档遗留」；
//   · 结束时的 mcol / ops / DOM 节点 / rail 条；
//   · 突发结束后静置 4s 再读一次（看能否收敛回上限）。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, control, readSummary, readTopLoaf } from './lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from './lib/stats.mjs';

const COUNTS = [
  'const ctx = ' + PANE_EXPR + ';',
  'const R = window.__W9111M.railstate;',
  'const st = R.stateOfOnly(ctx);',
  'return { mcols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length, ops: ctx.ops.size, railBars: st ? st.items.length : 0, railHolder: st ? st.holder.childNodes.length : 0 };',
].join('\n');

function framesFor(steps, gapMs, turn) {
  const frames = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn }];
  let at = 0;
  for (let i = 0; i < steps; i++) {
    at += gapMs; frames.push({ at, name: 'tool', payload: { id: 'st-' + i, name: 'read_file', args: { path: 'f' + i + '.md', desc: '读取文件' } }, turn });
    at += gapMs; frames.push({ at, name: 'tool_result', payload: { id: 'st-' + i, ok: true, value: '结果 ' + i + ' ' + 'v'.repeat(200) }, turn });
    at += gapMs; frames.push({ at, name: 'text', payload: { delta: 'step ' + i + ' ' + 'q'.repeat(120) }, turn });
  }
  at += gapMs; frames.push({ at, name: 'done', payload: { text: '' }, turn });
  at += gapMs; frames.push({ at, name: 'status', payload: { phase: 'completed' }, turn });
  return { frames, scheduledMs: at };
}

export async function focusToolRate() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const rows = [];
  try {
    const STEPS = 300;
    const GAPS = [20, 10, 6, 4];
    let turn = 900;
    for (const gap of GAPS) {
      await app.page.navigate(app.origin + '/');
      await new Promise((r) => setTimeout(r, 700));
      await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
      await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
      const b = framesFor(STEPS, gap, turn++);
      await readSummary(app.page, { reset: true });
      const t0 = Date.now();
      await control(app, '/__control/burst', { frames: b.frames });
      // 等到「计划时长 + 4s」；若主线程冻结，这一步本身会被拖住
      const waitMs = b.scheduledMs + 4000;
      let blockedMs = 0;
      try {
        const t1 = Date.now();
        await new Promise((r) => setTimeout(r, waitMs));
        await app.page.eval('1');
        blockedMs = Date.now() - t1 - waitMs;
      } catch (err) { blockedMs = -1; }
      const wallMs = Date.now() - t0;
      const summary = await readSummary(app.page);
      const topLoaf = await readTopLoaf(app.page, 5);
      const counts = await app.page.eval('(function(){ ' + COUNTS + ' })()');
      rows.push({ gapMs: gap, steps: STEPS, scheduledMs: b.scheduledMs, wallMs, overshootMs: wallMs - b.scheduledMs, blockedMs, summary, topLoaf, counts });
      process.stdout.write('gap=' + gap + '(' + wallMs + 'ms) ');
    }
    const out = { rows };
    saveRaw('focus-toolrate.json', out);
    saveRaw('focus-toolrate.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const L2 = ['# 工具卡到达速率 vs 冻结', ''];
  L2.push(mdTable(['帧间隔 ms', '计划 ms', '实际墙钟 ms', '超时 ms', 'rAF 帧数', '长帧', '最长帧 ms', 'LoAF 数', 'LoAF max ms', 'mcol', 'ops', 'DOM 节点', 'rail 条'], out.rows.map((r) => [
    r.gapMs, r.scheduledMs, r.wallMs, r.overshootMs, r.summary.frames, r.summary.longFrames, fmt(r.summary.longFramesMax, 0), r.summary.loafCount, fmt(r.summary.loafMaxMs, 0), r.counts.mcols, r.counts.ops, r.counts.nodes, r.counts.railBars,
  ])));
  return L2.join('\n');
}

const _r = await focusToolRate();
console.log(JSON.stringify(_r.rows.map((r) => ({ gapMs: r.gapMs, scheduledMs: r.scheduledMs, wallMs: r.wallMs, overshootMs: r.overshootMs, frames: r.summary.frames, longFrames: r.summary.longFrames, longMaxMs: Math.round(r.summary.longFramesMax), loafCount: r.summary.loafCount, loafMaxMs: Math.round(r.summary.loafMaxMs), mutAdded: r.summary.mutAdded, mutRemoved: r.summary.mutRemoved, counts: r.counts, topLoaf: (r.topLoaf || []).map((l) => ({ d: Math.round(l.duration), start: Math.round(l.startTime), n: (l.scripts || []).length, inv: [...new Set((l.scripts || []).map((s) => s.invoker))].slice(0, 2) })) })), null, 1));
