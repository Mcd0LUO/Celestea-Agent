// ============================================================================
// scripts/perf/lib/chrome.mjs — 启动 headless Chrome + attach 一个 page
// ----------------------------------------------------------------------------
// profile 一律写到 $TEMP（results/ 会被 ESLint 扫，且绝不能把浏览器 profile 提交）。
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, CdpPage, openCdp } from './cdp.mjs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** 启动 Chrome，返回 { browser, page, close, port, profileDir }。 */
export async function launchChrome(opts = {}) {
  const exe = opts.executablePath ?? findChrome();
  if (!exe) throw new Error('chrome not found');
  const profileDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'w9111-chrome-'));
  const port = opts.port ?? 9333;
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=' + (opts.width ?? 1440) + ',' + (opts.height ?? 900),
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    ...(opts.extraArgs ?? []),
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });

  const versionUrl = 'http://127.0.0.1:' + port + '/json/version';
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 25000);
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(versionUrl);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) {
    child.kill();
    throw new Error('chrome devtools endpoint never came up.\n' + stderr.slice(-2000));
  }

  const browser = await openCdp(version.webSocketDebuggerUrl);
  // flat 模式：所有 session 消息走同一条 ws。
  const { targetInfos } = await browser.send('Target.getTargets');
  let info = targetInfos.find((t) => t.type === 'page');
  if (!info) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    info = { targetId };
  }
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
  const page = new CdpPage(browser, sessionId);

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Performance.enable');

  const close = async () => {
    try { browser.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    if (!opts.keepProfile) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  return { browser, page, close, port, profileDir, chromePath: exe, version };
}

export { Cdp, CdpPage, openCdp };
