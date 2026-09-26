// ============================================================================
// scripts/perf/verify.mjs — **复核既有性能声明**（本仓已有工作，去验真伪）
// ----------------------------------------------------------------------------
// 每条声明一个用例，给数字与反例：
//   C1 MAX_DOM_COLS=600 真的把 .mcol 钉在常数上吗（含「回收速率跟不上新增速率」的检验）
//   C2 W1502：DOM 被摘之后 ctx.ops 真的不再无界增长吗
//   C3 MESSAGE_RENDER_LIMIT=65536 的超限路径真的会触发吗（流式路径）
//   C4 W1524 cadence：合并窗口真的把长帧压下去了吗（渲染次数 vs 事件帧数）
//   C5 THINK_CONTAINER_LIMIT=262144：单段上限 65536 与容器预算哪个先绑死
// ============================================================================
import { bootApp, pageModule, PANE_EXPR, control, readSummary, readLoafByInvoker } from './lib/scenario.mjs';
import { saveRaw, mdTable, fmt } from './lib/stats.mjs';

/** 页内：DOM / 持有者计数。 */
const COUNTS = [
  'const ctx = ' + PANE_EXPR + ';',
  'const M = window.__W9111M.messages;',
  'const R = window.__W9111M.railstate;',
  'const st = R.stateOfOnly(ctx);',
  'return { mcols: ctx.el.querySelectorAll(".mcol").length, nodes: ctx.el.querySelectorAll("*").length, ops: ctx.ops.size, restoreOps: ctx.restoreOps.size, thinkChars: M.thinkRetained(ctx.el), thinkSegs: ctx.el.querySelectorAll(".think-seg").length, railItems: st ? st.items.length : 0, railHolder: st ? st.holder.childNodes.length : 0, oversizeNotes: ctx.el.querySelectorAll(".oversize-note").length, contentNodes: ctx.el.querySelectorAll(".content").length };',
].join('\n');

async function counts(page) { return page.eval('(function(){ ' + COUNTS + ' })()'); }

