// ============================================================================
// W514 本地 mock 后端（自测用，不属于产品代码）：
//   实现「冻结契约」v2（/api/sessions 带 kind/busy，SSE 信封 {v:2,session,...}，
//   /api/turn 运行中=插话，activate 运行中不再 409，/api/status?session=）
//   以及 --legacy 模式（旧后端：无 session/kind/busy，busy→409）用于降级自测。
//   同时静态服务 frontend/dist（与真实后端同一份产物）。
//   用法：node bench/mock-studio-server.mjs [--port 8791] [--legacy] [--turn-ms 3000]
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PORT = Number(val('--port', '8791'));
const LEGACY = has('--legacy');
const TURN_MS = Number(val('--turn-ms', '3000'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const ID_A = 'CelesteaTeamAPI/sess-A';
const ID_B = 'CelesteaTeamAPI/sess-B';
const ID_W = 'server-center/W514·前端多会话';

const ID_W2 = 'server-center/W520·无父worker';

const sessions = [
  { id: ID_A, title: 'A · 会话一', kind: 'session', workspace: 'CelesteaTeamAPI', model: 'deepseek-flash', events: 12, active: true },
  { id: ID_B, title: 'B · 会话二', kind: 'session', workspace: 'CelesteaTeamAPI', model: 'deepseek-flash', events: 5 },
  // W515 谱系：parentSessionId（DSH 语义）→ 父会话 A 的子 worker
  { id: ID_W, title: 'W514·前端多会话', kind: 'worker', workspace: 'server-center', model: 'deepseek-v4-flash', events: 7, parentSessionId: ID_A },
  // 无 parent 字段 → 归入「未关联父会话」（降级/对照）
  { id: ID_W2, title: 'W520·无父worker', kind: 'worker', workspace: 'server-center', model: 'deepseek-v4-flash', events: 2 },
];

const history = {
  [ID_A]: [
    { role: 'user', content: 'A 的历史提问' },
    { role: 'assistant', content: 'A 的历史回复（存量消息 · 用于验证切回后仍在）' },
    { role: 'user', kind: 'steering', content: '（历史）插话：补充一个约束' },
    { role: 'inbox', kind: 'inbox', source: 'W513', content: '（历史）runtime 回执：W513 已提交' },
    { role: 'user', content: 'A 的第二问' },
    { role: 'assistant', content: 'A 的第二答' },
  ],
  [ID_B]: [{ role: 'user', content: 'B 的历史提问' }, { role: 'assistant', content: 'B 的历史回复' }],
  [ID_W]: [{ role: 'user', content: 'worker 简报' }, { role: 'assistant', content: 'worker 已完成 X' }],
  [ID_W2]: [{ role: 'user', content: 'worker2 简报' }, { role: 'assistant', content: 'worker2 已完成 Y' }],
};

const state = {
  legacy: LEGACY,
  turnReqs: [],
  gen: 0,
  busy: new Set(),
  active: ID_A,
  turn: 100,
  seq: 0,
  requests: [],
  sseClients: new Set(),
  notes: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function note(kind, session, text) {
  state.notes.push({ kind, session, text, at: Date.now() });
}

function emit(kind, payload, session, turn) {
  state.seq += 1;
  const body = LEGACY ? { turn, seq: state.seq, payload } : { v: 2, session, turn, seq: state.seq, payload };
  const frame = `event: ${kind}\ndata: ${JSON.stringify(body)}\n\n`;
  for (const res of state.sseClients) res.write(frame);
}

function snapshot(session) {
  return {
    model: sessions.find((s) => s.id === session)?.model ?? 'deepseek-flash',
    reasoning_effort: null,
    steps: 0,
    tokens_per_sec: 12.5,
    context_usage: { used: 1234, window: 1000000, ratio: 0.0012, estimated: true },
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cache_read: 40, cache_hit_ratio: 0.4, reasoning_tokens: 0 },
    session,
    busy: state.busy.has(session),
  };
}

function chunks(text, n) {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * 一轮 = status:start → text 增量 → tool → tool_result → done → status:completed。
 * gen：/control/reset 递增 → 上一轮测试遗留的 turn 立即作废（测试隔离用）。
 */
async function runTurn(session, text) {
  const gen = state.gen;
  const alive = () => state.gen === gen;
  const turn = ++state.turn;
  state.busy.add(session);
  emit('status', { phase: 'start', statusline: { model: snapshot(session).model, steps: 0 } }, session, turn);
  const full = `【${session}】收到「${text}」→ 这是一段较长的流式回复，用于验证后台会话继续接收增量。`;
  const parts = chunks(full, 12);
  const step = Math.max(60, Math.floor(TURN_MS / parts.length));
  for (const p of parts) {
    await sleep(step);
    if (!alive()) return;
    emit('text', { delta: p }, session, turn);
  }
  emit('tool', { id: 'tool-' + turn, name: 'read_file', args: { path: session + '.md' } }, session, turn);
  await sleep(step);
  if (!alive()) return;
  emit('tool_result', { id: 'tool-' + turn, ok: true, value: '文件读取成功' }, session, turn);
  await sleep(step);
  if (!alive()) return;
  // W515：worker 回执 / 系统注入（inbox 车道 next-turn）
  emit('inbox', { text: 'Worker 回执：子任务已完成（W515 演示）', source: 'W520', target: 'next-turn' }, session, turn);
  emit('done', { text: full }, session, turn);
  await sleep(step);
  if (!alive()) return;
  emit('status', { phase: 'completed', statusline: { model: snapshot(session).model, steps: 1 } }, session, turn);
  state.busy.delete(session);
  note('turn-completed', session, text);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  state.requests.push({ method: req.method, path: p, query: url.search, at: Date.now() });

  if (p === '/control/state') {
    return json(res, 200, {
      legacy: state.legacy,
      busy: [...state.busy],
      active: state.active,
      requests: state.requests,
      turnReqs: state.turnReqs,
      notes: state.notes,
    });
  }
  if (p === '/control/reset') {
    state.requests = [];
    state.notes = [];
    state.turnReqs = [];
    state.gen += 1; // 作废上一轮遗留的 turn 循环
    state.busy.clear();
    state.active = ID_A; // 测试隔离：活跃会话复位
    return json(res, 200, { ok: true });
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    state.sseClients.add(res);
    req.on('close', () => state.sseClients.delete(res));
    return;
  }
  if (p === '/api/health') {
    return json(res, 200, { ok: true, name: 'celestea-studio-mock', model: 'deepseek-flash', base_url: 'http://127.0.0.1:' + PORT, bind: '127.0.0.1:' + PORT });
  }
  if (p === '/api/tools') return json(res, 200, { ok: true, tools: [{ name: 'read_file', description: '读文件' }] });
  if (p === '/api/config') {
    return json(res, 200, {
      model: 'deepseek-flash',
      reasoning_effort: null,
      available: { models: [{ id: 'deepseek-flash', name: 'Flash', provider: 'mock' }], efforts: ['low', 'high'] },
    });
  }
  if (p === '/api/workspaces') {
    return json(res, 200, { workspaces: [{ name: 'CelesteaTeamAPI', path: '/src/CelesteaTeamAPI', sessions: 2 }, { name: 'server-center', path: '/server-center', sessions: 1 }], active_session: state.active });
  }
  if (p === '/api/sessions') {
    const list = sessions.map((s) => {
      const out = { ...s, active: s.id === state.active };
      if (!LEGACY) out.busy = state.busy.has(s.id);
      else {
        delete out.kind;
        delete out.parentSessionId; // 旧后端无谱系字段 → 前端平坦降级
      }
      return out;
    });
    return json(res, 200, { sessions: list, active_session: state.active });
  }
  if (p === '/api/status') {
    const asked = url.searchParams.get('session');
    return json(res, 200, snapshot(asked && sessions.some((s) => s.id === asked) ? asked : state.active));
  }
  if (p === '/api/turn' && req.method === 'POST') {
    const body = await readBody(req);
    const target = typeof body.session === 'string' && body.session ? body.session : state.active;
    const input = String(body.input ?? '');
    state.turnReqs.push({
      target,
      input,
      sessionField: body.session ?? null,
      mode: body.mode ?? null,
      at: Date.now(),
    });
    if (LEGACY) {
      if (state.busy.size > 0) return json(res, 409, { ok: false, error: 'a turn is already running' });
      void runTurn(target, input);
      return json(res, 202, { turn: state.turn + 1, status: 'started' });
    }
    if (state.busy.has(target)) {
      // W515：mode='queue' = 下一回合投递（DSH inbox next-turn）；默认 steer = 下一步注入
      if (body.mode === 'queue') {
        note('queued', target, input);
        return json(res, 202, {
          ok: true,
          queued: true,
          session: target,
          inbox_target: 'next-turn',
          turn: state.turn,
        });
      }
      note('interject', target, input);
      emit('context', { text: '已插话：' + input, cls: 'info' }, target, state.turn);
      return json(res, 202, {
        ok: true,
        injected: true,
        session: target,
        inbox_target: 'next-step',
        turn: state.turn,
      });
    }
    void runTurn(target, input);
    return json(res, 202, { ok: true, injected: false, session: target, turn: state.turn + 1 });
  }
  if (p === '/api/cancel' && req.method === 'POST') {
    const body = await readBody(req);
    const target = typeof body.session === 'string' && body.session ? body.session : state.active;
    state.busy.delete(target);
    note('cancel', target, '');
    emit('status', { phase: 'cancelled' }, target, state.turn);
    return json(res, 200, { ok: true, cancelled: true });
  }
  const mAct = /^\/api\/sessions\/(.+)\/activate$/.exec(p);
  if (mAct) {
    const id = decodeURIComponent(mAct[1]);
    if (LEGACY && state.busy.size > 0) return json(res, 409, { ok: false, error: 'turn running' });
    state.active = id;
    return json(res, 200, { ok: true, active_session: id });
  }
  const mMsg = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
  if (mMsg) {
    const id = decodeURIComponent(mMsg[1]);
    return json(res, 200, { ok: true, session: id, messages: history[id] ?? [] });
  }
  const mCompact = /^\/api\/sessions\/(.+)\/compact$/.exec(p);
  if (mCompact) return json(res, 200, { ok: true, compacted: false, note: '历史不足，无需压缩' });
  if (p.startsWith('/api/fs/browse')) return json(res, 200, { path: '/', dirs: [] });
  if (p.startsWith('/api/providers') || p.startsWith('/api/prompts')) return json(res, 404, { error: 'not implemented in mock' });

  // ---- 静态（dist） ----
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(DIST, path.normalize(file).replace(/^([.][.][/\\])+/, ''));
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(full));
  }
  res.writeHead(200, { 'content-type': MIME['.html'] });
  res.end(fs.readFileSync(path.join(DIST, 'index.html')));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] http://127.0.0.1:${PORT} legacy=${LEGACY} turnMs=${TURN_MS} dist=${DIST}`);
});
