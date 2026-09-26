// ============================================================================
// scripts/perf/w9113-p0.mjs — W9113：P0-1/P0-2 修复的**真机前后对比**（铁律 3）
// ----------------------------------------------------------------------------
// 复用 W9111 的确定性假后端 + CDP 探针，量同一份冻结检出在修复前后的：
//   · 最长单帧（longFramesMax）—— P0-1 的主指标（改动前 4–9 秒）；
//   · >50ms 长帧数 / LoAF 归因（ontool / ontext / ontool_result）；
//   · .mcol 超出上限后的**收敛时间**—— P0-2 的主指标（改动前 5–10 秒）。
//
// 两侧各跑 repeat 次（默认 3，AGENT.md §6：单次 <10% 差异不采信），取每次的原始值
// 与最坏值。断言只加在「最长帧 ≤ 100ms」这一条上（任务书的验收线）。
//
// 用法（两侧各起一次，端口互不冲突）：
//   $env:W9113_REPO='...\repo-before'; $env:W9113_VITE='http://127.0.0.1:3788'
//   $env:W9113_LABEL='before'; $env:W9113_RESULTS='results/perf-w9113'
//   $env:W9113_PORT='3788'; $env:W9113_CDP_PORT='9333'
//   node scripts/perf/w9113-p0.mjs
//
// profile 一律落 $TEMP（chrome.mjs 保证），results/ 只落 JSON/MD/PNG。
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootApp, pageModule, PANE_EXPR, control, readSummary, readTopLoaf } from './lib/scenario.mjs';
import { mdTable, fmt } from './lib/stats.mjs';

const LABEL = process.env.W9113_LABEL ?? 'run';
const RESULTS = process.env.W9113_RESULTS ?? 'results/perf-w9113';
const PORT = Number(process.env.W9113_PORT ?? 3788);
const CDP_PORT = Number(process.env.W9113_CDP_PORT ?? 9333);
const STEPS = Number(process.env.W9113_STEPS ?? 200);
const GAPS = (process.env.W9113_GAPS ?? '6,4').split(',').map((s) => Number(s));
const REPEAT = Number(process.env.W9113_REPEAT ?? 3);
/** P0-1 的验收线：最长单帧 ≤ 100ms 量级。 */
const MAX_FRAME_ASSERT_MS = 100;
/**
 * 静默之后再观察多久才收尾（ms）。
 *
 * 为什么需要它：prunePaneDom 是**时间窗节流**的安全阀（常规间隔 1s）。一静默就收尾，
 * 「改动前」那条 100 条/秒的回收路径还没轮到下一次扫描就被判成「永远不收敛」——
 * 那是测量口径的错，不是实现的错。给足两个常规间隔。
 */
const PRUNE_GRACE_MS = 2500;

const COUNTS = [
  'const ctx = ' + PANE_EXPR + ';',
  'const R = window.__W9111M.railstate;',
  'const st = R.stateOfOnly(ctx);',
  'return { mcols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length, ops: ctx.ops.size, railBars: st ? st.items.length : 0 };',
].join('\n');

/** 每 step = tool + tool_result + text 三帧（一次工具调用的最小真实序列）。 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 事件**送达**计数器（注入脚本，不动应用源码）。
 *
 * 为什么不能数 DOM 里的工具卡：dom-cap 会**回收**旧列，所以「DOM 里的卡数」是
 * 「送达数 − 回收数」，用它判「有没有丢事件」是错的（第一版就是这么误报的）。
 * 这里包一层 EventSource，按事件名数**到达过**的帧 —— 它与实现无关，只依赖线协议。
 */
const DELIVERY_COUNTER = [
  '(() => {',
  '  if (window.__W9113DELIV) return; // 幂等：重复注入会把 EventSource 包两层、重复计数',
  '  const C = { byName: {}, total: 0 };',
  '  window.__W9113DELIV = C;',
  '  const Real = window.EventSource;',
  '  if (!Real) return;',
  '  let wrapped = false;',
  '  window.EventSource = function (url, cfg) {',
  '    const es = new Real(url, cfg);',
  '    // ★ 只数**第一条** EventSource：本仓有两条（chat.ts 的轮次帧 + taskpanel 的',
  '    //   工具帧），两条都收到全部帧 —— 都数会得到 2×，让「有没有丢」的判据失真。',
  '    if (wrapped) return es;',
  '    wrapped = true;',
  '    const add = es.addEventListener.bind(es);',
  '    es.addEventListener = (name, fn) => add(name, (e) => {',
  '      C.byName[name] = (C.byName[name] || 0) + 1; C.total += 1;',
  '      return fn(e);',
  '    });',
  '    return es;',
  '  };',
  '  window.EventSource.prototype = Real.prototype;',
  '})();',
].join('\n');

