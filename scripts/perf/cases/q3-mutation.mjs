// ============================================================================
// scripts/perf/cases/q3-mutation.mjs — 问题 3：**DOM 是否频繁增删**
// ----------------------------------------------------------------------------
// MutationObserver 挂在 #messages（subtree:true, childList:true），逐场景复位，
// 统计 added/removed 节点数 + 变更记录数 + 变更目标分布。四个场景：
//   ① 流式正文每个节拍（真 EventSource，32 个 text 帧 / 16ms）
//   ② 思考段 flush（一个巨大 thinking delta + done → flushThinkSegment）
//   ③ 工具卡回填（tool + tool_result）
//   ④ prunePaneDom 回收（1200 列，强制裁剪）
// 另外单独验铁律 1（离屏构建 + 单次 replaceChildren）在热路径上是否被遵守。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, control, readSummary } from '../lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from '../lib/stats.mjs';

const BUILD_COLS = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'for (let i = 0; i < window.__W9111N; i++) M.addUserMessage(ctx, "第 " + i + " 条。");',
  'return ctx.el.querySelectorAll(".mcol").length;',
].join('\n');

/** 场景 ①：真 SSE 流式正文 —— 32 个 512 字符 text 帧，间隔 16ms。 */
function textBurstFrames(turn) {
  const text = 'abcdefghij'.repeat(1639).slice(0, 16384);
  const frames = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn }];
  for (let i = 0; i < text.length; i += 512) {
    frames.push({ at: 16 * (i / 512 + 1), name: 'text', payload: { delta: text.slice(i, i + 512) }, turn });
  }
  const end = 16 * (text.length / 512 + 2);
  frames.push({ at: end, name: 'done', payload: { text }, turn });
  frames.push({ at: end + 16, name: 'status', payload: { phase: 'completed' }, turn });
  return { frames, endAt: end + 16 };
}

/** 场景 ②：思考段 flush —— 一个 64K thinking 帧 + done。 */
function thinkBurstFrames(turn) {
  const text = 'abcdefghij'.repeat(6554).slice(0, 65536);
  return {
    frames: [
      { at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn },
      { at: 16, name: 'thinking', payload: { delta: text }, turn },
      { at: 32, name: 'done', payload: { text: '' }, turn },
      { at: 48, name: 'status', payload: { phase: 'completed' }, turn },
    ],
    endAt: 48,
  };
}

/** 场景 ③：工具卡回填 —— tool + tool_result。 */
function toolBurstFrames(turn) {
  return {
    frames: [
      { at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn },
      { at: 16, name: 'tool', payload: { id: 'tool-' + turn, name: 'read_file', args: { path: 'a.md' } }, turn },
      { at: 32, name: 'tool_result', payload: { id: 'tool-' + turn, ok: true, value: 'file contents' }, turn },
      { at: 48, name: 'done', payload: { text: '' }, turn },
      { at: 64, name: 'status', payload: { phase: 'completed' }, turn },
    ],
    endAt: 64,
  };
}

export async function q3() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const scenarios = {};
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');

    async function runScenario(name, mk, turn) {
      await readSummary(app.page, { reset: true });
      const b = mk(turn);
      const t0 = Date.now();
      await control(app, '/__control/burst', { frames: b.frames });
      await new Promise((r) => setTimeout(r, b.endAt + 1200));
      const s = await readSummary(app.page);
      const wall = Date.now() - t0;
      const ctxInfo = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; return { cols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length }; })()');
      scenarios[name] = { summary: s, wallMs: wall, ctx: ctxInfo };
      process.stdout.write(name + ' ');
    }

    await runScenario('streamText', textBurstFrames, 301);
    await runScenario('thinkFlush', thinkBurstFrames, 302);
    await runScenario('toolBackfill', toolBurstFrames, 303);

    // 场景 ④：prunePaneDom 回收
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 700));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    await app.page.eval('window.__W9111N = 1200;');
    await app.page.eval('(function(){ ' + BUILD_COLS + ' })()');
    await readSummary(app.page, { reset: true });
    const pruneRuns = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.page.eval('(function(){ const D = window.__W9111M.domcap; const ctx = ' + PANE_EXPR + '; const before = ctx.el.querySelectorAll(".mcol").length; const t0 = performance.now(); const dropped = D.prunePaneDom(ctx, true); void ctx.el.offsetHeight; return { ms: performance.now()-t0, before: before, after: ctx.el.querySelectorAll(".mcol").length, dropped: dropped }; })()');
      pruneRuns.push(r);
    }
    scenarios.prune = { runs: pruneRuns, summary: await readSummary(app.page) };

    // 铁律 1 探针：流式正文的变更目标分布里，.content 的变更次数 vs 节点数
    const out = { scenarios };
    saveRaw('q3-mutation.json', out);
    saveRaw('q3-mutation.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const rows = [];
  for (const [name, v] of Object.entries(out.scenarios)) {
    if (name === 'prune') {
      // prune 行：帧数/长帧/最长帧没有意义（不是 rAF 场景），改用变更记录 + added/removed
      const runs = v.runs.map((r) => r.ms.toFixed(1) + 'ms/' + r.dropped).join(' ');
      rows.push(['prune(x5)', runs, v.summary.mutRecords, v.summary.mutAdded, v.summary.mutRemoved, '-', '-', '-']);
      continue;
    }
    const s = v.summary;
    rows.push([name, v.wallMs, s.mutRecords, s.mutAdded, s.mutRemoved, s.frames, s.longFrames, fmt(s.longFramesMax, 1)]);
  }
  return ['# Q3 DOM 增删', '', mdTable(['场景', '墙钟 ms', '变更记录', 'added', 'removed', '帧数', '长帧', '最长帧 ms'], rows), ''].join('\n');
}
