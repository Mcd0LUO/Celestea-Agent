// scripts/perf/lib/scenario.mjs — 场景公共件：取 pane、动态 import 应用模块、跑 SSE 突发。
import { boot, waitFor, control, SESSION_ID } from './app.mjs';
import { installProbe, readSummary, readLoafByInvoker, readTopLoaf, readRafGaps } from './probe.mjs';

export { SESSION_ID, control, waitFor, readSummary, installProbe, readLoafByInvoker, readTopLoaf, readRafGaps };

/** 起应用并等到 .sess-pane 就绪。 */
export async function bootApp(o = {}) {
  const app = await boot(o);
  await installProbe(app.page);
  await app.boot();
  await waitFor(app.page, 'return document.querySelector(".sess-pane:not([hidden])") !== null;', { label: 'pane ready' });
  // 历史恢复是异步的：等到它标记 restored 或超时
  await waitFor(app.page, 'var p = document.querySelector(".sess-pane:not([hidden])"); return p !== null && p.dataset.session !== undefined;', { label: 'pane id' });
  return app;
}

/**
 * 在页面里动态 import 一个**冻结检出**的模块，并把它挂到 window.__W9111M。
 * 例：await pageModule(page, 'messages', '/src/ui/messages.ts')
 */
export async function pageModule(page, key, path) {
  await page.evalAsync("const m = await import('" + path + "'); (window.__W9111M ||= {})['" + key + "'] = m; return Object.keys(m).length;");
  return page;
}

/** 页面内取当前活跃 pane（viewctx.paneOf）。 */
export const PANE_EXPR = "window.__W9111M.viewctx.paneOf(document.querySelector('.sess-pane:not([hidden])').dataset.session)";

/** 发一个突发脚本。 */
export function burst(app, frames, opts = {}) {
  return control(app, '/__control/burst', { frames, ...opts });
}

/** 生成 N 个 thinking delta 帧。 */
export function thinkingFrames(text, { chunks = 1, startAt = 0, stepMs = 16, turn = 101 } = {}) {
  const size = Math.max(1, Math.ceil(text.length / chunks));
  const frames = [{ at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } }, turn }];
  let at = startAt;
  for (let i = 0; i < text.length; i += size) {
    at += stepMs;
    frames.push({ at, name: 'thinking', payload: { delta: text.slice(i, i + size) }, turn });
  }
  frames.push({ at: at + stepMs, name: 'done', payload: { text: '' }, turn });
  frames.push({ at: at + stepMs * 2, name: 'status', payload: { phase: 'completed' }, turn });
  return { frames, durationMs: at + stepMs * 2 };
}

/** 造一段确定性文本（重复 fill 到 len）。 */
export function makeText(len, seed = 'abcdefghij') {
  const unit = seed.repeat(Math.ceil(len / seed.length));
  return unit.slice(0, len);
}
