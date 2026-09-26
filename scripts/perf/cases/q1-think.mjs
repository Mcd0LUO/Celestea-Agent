// ============================================================================
// scripts/perf/cases/q1-think.mjs — 问题 1：**大思考块是否卡死**
// ----------------------------------------------------------------------------
// 真实量级（源码注释里的真机数字）：单段最大 1,362,974 字符；600 段 × 64 K = 37.5 MB。
//
// 关键区分：思考段**流式期间自动展开**（W752），折叠态 display:none 不参与布局。
// 所以「卡不卡」只在**展开态 + 强制布局**下才有意义。四条测量：
//   A clampCurve   —— 反事实曲线：直接把 N 字符写进展开的 .think-seg-body，量布局代价
//                     （= 假如没有 THINK_RENDER_LIMIT，即 W1485 修之前的样子）
//   B boundedOnce  —— 现状：一次 appendThinking(N) 的代价与**实际保留字符数**
//   C streamingTick—— 现状热路径：ctx.streaming=true（展开）下 512 字符/次的分块追加
//   D sseBurst     —— 真 EventSource：30ms 与 4ms 两种节拍下 64K 思考的 LoAF 长帧
//   E toggle       —— 折叠↔展开切换（64K 保留量）
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, control, readSummary, readLoafByInvoker, readTopLoaf, readRafGaps } from '../lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from '../lib/stats.mjs';

const SIZES = [8192, 65536, 262144, 1048576, 1363020];
const CHUNK = 512;

function setText(chars) {
  return "window.__W9111TEXT = 'abcdefghij'.repeat(Math.ceil(" + chars + " / 10)).slice(0, " + chars + "); window.__W9111TEXT.length;";
}

/** 建一个空的思考段并强制展开。 */
const SETUP_SEG = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'ctx.el.replaceChildren();',
  'const seg = M.buildThinkSeg({ collapsed: false });',
  'ctx.el.appendChild(seg.root);',
  'return seg.body.className;',
].join('\n');

/** A：反事实曲线 —— 直接写 textContent（绕过 THINK_RENDER_LIMIT），强制布局。 */
const CLAMP_CURVE = [
  'const ctx = ' + PANE_EXPR + ';',
  'const body = ctx.el.querySelector(".think-seg-body");',
  'const text = window.__W9111TEXT;',
  'const times = [];',
  'for (let k = 0; k < 5; k++) {',
  '  const a = performance.now();',
  '  body.textContent = text;',
  '  void ctx.el.offsetHeight;',
  '  times.push(performance.now() - a);',
  '}',
  'const s = times.slice().sort(function(x,y){return x-y;});',
  'return { times: times, median: s[2], max: Math.max.apply(null, times), bodyChars: body.textContent.length };',
].join('\n');

/** B：现状 —— 一次 appendThinking(N)。 */
const BOUNDED_ONCE = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'ctx.el.replaceChildren();',
  'ctx.thinkSeg = null;',
  'ctx.streaming = true;',
  'const t0 = performance.now();',
  'M.appendThinking(ctx, window.__W9111TEXT);',
  'void ctx.el.offsetHeight;',
  'const ms = performance.now() - t0;',
  'const body = ctx.el.querySelector(".think-seg-body");',
  'return { ms: ms, retained: M.thinkRetained(ctx.el), bodyChars: body.textContent.length,',
  '  expanded: !ctx.el.querySelector(".think-seg").classList.contains("collapsed"),',
  '  note: (ctx.el.querySelector(".oversize-text") || {}).textContent || null };',
].join('\n');

/** C：现状热路径 —— 展开态下 512 字符/次，每次强制布局。 */
const STREAM_TICK = [
  'const M = window.__W9111M.messages;',
  'const ctx = ' + PANE_EXPR + ';',
  'ctx.el.replaceChildren();',
  'ctx.thinkSeg = null;',
  'ctx.streaming = true;',
  'const text = window.__W9111TEXT;',
  'const times = [];',
  'let i = 0;',
  'const t0 = performance.now();',
  'while (i < text.length) {',
  '  const a = performance.now();',
  '  M.appendThinking(ctx, text.slice(i, i + ' + CHUNK + '));',
  '  void ctx.el.offsetHeight;',
  '  times.push(performance.now() - a);',
  '  i += ' + CHUNK + ';',
  '}',
  'const total = performance.now() - t0;',
  'const s = times.slice().sort(function(x,y){return x-y;});',
  'return { total: total, n: times.length, first: times[0], last: times[times.length-1], max: Math.max.apply(null, times),',
  '  median: s[Math.floor(s.length/2)], p95: s[Math.floor(0.95*s.length)], retained: M.thinkRetained(ctx.el),',
  '  bodyChars: ctx.el.querySelector(".think-seg-body").textContent.length };',
].join('\n');

