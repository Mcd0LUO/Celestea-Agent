// ============================================================================
// scripts/perf/focus-think-ledger.mjs — 焦点复现：thinkBudget 账本的两处疑点
// ----------------------------------------------------------------------------
// 疑点 A（prune 不记账）：prunePaneDom 整段摘掉思考列时**只动 DOM**，从不调用
//   addThinkRetained(container, -n)。若成立，账本会随每次回收**单向累加**，
//   而 enforceThinkBudget 只回收「还在 DOM 里的段」⇒ 账本长期高于真实保留量，
//   最终把每个新思考段都立即回收（用户看到满屏「已省略 N 字符」）。
//   判据：ledger（thinkRetained）vs DOM 内实际正文总字符，随轮次发散。
//
// 疑点 B（restore 记到离屏容器）：restore.ts 的 renderThinkingHistory 调
//   noteRestoredThinking(container, seg)，container 是**离屏 off div**，
//   而 live 路径记到 ctx.el。replaceChildren 搬家后账本留在 off 上（随后被丢弃）
//   ⇒ 刷新后 thinkRetained(ctx.el) 应为 0，而 DOM 里有一堆思考正文。
//   判据：seed 历史 → 刷新 → 读 thinkRetained(ctx.el) 与 DOM 正文总字符。
// ============================================================================
import { bootApp, pageModule, PANE_EXPR } from './lib/scenario.mjs';
import { saveRaw, mdTable } from './lib/stats.mjs';

/** 一轮 = user + think + assistant + tool（4 列），think 约 3000 字符。 */
const ONE = [
  'const M = window.__W9111M.messages;',
  'const T = window.__W9111M.toolcards;',
  'const ctx = ' + PANE_EXPR + ';',
  'const i = window.__W9111I;',
  'M.addUserMessage(ctx, "u" + i + " " + "x".repeat(200));',
  'ctx.streaming = true;',
  'M.appendThinking(ctx, "t" + i + " " + "y".repeat(3000));',
  'const a = M.ensureAssistant(ctx);',
  'M.appendText(ctx, a, "a" + i + " " + "z".repeat(500));',
  'M.flushTextSegment(ctx);',
  'T.pushToolCard(ctx, { id: "tool-" + i, name: "read_file", args: { path: "f" + i + ".md" } });',
  'M.endTurn(ctx);',
  'ctx.streaming = false;',
  'return 1;',
].join('\n');

const LEDGER = [
  'const ctx = ' + PANE_EXPR + ';',
  'const M = window.__W9111M.messages;',
  'const segs = ctx.el.querySelectorAll(".msg.think-seg");',
  'let domChars = 0, collapsed = 0, notes = 0;',
  'for (const s of segs) {',
  '  domChars += s.querySelector(".think-seg-body").textContent.length;',
  '  if (s.classList.contains("collapsed")) collapsed += 1;',
  '  if (s.querySelector(".oversize-text")) notes += 1;',
  '}',
  'return { ledger: M.thinkRetained(ctx.el), domChars: domChars, segs: segs.length, collapsed: collapsed, withNote: notes, mcols: ctx.el.querySelectorAll(".mcol").length };',
].join('\n');

/** 造 N 条历史思考消息（每条 8K），用于疑点 B。 */
function thinkHistory(n, chars) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: 'thinking', content: ('h' + i + '-').repeat(Math.ceil(chars / 3)).slice(0, chars) });
  return out;
}

export async function focusThinkLedger() {
  // ---------- 疑点 A ----------
  const app = await bootApp({ port: 3788, cdpPort: 9333 });
  const drift = [];
  let restoreCase = null;
  try {
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'toolcards', '/src/ui/toolcards.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    await pageModule(app.page, 'domcap', '/src/ui/messages/dom-cap.ts');
    for (let i = 0; i < 220; i++) {
      await app.page.eval('(function(){ window.__W9111I = ' + i + '; ' + ONE + ' })()');
      if (i % 10 === 9 || i > 145) drift.push({ round: i + 1, ...(await app.page.eval('(function(){ ' + LEDGER + ' })()')) });
    }
    // ---------- 疑点 B：刷新 + 历史 ----------
    const hist = thinkHistory(60, 8192); // 60 段 x 8K = 480K > 预算 256K
    await fetch(app.origin + '/__control/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: hist }) });
    await app.page.navigate(app.origin + '/');
    await new Promise((r) => setTimeout(r, 2000));
    await pageModule(app.page, 'messages', '/src/ui/messages.ts');
    await pageModule(app.page, 'viewctx', '/src/ui/viewctx.ts');
    restoreCase = { historySegs: hist.length, historyChars: hist.reduce((a, m) => a + m.content.length, 0), ...(await app.page.eval('(function(){ ' + LEDGER + ' })()')) };
    const out = { drift, restoreCase };
    saveRaw('focus-think-ledger.json', out);
    saveRaw('focus-think-ledger.md', renderMd(out));
    return out;
  } finally {
    await app.close();
  }
}

function renderMd(out) {
  const L2 = ['# thinkBudget 账本漂移', '', mdTable(['轮次', 'ledger', 'DOM 正文总字符', 'think 段', '折叠段', '带提示段', 'mcol'], out.drift.map((d) => [d.round, d.ledger, d.domChars, d.segs, d.collapsed, d.withNote, d.mcols])), ''];
  const r = out.restoreCase;
  L2.push('## 刷新后（历史 ' + r.historySegs + ' 段 / ' + r.historyChars + ' 字符）');
  L2.push('');
  L2.push('- thinkRetained(ctx.el) = **' + r.ledger + '**');
  L2.push('- DOM 内思考正文总字符 = ' + r.domChars + '，段数 = ' + r.segs + '，带省略提示 = ' + r.withNote);
  return L2.join('\n');
}

const _r = await focusThinkLedger();
console.log(JSON.stringify({ driftTail: _r.drift.slice(-14), restoreCase: _r.restoreCase }, null, 1));