export async function verify() {
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const out = {};
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'railstate', '/src/ui/rail-state.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');

    // ---------- C1 + C2：高速工具流下的 DOM 上限与 ops ----------
    // 每个 step = tool + tool_result + 一小段 text（触发 renderTextView → prunePaneDom）
    // 帧间隔 4ms ⇒ ~250 step/s，远超 prune 的 100 条/秒。
    const N_STEPS = 900;
    const frames = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn: 500 }];
    let at = 0;
    for (let i = 0; i < N_STEPS; i++) {
      at += 4; frames.push({ at, name: 'tool', payload: { id: 'st-' + i, name: 'read_file', args: { path: 'f' + i + '.md' } }, turn: 500 });
      at += 4; frames.push({ at, name: 'tool_result', payload: { id: 'st-' + i, ok: true, value: 'ok' + i }, turn: 500 });
      at += 4; frames.push({ at, name: 'text', payload: { delta: 'step ' + i + ' ' }, turn: 500 });
    }
    at += 10; frames.push({ at, name: 'done', payload: { text: '' }, turn: 500 });
    at += 10; frames.push({ at, name: 'status', payload: { phase: 'completed' }, turn: 500 });
    const scheduledMs = at;
    await readSummary(app.page, { reset: true });
    await control(app, '/__control/burst', { frames });
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < scheduledMs + 1500) {
      await new Promise((r) => setTimeout(r, 400));
      samples.push({ atMs: Date.now() - t0, ...(await counts(app.page)) });
    }
    const c1 = { nSteps: N_STEPS, scheduledMs, samples, final: await counts(app.page), summary: await readSummary(app.page) };
    out.C1_domCap = c1;
    process.stdout.write('C1 ');

    // 收尾：强制 prune 把 DOM 压回上限，看 ops 会不会跟着降
    const beforeForce = await counts(app.page);
    await app.page.eval('(function(){ const D = window.__W9111M.domcap; const ctx = ' + PANE_EXPR + '; for (let i = 0; i < 40; i++) D.prunePaneDom(ctx, true); return 1; })()');
    const afterForce = await counts(app.page);
    out.C2_opsBounded = { beforeForce, afterForce };
    process.stdout.write('C2 ');

    // ---------- C3：超长助手正文的渲染上限（流式路径） ----------
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 700));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    const bigText = 'lorem ipsum dolor sit amet '.repeat(10000).slice(0, 260000);
    const f3 = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn: 600 }];
    let at3 = 0;
    for (let i = 0; i < bigText.length; i += 4096) { at3 += 4; f3.push({ at: at3, name: 'text', payload: { delta: bigText.slice(i, i + 4096) }, turn: 600 }); }
    at3 += 20; f3.push({ at: at3, name: 'done', payload: { text: bigText }, turn: 600 });
    at3 += 20; f3.push({ at: at3, name: 'status', payload: { phase: 'completed' }, turn: 600 });
    await control(app, '/__control/burst', { frames: f3 });
    await new Promise((r) => setTimeout(r, at3 + 1500));
    const c3 = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; const c = ctx.el.querySelector(".content"); const note = ctx.el.querySelector(".oversize-note"); return { contentChars: c ? c.textContent.length : 0, note: note ? note.textContent : null, oversizeNotes: ctx.el.querySelectorAll(".oversize-note").length, mcols: ctx.el.querySelectorAll(".mcol").length }; })()');
    out.C3_oversize = { streamedChars: bigText.length, ...c3 };
    process.stdout.write('C3 ');

    // ---------- C4：cadence 合并窗口（渲染次数 vs 事件帧数） ----------
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 700));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    const f4 = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn: 700 }];
    const nText = 64;
    for (let i = 0; i < nText; i++) f4.push({ at: 16 * (i + 1), name: 'text', payload: { delta: 'chunk-' + i + ' ' + 'q'.repeat(200) }, turn: 700 });
    f4.push({ at: 16 * (nText + 1), name: 'done', payload: { text: '' }, turn: 700 });
    f4.push({ at: 16 * (nText + 2), name: 'status', payload: { phase: 'completed' }, turn: 700 });
    await readSummary(app.page, { reset: true });
    await control(app, '/__control/burst', { frames: f4 });
    await new Promise((r) => setTimeout(r, 16 * (nText + 3) + 1200));
    const s4 = await readSummary(app.page);
    const contentMutations = s4.mutByTarget['childList:content rendered'] ?? s4.mutByTarget['childList:content'] ?? null;
    out.C4_cadence = { textFrames: nText, contentMutations, mutByTarget: s4.mutByTarget, longFrames: s4.longFrames, longFramesMax: s4.longFramesMax, loafByInvoker: await readLoafByInvoker(app.page) };
    process.stdout.write('C4 ');

    // ---------- C5：多段思考 —— 单段上限 vs 容器预算 ----------
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 700));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    const f5 = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn: 800 }];
    let at5 = 0;
    const SEG = 65536;
    for (let s = 0; s < 8; s++) {
      at5 += 20; f5.push({ at: at5, name: 'thinking', payload: { delta: ('s' + s + '-').repeat(SEG / 3).slice(0, SEG) }, turn: 800 });
      at5 += 20; f5.push({ at: at5, name: 'tool', payload: { id: 'seg-' + s, name: 'read_file', args: { path: 'x.md' } }, turn: 800 });
    }
    at5 += 20; f5.push({ at: at5, name: 'done', payload: { text: '' }, turn: 800 });
    at5 += 20; f5.push({ at: at5, name: 'status', payload: { phase: 'completed' }, turn: 800 });
    await control(app, '/__control/burst', { frames: f5 });
    await new Promise((r) => setTimeout(r, at5 + 1500));
    const c5 = await app.page.eval('(function(){ const ctx = ' + PANE_EXPR + '; const M = window.__W9111M.messages; const segs = Array.prototype.map.call(ctx.el.querySelectorAll(".think-seg"), function(s){ return { collapsed: s.classList.contains("collapsed"), chars: s.querySelector(".think-seg-body").textContent.length, dropped: (s.querySelector(".oversize-text")||{}).textContent || null }; }); return { segCount: segs.length, segs: segs, retained: M.thinkRetained(ctx.el), containerLimit: M.THINK_CONTAINER_LIMIT }; })()');
    out.C5_thinkBudget = { streamedSegments: 8, segBytes: SEG, ...c5 };
    process.stdout.write('C5 ');

    saveRaw('verify.json', out);
    saveRaw('verify.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const L = ['# 既有声明复核', ''];
  L.push('## C1 MAX_DOM_COLS=600 —— 高速工具流下的 mcol / ops 曲线');
  L.push('');
  L.push(mdTable(['t ms', 'mcol', 'DOM 节点', 'ops', 'rail 条'], out.C1_domCap.samples.map((s) => [s.atMs, s.mcols, s.nodes, s.ops, s.railItems])));
  L.push('');
  L.push('## C2 强制 prune 后 ops 是否跟着降');
  L.push('');
  L.push(mdTable(['时点', 'mcol', 'ops', 'rail 条'], [['before', out.C2_opsBounded.beforeForce.mcols, out.C2_opsBounded.beforeForce.ops, out.C2_opsBounded.beforeForce.railItems], ['after', out.C2_opsBounded.afterForce.mcols, out.C2_opsBounded.afterForce.ops, out.C2_opsBounded.afterForce.railItems]]));
  L.push('');
  L.push('## C3 / C4 / C5');
  L.push('');
  L.push('- C3 流式 ' + out.C3_oversize.streamedChars + ' 字符 → content 渲染 ' + out.C3_oversize.contentChars + ' 字符，提示行 = ' + out.C3_oversize.note);
  L.push('- C4 ' + out.C4_cadence.textFrames + ' 个 text 帧 → .content 变更 ' + JSON.stringify(out.C4_cadence.contentMutations) + '，长帧 ' + out.C4_cadence.longFrames);
  L.push('- C5 ' + out.C5_thinkBudget.segCount + ' 段，保留合计 ' + out.C5_thinkBudget.retained + ' / 上限 ' + out.C5_thinkBudget.containerLimit);
  return L.join('\n');
}

const _r = await verify();
console.log(JSON.stringify({ C1_samples: _r.C1_domCap.samples.length, C2: _r.C2_opsBounded, C3: _r.C3_oversize, C4: _r.C4_cadence, C5: _r.C5_thinkBudget }, null, 1));