/** E：折叠↔展开切换（在当前保留量下）。 */
const TOGGLE = [
  'const ctx = ' + PANE_EXPR + ';',
  'const head = ctx.el.querySelector(".think-seg .think-head");',
  'const times = [];',
  'for (let k = 0; k < 5; k++) {',
  '  const a = performance.now();',
  '  head.click();',
  '  void ctx.el.offsetHeight;',
  '  times.push(performance.now() - a);',
  '}',
  'const s = times.slice().sort(function(x,y){return x-y;});',
  'return { times: times, median: s[2], max: Math.max.apply(null, times) };',
].join('\n');

/** D：真 EventSource 突发。 */
async function sseBurst(app, chars, stepMs, turn) {
  await app.page.navigate(app.origin + '/');
  await new Promise((r) => setTimeout(r, 700));
  await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
  const text = 'abcdefghij'.repeat(Math.ceil(chars / 10)).slice(0, chars);
  const frames = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn }];
  let at = 0;
  for (let i = 0; i < text.length; i += 512) {
    at += stepMs;
    frames.push({ at, name: 'thinking', payload: { delta: text.slice(i, i + 512) }, turn });
  }
  frames.push({ at: at + stepMs, name: 'done', payload: { text: '' }, turn });
  frames.push({ at: at + stepMs * 2, name: 'status', payload: { phase: 'completed' }, turn });
  const endAt = at + stepMs * 2;
  await readSummary(app.page, { reset: true });
  const t0 = Date.now();
  await control(app, '/__control/burst', { frames });
  await new Promise((r) => setTimeout(r, endAt + 1500));
  const summary = await readSummary(app.page);
  const loaf = await readLoafByInvoker(app.page);
  const topLoaf = await readTopLoaf(app.page, 4);
  const rafGaps = await readRafGaps(app.page, 12);
  const dom = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; const seg = ctx.el.querySelector(".think-seg"); return { segs: ctx.el.querySelectorAll(".think-seg").length, bodyChars: seg ? seg.querySelector(".think-seg-body").textContent.length : 0, collapsed: seg ? seg.classList.contains("collapsed") : null }; })()');
  return { chars, stepMs, frameCount: frames.length, scheduledMs: endAt, wallMs: Date.now() - t0, summary, loafByInvoker: loaf, topLoaf, rafGaps, dom };
}

export async function q1() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const rows = [];
  try {
    for (const chars of SIZES) {
      await app.page.navigate(app.origin + '/');
      await new Promise((r) => setTimeout(r, 650));
      await pageModule(app.page, 'messages', '/src/ui/messages.ts');
      await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
      await app.page.eval(setText(chars));
      const setup = await app.page.eval('(function(){ ' + SETUP_SEG + ' })()');
      const clampCurve = await app.page.eval('(function(){ ' + CLAMP_CURVE + ' })()');
      const toggle = await app.page.eval('(function(){ ' + TOGGLE + ' })()');
      const once = await app.page.eval('(function(){ ' + BOUNDED_ONCE + ' })()');
      await readSummary(app.page, { reset: true });
      const stream = await app.page.eval('(function(){ ' + STREAM_TICK + ' })()');
      const streamSummary = await readSummary(app.page);
      rows.push({ chars, setup, clampCurve, toggle, once, stream, streamSummary });
      process.stdout.write(chars + ' ');
    }
    const sse = [];
    sse.push(await sseBurst(app, 65536, 30, 401));
    sse.push(await sseBurst(app, 65536, 4, 402));
    sse.push(await sseBurst(app, 1048576, 4, 403));

    const out = { sizes: rows, sseBursts: sse };
    saveRaw('q1-think.json', out);
    saveRaw('q1-think.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const rows = out.sizes.map((r) => [
    r.chars,
    fmt(r.clampCurve.median, 1),
    fmt(r.clampCurve.max, 1),
    fmt(r.once.ms, 1),
    fmt(r.once.retained),
    fmt(r.stream.median, 2),
    fmt(r.stream.max, 2),
    fmt(r.stream.total, 0),
    fmt(r.toggle.median, 2),
    fmt(r.streamSummary.longFrames),
  ]);
  const sseRows = out.sseBursts.map((s) => [s.chars, s.stepMs, s.frameCount, s.wallMs, s.summary.frames, s.summary.longFrames, fmt(s.summary.longFramesMax, 0), fmt(s.summary.loafMaxMs, 0), s.dom.bodyChars]);
  return ['# Q1 大思考块', '', mdTable(['字符数', '反事实布局中位 ms', '反事实 max ms', '单次 append ms', '实际保留字符', '流式中位 ms', '流式 max ms', '流式总 ms', '切换中位 ms', '流式长帧'], rows), '', '# 真 SSE', '', mdTable(['字符', '节拍 ms', '帧数', '墙钟 ms', 'rAF 帧数', '长帧', '最长帧 ms', 'LoAF max ms', '正文渲染字符'], sseRows), ''].join('\n');
}