/** 读送达计数（页面侧）。 */
const delivered = (app) => app.page.eval('window.__W9113DELIV ? window.__W9113DELIV.byName : null');

/** 一次采样：.mcol / DOM 节点 / ops / rail 条 / 工具卡数。 */
const SAMPLE = [
  'const ctx = ' + PANE_EXPR + ';',
  'const R = window.__W9111M.railstate;',
  'const st = R.stateOfOnly(ctx);',
  'return {',
  '  mcols: ctx.el.querySelectorAll(".mcol").length,',
  '  tools: ctx.el.querySelectorAll(".msg.tool").length,',
  '  results: ctx.el.querySelectorAll(".toolcard-result-preview").length,',
  '  nodes: ctx.el.querySelectorAll("*").length,',
  '  ops: ctx.ops.size,',
  '  railBars: st ? st.items.length : 0,',
  '};',
].join('\n');

const sample = (app) => app.page.eval('(function(){ ' + SAMPLE + ' })()');

/**
 * 突发期间**持续采样**，同时拿到：
 *   · peak —— .mcol 峰值（P0-2 的分子：改动前会冲到 600+ 且长期不落）；
 *   · firstOverMs / convergedMs —— 首次越过上限、以及**持续**回落到上限内的时刻
 *     （P0-2 的主指标：收敛时间）。
 * 判据用「连续两次采样都 ≤ 上限」：单次采样可能落在锯齿的低点，会低估收敛时间。
 */
async function sampleDuringBurst(app, limit, scheduledMs) {
  const t0 = Date.now();
  let peak = { mcols: 0, nodes: 0, ops: 0, railBars: 0, tools: 0, results: 0 };
  let firstOverMs = -1;
  let convergedMs = -1;
  let over = false;
  let okStreak = 0;
  // P0-2 的**主指标**：DOM 高于上限的**累计驻留时间**与最长连续驻留。
  // 为什么不用「突发结束后多久收敛」：裁剪是**渲染驱动**的安全阀，突发结束后没有渲染
  // 就没有扫描 —— 两侧都会停在那儿，那个数衡量的是「有没有触发」，不是「回收跟不跟得上」。
  // 驻留时间直接量「用户看到 DOM 超限」的时长，两侧可比。
  let overDwellMs = 0;
  let overStreakMs = 0;
  let overStreakMaxMs = 0;
  let lastSampleAt = t0;
  // ★ 必须等到**静默**（tools 数连续 12 次采样不变）而不是固定时长：改动前一个帧就是
  //   7 秒，固定窗口会在它还在处理时收尾，两侧的「最终 mcol / 工具卡数」就不可比
  //   （第一版正是这么误报「丢了 93 个事件」的）。上限 90s 兜底。
  let lastTools = -1;
  let stable = 0;
  const deadline = t0 + 90000;
  while (Date.now() < deadline) {
    let c;
    try { c = await sample(app); } catch { break; }
    if (c.mcols > peak.mcols) peak = c;
    if (c.tools !== lastTools) { lastTools = c.tools; stable = 0; } else { stable += 1; }
    const dt = Date.now() - lastSampleAt;
    lastSampleAt = Date.now();
    if (c.mcols > limit) {
      over = true;
      okStreak = 0;
      overDwellMs += dt;
      overStreakMs += dt;
      if (overStreakMs > overStreakMaxMs) overStreakMaxMs = overStreakMs;
      if (firstOverMs < 0) firstOverMs = Date.now() - t0;
    } else {
      overStreakMs = 0;
      if (over) {
        okStreak += 1;
        if (okStreak >= 2 && convergedMs < 0) convergedMs = Date.now() - t0;
      }
    }
    // ★ 收尾判据：已静默（tools 连续 12 次采样不变）+ 静默之后再给 [PRUNE_GRACE_MS]。
    //   **不**要求「当前已回到上限内」——那会让「改动前」（突发结束后再无渲染触发裁剪，
    //   于是永远停在 600+）空转到 90s 兜底。是否收敛由 convergedMs 单独记录（-1 = 没收敛）。
    if (stable >= 12 && Date.now() - t0 > scheduledMs + PRUNE_GRACE_MS) break;
    await sleep(50);
  }
  return { peak, firstOverMs, convergedMs, everOver: over, overDwellMs, overStreakMaxMs };
}

