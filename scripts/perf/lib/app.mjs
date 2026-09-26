// scripts/perf/lib/app.mjs — 装配：起确定性假后端 + Chrome，导航到冻结前端。
import { launchChrome } from './chrome.mjs';
import { startBackend, SESSION_ID } from './backend.mjs';

export const DEFAULT_REPO = process.env.W9111_REPO ?? 'C:/Users/lenovo/AppData/Local/Temp/perf-w9111/repo';
export const DEFAULT_VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
export { SESSION_ID };

/**
 * 起一个「被测应用」实例。
 * @param {object} o
 * @param {number} o.port        fixture 后端端口
 * @param {number} o.cdpPort     Chrome 调试端口
 * @param {Array}  [o.history]   历史消息夹具（GET /api/sessions/{id}/messages）
 * @param {string} [o.initScript] 每个新文档执行前的注入脚本
 */
export async function boot(o) {
  const webRoot = (o.repo ?? DEFAULT_REPO) + '/apps/web';
  const backend = await startBackend({
    port: o.port,
    webRoot,
    viteOrigin: o.vite ?? DEFAULT_VITE,
    history: o.history ?? [],
  });
  const chrome = await launchChrome({
    port: o.cdpPort,
    width: o.width ?? 1440,
    height: o.height ?? 900,
    extraArgs: o.extraArgs ?? [],
  });
  const { page } = chrome;
  const consoleErrors = [];
  const consoleAll = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleAll.push({ type: p.type, text });
    if (p.type === 'error') consoleErrors.push(text);
  });
  page.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''));
  });
  if (o.initScript) await page.addInitScript(o.initScript);
  return {
    ...chrome,
    backend,
    consoleErrors,
    consoleAll,
    origin: backend.origin,
    async boot() {
      await page.navigate(backend.origin + '/');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: o.width ?? 1440, height: o.height ?? 900, deviceScaleFactor: 1, mobile: false,
      });
      return page;
    },
    async close() {
      await chrome.close();
      await backend.close();
    },
  };
}

/** 等待某个页面内谓词为真（谓词体是函数体，返回真值即停）。 */
export async function waitFor(page, exprBody, { timeoutMs = 20000, label = 'condition', intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.eval('(function(){ ' + exprBody + ' })()');
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout (' + label + '); last=' + JSON.stringify(last));
}

/** 直接打后端的控制面。 */
export async function control(app, path, body) {
  const res = await fetch(app.origin + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
