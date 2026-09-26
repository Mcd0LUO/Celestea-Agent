// ============================================================================
// scripts/perf/lib/probe.mjs — 注入页面的**只读探针**（不改一行应用源码）
// ----------------------------------------------------------------------------
// 三个能力：
//   1) 帧节拍：requestAnimationFrame 链，记录每帧间隔 → 长帧（>50ms）数量与最长帧；
//   2) LoAF：PerformanceObserver('long-animation-frame')，拿到长帧的**脚本归因**
//      （invoker / sourceURL / duration）—— 这是「EventSource 突发是否掉帧」的关键证据；
//   3) MutationObserver：在 #messages 上子树级监听，按秒/按场景统计 added/removed。
// 全部挂在 window.__W9111 上，用 CDP Runtime.evaluate 读取。
// ============================================================================

/** 注入脚本源码（页面上下文）。用数组拼装，避免宿主源码里嵌套模板串。 */
export const PROBE_SOURCE = [
  '(() => {',
  '  if (window.__W9111) return;',
  '  const P = {',
  '    t0: performance.now(),',
  '    frames: [], loaf: [], marks: [], observers: [], errs: [],',
  '    mut: { added: 0, removed: 0, records: 0, byTarget: {} },',
  '    mutWindows: [],',
  '  };',
  '  window.__W9111 = P;',
  '  let last = performance.now();',
  '  const tick = (now) => { P.frames.push({ t: now, dt: now - last }); last = now; requestAnimationFrame(tick); };',
  '  requestAnimationFrame(tick);',
  '  try {',
  '    const po = new PerformanceObserver((list) => {',
  '      for (const e of list.getEntries()) {',
  '        P.loaf.push({',
  '          startTime: e.startTime, duration: e.duration, blockingDuration: e.blockingDuration,',
  '          renderStart: e.renderStart, styleAndLayoutStart: e.styleAndLayoutStart,',
  '          scripts: (e.scripts || []).map((s) => ({',
  '            name: s.name, invoker: s.invoker, invokerType: s.invokerType, duration: s.duration,',
  '            sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName, sourceCharPosition: s.sourceCharPosition,',
  '          })),',
  '        });',
  '      }',
  '    });',
  "    po.observe({ type: 'long-animation-frame', buffered: false });",
  '    P.observers.push(po);',
  "  } catch (e) { P.errs.push('LoAF unavailable: ' + String(e)); }",
  '  function attachMutation() {',
  "    const host = document.getElementById('messages');",
  '    if (!host) { setTimeout(attachMutation, 50); return; }',
  '    const mo = new MutationObserver((records) => {',
  '      let added = 0, removed = 0;',
  '      for (const r of records) {',
  '        added += r.addedNodes.length; removed += r.removedNodes.length;',
  '        const tn = r.target;',
  "        const key = r.type + ':' + (tn && tn.className ? String(tn.className).slice(0, 40) : String(tn && tn.nodeName));",
  '        const slot = P.mut.byTarget[key] || (P.mut.byTarget[key] = { added: 0, removed: 0, records: 0 });',
  '        slot.added += r.addedNodes.length; slot.removed += r.removedNodes.length; slot.records += 1;',
  '      }',
  '      P.mut.added += added; P.mut.removed += removed; P.mut.records += records.length;',
  '      P.mutWindows.push({ t: performance.now(), added, removed, records: records.length });',
  '    });',
  "    mo.observe(host, { childList: true, subtree: true });",
  '    P.observers.push(mo);',
  '  }',
  '  attachMutation();',
  '  P.mark = (name) => { P.marks.push({ name, t: performance.now() }); };',
  '  P.reset = () => {',
  '    P.frames.length = 0; P.loaf.length = 0; P.marks.length = 0; P.mutWindows.length = 0;',
  '    P.mut.added = 0; P.mut.removed = 0; P.mut.records = 0; P.mut.byTarget = {};',
  '    last = performance.now();',
  '  };',
  '  P.summary = () => {',
  '    const dts = P.frames.map((f) => f.dt).slice(1).sort((a, b) => a - b);',
  '    const q = (p) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))] : 0;',
  '    const long = dts.filter((d) => d > 50);',
  '    return {',
  '      frames: dts.length,',
  '      spanMs: P.frames.length ? P.frames[P.frames.length - 1].t - P.frames[0].t : 0,',
  '      p50: q(0.5), p95: q(0.95), max: dts.length ? dts[dts.length - 1] : 0,',
  '      longFrames: long.length, longFramesTotalMs: long.reduce((a, b) => a + b, 0),',
  '      longFramesMax: long.length ? Math.max.apply(null, long) : 0,',
  '      mutAdded: P.mut.added, mutRemoved: P.mut.removed, mutRecords: P.mut.records,',
  '      mutByTarget: P.mut.byTarget,',
  '      loafCount: P.loaf.length, loafTotalMs: P.loaf.reduce((a, b) => a + b.duration, 0),',
  '      loafMaxMs: P.loaf.length ? Math.max.apply(null, P.loaf.map((l) => l.duration)) : 0,',
  '      marks: P.marks.slice(),',
  '    };',
  '  };',
  '  P.loafByInvoker = () => {',
  '    const out = {};',
  '    for (const l of P.loaf) for (const s of l.scripts) {',
  "      const k = (s.invoker || '?') + '|' + (s.invokerType || '?') + '|' + (s.sourceURL || '').split('/').slice(-2).join('/');",
  '      const o = out[k] || (out[k] = { n: 0, totalMs: 0, maxMs: 0 });',
  '      o.n += 1; o.totalMs += s.duration; o.maxMs = Math.max(o.maxMs, s.duration);',
  '    }',
  '    return out;',
  '  };',
  '  P.topLoaf = (n) => P.loaf.slice().sort((a, b) => b.duration - a.duration).slice(0, n || 5);',
  '  P.rafGaps = (n) => {',
  '    const dts = P.frames.map((f) => f.dt);',
  '    const out = [];',
  '    for (let i = 0; i < dts.length; i++) if (dts[i] > 100) out.push({ i: i, t: P.frames[i].t, dt: dts[i] });',
  '    return out.slice(0, n || 50);',
  '  };',
  "  return 'probe-installed';",
  '})();',
].join('\n');

/** 把探针注入到每个新文档（必须在应用脚本之前）。 */
export async function installProbe(page) {
  await page.addInitScript(PROBE_SOURCE);
}

/** 读取一次 summary（可选先 reset）。 */
export async function readSummary(page, { reset = false } = {}) {
  return page.eval('(function(){ ' + (reset ? 'window.__W9111.reset();' : '') + ' return window.__W9111.summary(); })()');
}

/** 读取 LoAF 归因表。 */
export async function readLoafByInvoker(page) {
  return page.eval('(function(){ return window.__W9111.loafByInvoker(); })()');
}

/** 读取最长的 n 个 LoAF 条目（含脚本归因）。 */
export async function readTopLoaf(page, n = 5) {
  return page.eval('(function(){ return window.__W9111.topLoaf(' + n + '); })()');
}

/** 读取 >100ms 的 rAF 间隔（掉帧事件）。 */
export async function readRafGaps(page, n = 50) {
  return page.eval('(function(){ return window.__W9111.rafGaps(' + n + '); })()');
}
