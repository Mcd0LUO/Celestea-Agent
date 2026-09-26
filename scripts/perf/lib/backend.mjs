// ============================================================================
// scripts/perf/lib/backend.mjs — 侦测用的**确定性假后端**（零依赖）
// ----------------------------------------------------------------------------
// 为什么不用真实 Studio：上游网关 114.66.55.186:13001 会间歇超时/504，测量基准
// 不可复现。这里用**真 EventSource + 真 SSE 帧**（不是桩掉 EventSource），
// 因为用户点名的第一问就是「EventSource 突发期间是否掉帧」——桩掉就测不到了。
//
// 所有帧的时序由 /__control/burst 驱动：调用方 POST 一个脚本，服务端按脚本
// 定时 write SSE 帧。事件名/载荷形状与 contracts/sse-events.json 一致。
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

export const SESSION_ID = 'perf/W9111-main';

/**
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.webRoot       冻结检出的 apps/web
 * @param {string} o.viteOrigin
 * @param {Array}  [o.history]     历史消息夹具
 */
export async function startBackend(o) {
  const webRoot = o.webRoot;
  const viteOrigin = o.viteOrigin;
  const state = {
    history: o.history ?? [],
    sseClients: new Set(),
    hits: [],
    busy: false,
    seq: 0,
    turn: 100,
    script: null,
  };

  function sseWrite(frame) {
    for (const res of state.sseClients) {
      try { res.write(frame); } catch { /* client gone */ }
    }
  }
  function emit(name, payload, session = SESSION_ID, turn = state.turn) {
    state.seq += 1;
    const env = { v: 2, session, turn, seq: state.seq, payload };
    sseWrite('event: ' + name + '\ndata: ' + JSON.stringify(env) + '\n\n');
  }

  function json(res, code, obj, cors) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    state.hits.push({ method: req.method, path: p, at: Date.now() });

    // ---------------- 控制面 ----------------
    if (p === '/__control/state') {
      return json(res, 200, {
        hits: state.hits,
        sseClients: state.sseClients.size,
        busy: state.busy,
        seq: state.seq,
        turn: state.turn,
      }, cors);
    }
    if (p === '/__control/reset') {
      state.hits = []; state.seq = 0; state.turn = 100; state.busy = false;
      return json(res, 200, { ok: true }, cors);
    }
    if (p === '/__control/history' && req.method === 'POST') {
      const body = await readJson(req);
      state.history = Array.isArray(body.messages) ? body.messages : [];
      return json(res, 200, { ok: true, count: state.history.length }, cors);
    }
    // 突发脚本：{frames:[{at,name,payload}], turn} —— at 是相对启动的 ms
    if (p === '/__control/burst' && req.method === 'POST') {
      const body = await readJson(req);
      const frames = Array.isArray(body.frames) ? body.frames : [];
      if (typeof body.turn === 'number') state.turn = body.turn;
      if (body.busy !== undefined) state.busy = !!body.busy;
      const t0 = Date.now();
      let maxAt = 0;
      for (const f of frames) {
        maxAt = Math.max(maxAt, Number(f.at) || 0);
        setTimeout(() => {
          emit(f.name, f.payload ?? {}, f.session ?? SESSION_ID, f.turn ?? state.turn);
        }, Math.max(0, Number(f.at) || 0));
      }
      return json(res, 200, { ok: true, frames: frames.length, durationMs: maxAt }, cors);
    }
    if (p === '/__control/emit' && req.method === 'POST') {
      const body = await readJson(req);
      emit(body.name, body.payload ?? {}, body.session, body.turn);
      return json(res, 200, { ok: true }, cors);
    }

    // ---------------- 契约端点 ----------------
    if (p === '/api/events') {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      state.sseClients.add(res);
      req.on('close', () => state.sseClients.delete(res));
      return;
    }
    if (p === '/api/health') {
      return json(res, 200, { ok: true, name: 'perf-fixture', model: 'perf-model', base_url: 'http://127.0.0.1:' + o.port, bind: '127.0.0.1:' + o.port, capabilities: {} }, cors);
    }
    if (p === '/api/status') {
      return json(res, 200, {
        model: 'perf-model', reasoning_effort: null, steps: 0, tokens_per_sec: 12.5,
        context_usage: { used: 1234, window: 1000000, ratio: 0.0012, estimated: true },
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cache_read: 40, cache_hit_ratio: 0.4, reasoning_tokens: 0 },
        session: url.searchParams.get('session') ?? SESSION_ID,
        busy: state.busy,
      }, cors);
    }
    if (p === '/api/sessions') {
      return json(res, 200, {
        sessions: [{ id: SESSION_ID, title: 'perf/W9111', kind: 'session', busy: state.busy, active: true, events: 0, workspace: 'perf' }],
        active_session: SESSION_ID,
      }, cors);
    }
    if (p === '/api/workspaces') {
      return json(res, 200, { workspaces: [{ name: 'perf', path: '/perf', sessions: 1 }], active_session: SESSION_ID }, cors);
    }
    if (p === '/api/tools') return json(res, 200, { ok: true, tools: [] }, cors);
    if (p === '/api/config') return json(res, 200, { model: 'perf-model', reasoning_effort: null, available: { models: [{ id: 'perf-model', name: 'Perf', provider: 'fixture' }], efforts: ['low', 'high'] } }, cors);
    if (p === '/api/providers') return json(res, 200, { ok: true, providers: [] }, cors);
    if (p === '/api/prompts') return json(res, 200, { ok: true, prompts: [] }, cors);
    if (p === '/api/permissions/presets') return json(res, 200, { ok: true, presets: [] }, cors);
    if (p === '/api/questions') return json(res, 200, { ok: true, questions: [] }, cors);
    if (p === '/auth/check') return json(res, 200, { ok: true, username: 'perf' }, cors);
    if (p === '/api/plugins') return json(res, 200, { ok: true, plugins: [] }, cors);
    const mMsg = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
    if (mMsg) return json(res, 200, { ok: true, session: decodeURIComponent(mMsg[1]), messages: state.history }, cors);
    const mCtx = /^\/api\/sessions\/(.+)\/context$/.exec(p);
    if (mCtx) return json(res, 200, { ok: true, context: [] }, cors);
    const mAct = /^\/api\/sessions\/(.+)\/activate$/.exec(p);
    if (mAct) return json(res, 200, { ok: true, active_session: decodeURIComponent(mAct[1]) }, cors);
    if (p === '/api/usage/ledger') return json(res, 200, { ok: true, entries: [] }, cors);

    // ---------------- /src/** → Vite（TS 转换 + CORS） ----------------
    if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) {
      try {
        const upstream = await fetch(viteOrigin + p + url.search, { headers: { origin: 'http://127.0.0.1:' + o.port } });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'text/javascript; charset=utf-8' });
        return res.end(body);
      } catch (err) {
        res.writeHead(502, cors);
        return res.end('vite proxy failed: ' + String(err));
      }
    }

    // ---------------- 静态（冻结检出的 apps/web） ----------------
    const rel = p === '/' ? '/index.html' : p;
    const full = join(webRoot, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    if (existsSync(full) && statSync(full).isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    if (existsSync(join(webRoot, 'index.html'))) {
      res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
      return res.end(readFileSync(join(webRoot, 'index.html')));
    }
    res.writeHead(404, cors);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(o.port, '127.0.0.1', resolve));
  return {
    server,
    state,
    origin: 'http://127.0.0.1:' + o.port,
    emit,
    hits: () => state.hits,
    reset: () => { state.hits = []; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}
