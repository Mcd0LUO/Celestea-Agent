// scripts/perf/smoke.mjs — 冒烟：冻结前端 + 确定性假后端 + SSE 真连通。
import { boot, waitFor, control, SESSION_ID } from './lib/app.mjs';

const app = await boot({ port: 3788, cdpPort: 9333 });
try {
  await app.boot();
  await waitFor(app.page, 'return document.querySelector(".sess-pane:not([hidden])") !== null;', { label: 'pane' });
  await control(app, '/__control/burst', { turn: 101, frames: [
    { at: 0, name: 'status', payload: { phase: 'start', statusline: { model: 'perf-model', steps: 0 } } },
    { at: 30, name: 'thinking', payload: { delta: '推理一段。' } },
    { at: 60, name: 'text', payload: { delta: '# 标题\n正文一段。' } },
    { at: 90, name: 'tool', payload: { id: 't1', name: 'read_file', args: { path: 'a.md' } } },
    { at: 120, name: 'tool_result', payload: { id: 't1', ok: true, value: 'ok' } },
    { at: 150, name: 'done', payload: { text: '# 标题\n正文一段。' } },
    { at: 180, name: 'status', payload: { phase: 'completed' } },
  ] });
  await new Promise((r) => setTimeout(r, 900));
  const info = await app.page.eval([
    '(function(){',
    '  const pane = document.querySelector(".sess-pane:not([hidden])");',
    '  return {',
    '    paneId: pane?.dataset.session ?? null,',
    '    mcols: pane?.querySelectorAll(".mcol").length ?? 0,',
    '    think: pane?.querySelectorAll(".think-seg").length ?? 0,',
    '    tools: pane?.querySelectorAll(".mcol.msg.tool").length ?? 0,',
    '    textLen: (pane?.textContent ?? "").length,',
    '  };',
    '})()',
  ].join('\n'));
  console.log(JSON.stringify(info, null, 2));
  console.log('sseClients', app.backend.state.sseClients.size);
  console.log('consoleErrors', JSON.stringify(app.consoleErrors.slice(0, 10), null, 1));
} finally {
  await app.close();
}