async function runOnce(app, gap, turn, limit) {
  await app.page.addInitScript(DELIVERY_COUNTER); // 幂等（见 DELIVERY_COUNTER 的首行守卫）
  await app.page.navigate(app.origin + '/');
  await sleep(700);
  await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
  await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
  await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
  const b = framesFor(STEPS, gap, turn);
  await readSummary(app.page, { reset: true });
  const t0 = Date.now();
  await control(app, '/__control/burst', { frames: b.frames });
  const mon = await sampleDuringBurst(app, limit, b.scheduledMs);
  const wallMs = Date.now() - t0;
  const summary = await readSummary(app.page);
  const topLoaf = await readTopLoaf(app.page, 3);
  const counts = await sample(app);
  const deliv = await delivered(app);
  const shot = await app.page.send('Page.captureScreenshot', { format: 'png' });
  return {
    gapMs: gap, scheduledMs: b.scheduledMs, wallMs,
    peak: mon.peak, firstOverMs: mon.firstOverMs, convergedMs: mon.convergedMs, everOver: mon.everOver,
    overDwellMs: mon.overDwellMs, overStreakMaxMs: mon.overStreakMaxMs,
    summary, topLoaf, counts, deliv, shot: shot.data,
  };
}

/**
 * P0-2 的**隔离用例**：直接把容器灌到「超出上限 900 列」，然后量回收要多久。
 *
 * 为什么必须隔离：P0-1 的帧内预算同时**限制了新增速率**，于是突发场景里 excess 一直
 * 很小、走不到「按超出量自适应」那条路径（这本身是个好结果，但它证明不了 P0-2 的修法）。
 * 这里直接造出 W9111 实测的那种超限量，把 P0-2 的机制单独量出来：
 *   · force=true 逐次扫描 → **扫描次数**（纯口径，无时钟噪声）；
 *   · force=false 按真实节流轮询 → **墙钟收敛时间**（这就是用户可感的那个数）。
 */
const PRUNE_MICRO = [
  'const M = window.__W9111M.domcap;',
  'const ctx = ' + PANE_EXPR + ';',
  'const limit = M.MAX_DOM_COLS;',
  'const over = window.__W9113OVER;',
  '// 先把容器清空，再造「上限 + over」个列。',
  'ctx.el.replaceChildren();',
  'const frag = document.createDocumentFragment();',
  'for (let i = 0; i < limit + over; i++) { const d = document.createElement("div"); d.className = "mcol"; frag.appendChild(d); }',
  'ctx.el.appendChild(frag);',
  'const before = ctx.el.querySelectorAll(".mcol").length;',
  '// ① 逐次 force 扫描（跳过时间窗节流）→ 要几次才回到上限内。',
  'let scans = 0; let guard = 0;',
  'while (guard++ < 100) { const n = M.prunePaneDom(ctx, true); if (n === 0) break; scans++; }',
  'const afterForce = ctx.el.querySelectorAll(".mcol").length;',
  '// 改动前没有 pruneBatchFor / pruneIntervalFor（自适应是本次新增的）——如实降级成常量。',
  'const batchFor900 = typeof M.pruneBatchFor === "function" ? M.pruneBatchFor(over) : M.DOM_PRUNE_BATCH;',
  'const intervalFor900 = typeof M.pruneIntervalFor === "function" ? M.pruneIntervalFor(over) : M.PRUNE_INTERVAL_MS;',
  'return { limit, over, before, scans, afterForce, batchFor900, intervalFor900 };',
].join('\n');

