// W514 只读冒烟：对**真实后端**（默认 http://127.0.0.1:3777，静态根 = frontend/dist）
// 加载新构建，仅观测（不发任何 POST：不触发 turn / 不切活跃会话）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || '/tmp/w217-test/node_modules/playwright');
const BASE = process.env.LIVE_BASE || 'http://127.0.0.1:3777';

const errors = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text() + ' @ ' + ((m.location && m.location().url) || ''));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.sess-pane:not([hidden])', { timeout: 8000 });
await page.waitForFunction(() => (document.querySelector('#sessionBar .sess-bar-name')?.textContent ?? '—') !== '—', null, { timeout: 8000 });
await page.waitForTimeout(4000); // 让历史恢复 + statusline 轮询 + SSE 稳定

const info = await page.evaluate(() => {
  const pane = document.querySelector('.sess-pane:not([hidden])');
  return {
    panes: document.querySelectorAll('.sess-pane').length,
    paneId: pane?.dataset.session ?? null,
    mcols: pane?.querySelectorAll('.mcol').length ?? 0,
    textLen: (pane?.textContent ?? '').length,
    leaves: document.querySelectorAll('.sess-leaf').length,
    workerRows: document.querySelectorAll('.ws-worker-row').length,
    barName: document.querySelector('#sessionBar .sess-bar-name')?.textContent ?? '',
    barState: document.querySelector('#sessionBar .sess-bar-state')?.textContent ?? '',
    statusText: document.querySelector('#statusText')?.textContent ?? '',
    sendDisabled: document.querySelector('#btnSend')?.disabled ?? null,
    inputMode: document.querySelector('#inputbar')?.className ?? '',
    ctxText: document.querySelector('#slCtx')?.textContent ?? '',
    model: document.querySelector('#slModel')?.textContent ?? '',
  };
});
console.log(JSON.stringify(info, null, 2));
console.log('consoleErrors=', errors.length, errors.slice(0, 5));
const ok =
  info.panes >= 1 &&
  info.mcols > 0 &&
  info.leaves > 0 &&
  info.sendDisabled === false &&
  errors.length === 0;
console.log(ok ? 'LIVE_SMOKE_OK' : 'LIVE_SMOKE_FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
