// ============================================================================
// scripts/perf/lib/cdp.mjs — 极简 Chrome DevTools Protocol 客户端（零依赖）
// ----------------------------------------------------------------------------
// 为什么自己写：本仓的 node_modules 里没有 playwright / puppeteer，装它们要动
// 共享工作树（pnpm install 会重写 .pnpm 目录）—— 测量任务明令不许。
// Node 22+ 有全局 WebSocket，够用了。
//
// 用法：
//   const { browser, page } = await launchChrome({ port: 9333 });
//   await page.send('Page.navigate', { url });
//   const r = await page.eval('1+1');
// ============================================================================

/** 连接一个 CDP websocket，返回带 send/on 的对象。 */
export async function openCdp(wsUrl, { timeoutMs = 15000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp connect timeout: ' + wsUrl)), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp ws error: ' + wsUrl)); }, { once: true });
  });
  return new Cdp(ws);
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map(); // method -> Set<fn>
    this.closed = false;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('cdp closed'));
      this.pending.clear();
    });
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error('cdp ' + msg.error.code + ': ' + msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) for (const fn of set) { try { fn(msg.params ?? {}, msg.sessionId ?? null); } catch { /* listener */ } }
    }
  }

  /** 发一条 CDP 命令；sessionId 缺省 = 浏览器级。 */
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.seq;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(frame)); }
      catch (err) { this.pending.delete(id); reject(err); }
    });
  }

  on(method, fn) {
    let set = this.handlers.get(method);
    if (!set) { set = new Set(); this.handlers.set(method, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  once(method, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('cdp wait timeout: ' + method)); }, timeoutMs);
      const off = this.on(method, (params, sid) => { clearTimeout(timer); off(); resolve({ params, sessionId: sid }); });
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 一个已 attach 的 page 会话（flat 模式：sessionId 随消息下发）。 */
export class CdpPage {
  constructor(root, sessionId) { this.root = root; this.sessionId = sessionId; }

  send(method, params = {}) { return this.root.send(method, params, this.sessionId); }

  on(method, fn) {
    return this.root.on(method, (params, sid) => { if (sid === this.sessionId) fn(params); });
  }

  /** Runtime.evaluate；默认 returnByValue + awaitPromise。 */
  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval threw: ' + (d.exception?.description ?? d.text ?? JSON.stringify(d)));
    }
    return r.result?.value;
  }

  /** 解析一段返回 Promise 的表达式。 */
  evalAsync(expression) { return this.eval('(async () => { ' + expression + ' })()'); }

  async navigate(url, { timeoutMs = 30000, waitUntil = 'load' } = {}) {
    const loaded = this.root.once('Page.loadEventFired', { timeoutMs });
    await this.send('Page.navigate', { url });
    if (waitUntil === 'load') await loaded;
    return true;
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  /** 在**每个新文档**执行前注入脚本（探针 / 夹具路由）。 */
  addInitScript(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }
}
