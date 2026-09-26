// ============================================================================
// scripts/perf/lib/server.mjs — 侦测用静态服务器（零依赖）
// ----------------------------------------------------------------------------
// 职责：
//   · 静态服务 $TEMP 冻结检出里的 apps/web（index.html / src / styles）
//   · 转发 /src/** 到 Vite dev server（拿到 TS→JS 转换 + CORS）
//   · 提供 /fixtures/*.json 确定性夹具（不依赖真实上游）
// 绝不写入任何被测目录。
// ============================================================================
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.root          冻结检出的 apps/web 目录
 * @param {string} o.viteOrigin    例如 http://127.0.0.1:3787
 * @param {Record<string,unknown>} [o.fixtures]  /fixtures/<key> → JSON
 */
export function startServer(o) {
  const root = o.root;
  const viteOrigin = o.viteOrigin ?? 'http://127.0.0.1:3787';
  const fixtures = o.fixtures ?? {};
  const log = [];
  const control = { hits: [], state: {} };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    control.hits.push({ path: p, method: req.method, at: Date.now() });
    log.push(p);

    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // ---- 夹具 ----
    if (p === '/__control/hits') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify(control.hits));
    }
    if (p === '/__control/reset') {
      control.hits = [];
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (p.startsWith('/fixtures/')) {
      const key = p.slice('/fixtures/'.length);
      const value = fixtures[key];
      res.writeHead(value === undefined ? 404 : 200, { ...cors, 'content-type': 'application/json' });
      return res.end(value === undefined ? '{"error":"no fixture"}' : JSON.stringify(value));
    }

    // ---- /src/** → Vite（TS 转换 + CORS） ----
    if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) {
      try {
        const upstream = await fetch(viteOrigin + p + url.search, {
          headers: { origin: 'http://127.0.0.1:' + o.port },
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          ...cors,
          'content-type': upstream.headers.get('content-type') ?? 'text/javascript; charset=utf-8',
        });
        return res.end(body);
      } catch (err) {
        res.writeHead(502, cors);
        return res.end('vite proxy failed: ' + String(err));
      }
    }

    // ---- 静态 ----
    let rel = p === '/' ? '/index.html' : p;
    const full = join(root, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    if (existsSync(full) && statSync(full).isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    if (existsSync(join(root, 'index.html'))) {
      res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
      return res.end(readFileSync(join(root, 'index.html')));
    }
    res.writeHead(404, cors);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(o.port, '127.0.0.1', () => {
      resolve({
        server,
        origin: 'http://127.0.0.1:' + o.port,
        hits: () => control.hits,
        reset: () => { control.hits = []; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