/** ② 真实节流下的墙钟收敛：force=false 轮询，直到回到上限内。 */
const PRUNE_THROTTLED = [
  'const M = window.__W9111M.domcap;',
  'const ctx = ' + PANE_EXPR + ';',
  'const limit = M.MAX_DOM_COLS;',
  'const over = window.__W9113OVER;',
  'ctx.el.replaceChildren();',
  'const frag = document.createDocumentFragment();',
  'for (let i = 0; i < limit + over; i++) { const d = document.createElement("div"); d.className = "mcol"; frag.appendChild(d); }',
  'ctx.el.appendChild(frag);',
  'const t0 = performance.now();',
  'let scans = 0; let mcols = ctx.el.querySelectorAll(".mcol").length;',
  'while (mcols > limit && performance.now() - t0 < 20000) {',
  '  M.prunePaneDom(ctx, false);',
  '  scans++;',
  '  mcols = ctx.el.querySelectorAll(".mcol").length;',
  '  if (mcols > limit) await new Promise((r) => setTimeout(r, 25));',
  '}',
  'return { ms: performance.now() - t0, scans, finalMcols: mcols };',
].join('\n');

async function runPruneMicro(app, over) {
  await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
  await app.page.eval('window.__W9113OVER = ' + over + ';');
  const force = await app.page.eval('(function(){ ' + PRUNE_MICRO + ' })()');
  // ★ evalAsync 自己就包了一层 async IIFE —— 这里只传**函数体**。
  //   （第一版又包了一层 `(async function(){...})()`，内层的 return 被外层吞掉，
  //     于是 throttled 是 undefined，JSON.stringify 直接把它丢了。）
  const throttled = await app.page.evalAsync(PRUNE_THROTTLED);
  return { over, force, throttled };
}

export async function run() {
  mkdirSync(RESULTS, { recursive: true });
  const app = await bootApp({
    port: PORT,
    cdpPort: CDP_PORT,
    repo: process.env.W9113_REPO,
    vite: process.env.W9113_VITE,
  });
  const rows = [];
  try {
    const limit = await app.page.evalAsync(
      "const m = await import('/src/ui/messages/dom-cap.ts'); return m.MAX_DOM_COLS;",
    );
    let turn = 900;
    for (const gap of GAPS) {
      for (let r = 0; r < REPEAT; r += 1) {
        const row = await runOnce(app, gap, turn++, limit);
        row.repeat = r;
        row.limit = limit;
        rows.push(row);
        process.stdout.write(LABEL + ' gap=' + gap + ' r' + r + ' max=' + Math.round(row.summary.longFramesMax) + 'ms conv=' + row.convergedMs + 'ms\n');
      }
    }
    // P0-2 隔离用例（见 runPruneMicro 的注释：突发场景走不到 excess>300 那条路径）。
    const pruneMicro = [];
    for (const over of [400, 900]) pruneMicro.push(await runPruneMicro(app, over));
    const out = { label: LABEL, steps: STEPS, gaps: GAPS, repeat: REPEAT, maxFrameAssertMs: MAX_FRAME_ASSERT_MS, limit, rows, pruneMicro };
    writeFileSync(join(RESULTS, 'p0-' + LABEL + '.json'), JSON.stringify(out, null, 1));
    writeFileSync(join(RESULTS, 'p0-' + LABEL + '.md'), renderMd(out));
    for (const row of rows) {
      if (row.shot) {
        writeFileSync(join(RESULTS, 'p0-' + LABEL + '-gap' + row.gapMs + '-r' + row.repeat + '.png'), Buffer.from(row.shot, 'base64'));
      }
    }
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const L = ['# W9113 P0 前后对比 · ' + out.label, ''];
  L.push(mdTable(
    ['帧间隔 ms', 'repeat', '计划 ms', '墙钟 ms', '峰值 mcol', '首次越限 ms', '超限驻留 ms', '最长连续超限 ms', 'rAF 帧数', '长帧数', '最长帧 ms', 'LoAF max ms', '最终 mcol', '送达 tool', 'ops', 'DOM 节点'],
    out.rows.map((r) => [
      r.gapMs, r.repeat, r.scheduledMs, r.wallMs, r.peak.mcols, r.firstOverMs, r.overDwellMs, r.overStreakMaxMs,
      r.summary.frames, r.summary.longFrames, fmt(r.summary.longFramesMax, 0), fmt(r.summary.loafMaxMs, 0),
      r.counts.mcols, (r.deliv ?? {}).tool, r.counts.ops, r.counts.nodes,
    ]),
  ));
  L.push('', '「超限驻留 ms」= DOM 高于上限的**累计**时长（P0-2 主指标）；「最长连续超限 ms」= 其中最长的一段。');
  L.push('「送达 tool」= 页面侧 EventSource 计数器收到的 tool 帧数（= 每 step 一帧 × 400，一个都不能少）。');
  L.push('', '## P0-2 隔离用例：一次超限 400 / 900 列要多久回收', '');
  L.push(mdTable(
    ['超限量', '单批量', '扫描间隔 ms', 'force 扫描次数', 'force 后 mcol', '节流墙钟 ms', '节流扫描次数', '节流后 mcol'],
    out.pruneMicro.map((p) => [
      p.over, p.force.batchFor900, p.force.intervalFor900, p.force.scans, p.force.afterForce,
      fmt(p.throttled.ms, 0), p.throttled.scans, p.throttled.finalMcols,
    ]),
  ));
  L.push('', '## LoAF 归因（每次运行最长的那一帧）', '');
  L.push(mdTable(['帧间隔', 'repeat', '帧时长 ms', '脚本数', 'invoker', '脚本总耗时 ms'], out.rows.map((r) => {
    const top = (r.topLoaf || [])[0] || {};
    const scripts = top.scripts || [];
    const total = scripts.reduce((a, s) => a + s.duration, 0);
    return [r.gapMs, r.repeat, fmt(top.duration, 0), scripts.length, [...new Set(scripts.map((s) => s.invoker))].join(','), fmt(total, 0)];
  })));
  return L.join('\n');
}

const _r = await run();
const worst = _r.rows.reduce((a, r) => Math.max(a, r.summary.longFramesMax), 0);
const worstConv = _r.rows.reduce((a, r) => Math.max(a, r.convergedMs), 0);
// ★ 完整性不变量：每 step = tool + tool_result + text 三帧（+ 首尾 status/done），
//   到达的帧必须**全部**被处理完 —— 帧内预算的语义是「延后」，丢事件会让实时流少段
//   （W895-R 抓的就是这个）。判据用**送达计数器**（与实现无关），不是 DOM 卡数
//   （dom-cap 会回收旧列，数 DOM 会把「已回收」误判成「丢了」）。
const expectDeliv = { tool: _r.steps, tool_result: _r.steps, text: _r.steps };
const missing = _r.rows.filter((r) => {
  const d = r.deliv ?? {};
  return d.tool !== expectDeliv.tool || d.tool_result !== expectDeliv.tool_result || d.text !== expectDeliv.text;
});
console.log(JSON.stringify({
  label: _r.label,
  steps: _r.steps,
  worstLongestFrameMs: Math.round(worst),
  worstConvergeMs: worstConv,
  worstOverDwellMs: _r.rows.reduce((a, r) => Math.max(a, r.overDwellMs), 0),
  worstOverStreakMs: _r.rows.reduce((a, r) => Math.max(a, r.overStreakMaxMs), 0),
  pass: worst <= _r.maxFrameAssertMs,
  lostEvents: missing.length,
  pruneMicro: _r.pruneMicro.map((p) => ({
    over: p.over, batch: p.force.batchFor900, intervalMs: p.force.intervalFor900,
    forceScans: p.force.scans, forceFinal: p.force.afterForce,
    throttledMs: Math.round(p.throttled.ms), throttledScans: p.throttled.scans, throttledFinal: p.throttled.finalMcols,
  })),
  rows: _r.rows.map((r) => ({
    gap: r.gapMs, repeat: r.repeat, maxFrame: Math.round(r.summary.longFramesMax), longFrames: r.summary.longFrames,
    convMs: r.convergedMs, firstOverMs: r.firstOverMs, peakMcols: r.peak.mcols,
    overDwellMs: r.overDwellMs, overStreakMaxMs: r.overStreakMaxMs,
    finalMcols: r.counts.mcols, delivered: r.deliv,
  })),
}, null, 1));
if (worst > _r.maxFrameAssertMs || missing.length > 0) process.exitCode = 1;
