// ============================================================================
// Celestea Studio — v2 前端逻辑（淡雅黑主题 · 完整功能 UI）
// 协议（与后端统一）：
//   SSE  GET /api/events  event:status|text|thinking|tool|tool_result|done
//        data 为 {"turn":N,"seq":M,"payload":{...}}
//   HTTP POST /api/turn {input}  ·  POST /api/cancel  ·  GET /api/health
//        GET  /api/tools  ·  GET /api/config  ·  GET /api/sessions
//        POST /api/clear  ·  POST /api/worker/spawn  ·  POST /api/worker/send
//        GET  /api/worker/status?wid=
// ============================================================================

'use strict';

// ---- 基础工具 --------------------------------------------------------------

function $(sel) { return document.querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var m = Math.floor(sec / 60), s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function fmtNow() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

// ---- API -------------------------------------------------------------------

async function api(path, opts) {
  var res = await fetch(path, opts || {});
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    var msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
    var err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

// ---- 全局状态 ---------------------------------------------------------------

var S = {
  turn: null,          // 当前 turn id
  streaming: false,
  t0: 0,
  conn: 'connecting',  // connecting | online | down
  assistant: null,     // 当前助手消息视图 {root,bubble,think,thinkBody,cards,content,text,thinkText,ops,steps}
  sessions: [],
  selSession: null,
  timer: null,
  statusTimer: null,
  statusAuto: null
};

var Msgs = $('#messages');
var StatusText = $('#statusText');
var StatusDot = $('#statusDot');
var StatusTurn = $('#statusTurn');
var StatusStep = $('#statusStep');
var StatusTime = $('#statusTime');
var InputEl = $('#input');
var BtnSend = $('#btnSend');
var BtnCancel = $('#btnCancel');

// ---- 状态栏 ---------------------------------------------------------------

function setStatus(text, cls) {
  StatusText.textContent = text;
  StatusDot.className = 'dot' + (cls ? ' ' + cls : '');
}

function setStatusTurn(n) {
  StatusTurn.textContent = (typeof n === 'number' && n >= 1) ? 'turn ' + n : 'turn —';
}

function setStatusStep(n) {
  StatusStep.textContent = 'step ' + (n || '—');
}

function tickTimer() {
  if (!S.streaming) return;
  StatusTime.textContent = fmtTime((Date.now() - S.t0) / 1000);
}

function startTimer() {
  S.t0 = Date.now();
  if (S.statusTimer) clearInterval(S.statusTimer);
  S.statusTimer = setInterval(tickTimer, 500);
  tickTimer();
}

function stopTimer() {
  if (S.statusTimer) { clearInterval(S.statusTimer); S.statusTimer = null; }
}

// ---- 消息渲染（markdown + 代码高亮） ---------------------------------------

if (window.marked) {
  try { marked.setOptions({ breaks: true, gfm: true }); } catch (e) { /* keep defaults */ }
}

// ---- W739：不可信 HTML 白名单消毒（与 src/utils/sanitize.ts 同一策略） -------
// 本文件是 Vite 之前的旧版 UI（现行入口是 src/main.ts → dist/），保留作回滚参考；
// 但它的 markdown 出口同样会把模型输出写进 innerHTML，故一并消毒，策略与
// src/utils/sanitize.ts 对齐：标签白名单 + 属性白名单 + URL scheme 白名单。
var ALLOWED_TAGS = {
  p: 1, div: 1, span: 1, br: 1, hr: 1, blockquote: 1, pre: 1,
  h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
  ul: 1, ol: 1, li: 1, dl: 1, dt: 1, dd: 1,
  table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, th: 1, td: 1, caption: 1, colgroup: 1, col: 1,
  details: 1, summary: 1, figure: 1, figcaption: 1,
  a: 1, img: 1, strong: 1, b: 1, em: 1, i: 1, u: 1, s: 1, del: 1, ins: 1, mark: 1,
  small: 1, sub: 1, sup: 1, kbd: 1, samp: 1, var: 1, abbr: 1, cite: 1, q: 1, dfn: 1,
  code: 1, time: 1, bdi: 1, bdo: 1, wbr: 1, ruby: 1, rt: 1, rp: 1, input: 1
};
var DROP_TAGS = {
  script: 1, style: 1, noscript: 1, template: 1, iframe: 1, frame: 1, frameset: 1, noframes: 1,
  object: 1, embed: 1, applet: 1, param: 1, link: 1, meta: 1, base: 1, basefont: 1,
  svg: 1, math: 1, canvas: 1, audio: 1, video: 1, source: 1, track: 1, picture: 1,
  plaintext: 1, xmp: 1, listing: 1, marquee: 1, portal: 1, slot: 1, dialog: 1,
  form: 1, fieldset: 1, legend: 1, select: 1, option: 1, optgroup: 1, textarea: 1, button: 1,
  title: 1, head: 1, html: 1, body: 1
};
var TAG_ATTRS = {
  a: { href: 1 }, img: { src: 1, alt: 1, width: 1, height: 1 },
  ol: { start: 1, reversed: 1, type: 1 }, li: { value: 1 },
  td: { colspan: 1, rowspan: 1, align: 1, scope: 1 }, th: { colspan: 1, rowspan: 1, align: 1, scope: 1 },
  col: { span: 1, width: 1 }, colgroup: { span: 1 }, time: { datetime: 1 },
  details: { open: 1 }, input: { type: 1, checked: 1, disabled: 1 }
};
var SAFE_SCHEMES = { http: 1, https: 1, mailto: 1, tel: 1 };

function safeUrl(raw) {
  var squeezed = String(raw).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (squeezed === '') return null;
  var m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(squeezed);
  if (m && !SAFE_SCHEMES[m[1].toLowerCase()]) return null;
  return raw;
}

/** 惰性文档白名单清洗：危险容器连同内容丢弃，其余未知元素解包保留文字。 */
function sanitizeTree(root) {
  var kids = Array.prototype.slice.call(root.childNodes);
  for (var i = 0; i < kids.length; i += 1) {
    var node = kids[i];
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { root.removeChild(node); continue; }
    var tag = node.tagName.toLowerCase();
    if (!ALLOWED_TAGS[tag]) {
      if (DROP_TAGS[tag]) { root.removeChild(node); continue; }
      sanitizeTree(node);
      while (node.firstChild) root.insertBefore(node.firstChild, node);
      root.removeChild(node);
      continue;
    }
    var attrs = Array.prototype.slice.call(node.attributes);
    for (var j = 0; j < attrs.length; j += 1) {
      var name = attrs[j].name.toLowerCase();
      var extra = TAG_ATTRS[tag];
      var listed = name === 'class' || name === 'id' || name === 'title' || name === 'dir' || name === 'lang' ||
        (extra ? !!extra[name] : false);
      if (!listed || name.indexOf('on') === 0) { node.removeAttribute(attrs[j].name); continue; }
      var v = attrs[j].value;
      if (name === 'class') {
        var kept = v.split(/[\s\u0000-\u001f]+/).filter(function (t) { return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(t); }).slice(0, 32);
        if (kept.length) node.setAttribute('class', kept.join(' ')); else node.removeAttribute(attrs[j].name);
      } else if (name === 'id') {
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,63}$/u.test(v)) node.removeAttribute(attrs[j].name);
      } else if (name === 'href' || name === 'src') {
        var u = safeUrl(v);
        if (u === null) node.removeAttribute(attrs[j].name); else node.setAttribute(name, u);
      } else if (name === 'width' || name === 'height') {
        if (!/^\d{1,4}$/.test(v)) node.removeAttribute(attrs[j].name);
      } else if (name === 'colspan' || name === 'rowspan' || name === 'span' || name === 'start' || name === 'value') {
        if (!/^-?\d{1,6}$/.test(v)) node.removeAttribute(attrs[j].name);
      } else if (name === 'align') {
        if (['left', 'center', 'right', 'justify'].indexOf(v.toLowerCase()) === -1) node.removeAttribute(attrs[j].name);
      } else if (name === 'dir') {
        if (['ltr', 'rtl', 'auto'].indexOf(v.toLowerCase()) === -1) node.removeAttribute(attrs[j].name);
      } else if (name === 'type') {
        var okType = tag === 'ol' ? ['1', 'a', 'A', 'i', 'I'].indexOf(v) !== -1
          : (tag === 'input' && v.toLowerCase() === 'checkbox');
        if (!okType) node.removeAttribute(attrs[j].name);
      }
    }
    if (tag === 'input') {
      if (String(node.getAttribute('type') || '').toLowerCase() !== 'checkbox') { root.removeChild(node); continue; }
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
    sanitizeTree(node);
  }
}

function sanitizeHtml(html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = html; // 惰性文档：脚本不执行、资源不加载
  sanitizeTree(tpl.content);
  return tpl.innerHTML;
}

function md(text) {
  if (window.marked) {
    try { return sanitizeHtml(marked.parse(text)); } catch (e) { /* fall through */ }
  }
  return '<pre>' + esc(text) + '</pre>';
}

function highlightIn(container) {
  if (!window.hljs || !container) return;
  $$('pre code', container).forEach(function (c) {
    if (c.dataset.hlDone === '1') return;
    try {
      if (c.className.indexOf('language-') === -1) c.className += ' language-plaintext';
      hljs.highlightElement(c);
      c.dataset.hlDone = '1';
    } catch (e) { /* unknown language → plain */ }
  });
}

function hideEmptyHint() {
  var h = $('#emptyHint');
  if (h) h.classList.add('hidden');
}

function autoscroll(force) {
  var nearBottom = Msgs.scrollTop + Msgs.clientHeight >= Msgs.scrollHeight - 160;
  if (force || nearBottom) Msgs.scrollTop = Msgs.scrollHeight;
}

// ---- 消息构建 --------------------------------------------------------------

function addUserMsg(text) {
  hideEmptyHint();
  var col = el('div', 'mcol');
  var msg = el('div', 'msg user');
  var cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '你'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  var b = el('div', 'bubble');
  var body = el('div', 'content');
  body.textContent = text;
  body.style.whiteSpace = 'pre-wrap';
  b.appendChild(body);
  msg.appendChild(b);
  col.appendChild(msg);
  Msgs.appendChild(col);
  autoscroll(true);
}

function ensureAssistant() {
  if (S.assistant) return S.assistant;
  hideEmptyHint();
  var col = el('div', 'mcol');
  var msg = el('div', 'msg assistant');
  var cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', 'Studio'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  var b = el('div', 'bubble streaming');

  var think = document.createElement('details');
  think.className = 'thinking';
  think.innerHTML =
    '<summary><span class="think-dot"></span><span>思考过程</span></summary><div class="thinking-body"></div>';
  var thinkBody = think.querySelector('.thinking-body');
  b.appendChild(think);

  var cards = el('div', 'toolcards');
  b.appendChild(cards);
  var content = el('div', 'content');
  b.appendChild(content);
  msg.appendChild(b);
  col.appendChild(msg);
  Msgs.appendChild(col);

  S.assistant = {
    root: msg, bubble: b, think: think, thinkBody: thinkBody,
    cards: cards, content: content,
    text: '', thinkText: '', ops: {}, steps: 0
  };
  autoscroll(true);
  return S.assistant;
}

function setAssistantStep(a, n) {
  a.steps = n;
  setStatusStep(n > 0 ? String(n) : '—');
}

function finalizeTurn(phase) {
  var was = S.streaming;
  S.streaming = false;
  S.turn = null;
  BtnSend.disabled = false;
  BtnCancel.classList.add('hidden');
  stopTimer();
  var labels = { completed: '完成', cancelled: '已取消', error: '出错' };
  var cls = phase === 'error' ? 'err' : (phase === 'cancelled' ? 'err' : 'ok');
  setStatus(labels[phase] || phase, cls);
  if (S.assistant) {
    S.assistant.bubble.classList.remove('streaming');
    S.assistant.bubble.classList.add('complete');
    renderAssistantText(S.assistant); // drop caret
  }
  S.assistant = null;
  if (was) autoscroll(true);
}

// ---- SSE 事件处理 -----------------------------------------------------------

function parseSSE(e) {
  var d = JSON.parse(e.data);
  return (d && d.payload !== undefined) ? d.payload : d;
}

function onStatus(p) {
  if (p.phase === 'start') {
    // 新 turn：结束上一个未完成的会话视图
    if (S.streaming && S.assistant) finalizeTurn('completed');
    S.turn = p.turn;
    S.streaming = true;
    BtnSend.disabled = true;
    BtnCancel.classList.remove('hidden');
    setStatus('运行中…', 'busy');
    setStatusTurn(p.turn);
    setStatusStep('');
    startTimer();
    ensureAssistant();
    return;
  }
  if (p.turn !== undefined && p.turn !== null && S.turn !== null && p.turn !== S.turn) return;
  if (p.phase === 'completed' || p.phase === 'cancelled' || p.phase === 'error') {
    var a = S.assistant;
    finalizeTurn(p.phase);
    if (p.phase === 'error' && a && p.error) {
      var e = el('div', 'err-inline', String(p.error));
      a.bubble.appendChild(e);
    }
  }
  // 'lagged'：慢客户端，静默容忍
}

function onText(p) {
  if (S.turn === null) S.turn = p.turn;
  if (p.turn !== undefined && p.turn !== S.turn) return;
  if (S.streaming === false) { S.streaming = true; BtnSend.disabled = true; BtnCancel.classList.remove('hidden'); }
  var a = ensureAssistant();
  a.text += p.delta || '';
  renderAssistantText(a);
  autoscroll();
}

function renderAssistantText(a) {
  a.content.innerHTML = md(a.text);
  highlightIn(a.content);
}

function onThinking(p) {
  if (S.turn === null) S.turn = p.turn;
  if (p.turn !== undefined && p.turn !== S.turn) return;
  var a = ensureAssistant();
  a.thinkText += p.delta || '';
  if (!a.think.classList.contains('summarizing')) a.think.classList.add('summarizing');
  if (!a.think.open) a.think.open = true; // 思考开始时展开一次，之后用户可收起
  a.thinkBody.textContent = a.thinkText;
  autoscroll();
}

function onTool(p) {
  if (S.turn === null) S.turn = p.turn;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  var a = ensureAssistant();
  var idx = ++a.steps;

  var card = document.createElement('div');
  card.className = 'toolcard running';
  card.dataset.toolId = String(p.id);

  var head = document.createElement('div');
  head.className = 'toolcard-head';
  head.appendChild(el('span', 'step-tag', 'step ' + idx));
  head.appendChild(el('span', 'toolcard-name', String(p.name || 'tool')));
  var state = document.createElement('span');
  state.className = 'toolcard-state';
  state.innerHTML = '<span class="ts-dot"></span><span class="ts-label">运行中</span>';
  head.appendChild(state);
  card.appendChild(head);

  var argsDetails = document.createElement('details');
  argsDetails.className = 'tool-details';
  var argsSummary = el('summary', null, '参数');
  argsSummary.style.listStyle = 'none';
  argsDetails.appendChild(argsSummary);
  var argsBody = el('div', 'tool-args');
  var argsJson = p.args;
  if (typeof argsJson !== 'string') {
    try { argsJson = JSON.stringify(p.args, null, 2); } catch (e) { argsJson = String(p.args); }
  }
  argsBody.textContent = argsJson;
  argsDetails.appendChild(argsBody);
  card.appendChild(argsDetails);

  a.cards.appendChild(card);
  a.ops[String(p.id)] = { card: card, state: state, label: state.querySelector('.ts-label') };
  setAssistantStep(a, a.steps);
  autoscroll();
}

function onToolResult(p) {
  if (S.turn === null) S.turn = p.turn;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  if (!S.assistant) return;
  var op = S.assistant.ops[String(p.id)];
  if (!op) return;

  var kind = 'ok';
  var label = '完成';
  if (p.ok === false || p.error) { kind = 'err'; label = '失败'; }
  if (p.decision === 'deny') { kind = 'deny'; label = '拒绝'; }
  else if (p.decision === 'ask') { label = '待确认'; }

  op.card.classList.remove('running');
  op.card.classList.add(kind === 'ok' ? 'ok' : (kind === 'deny' ? 'deny' : 'err'));
  op.label.textContent = label;

  var resDetails = document.createElement('details');
  resDetails.className = 'tool-details';
  var bodyText = '';
  if (p.error) bodyText = String(p.error);
  else if (p.render !== undefined && p.render !== null) bodyText = String(p.render);
  else if (p.value !== undefined && p.value !== null) {
    try { bodyText = JSON.stringify(p.value, null, 2); } catch (e) { bodyText = String(p.value); }
  }
  var preview = bodyText.length > 64 ? bodyText.slice(0, 64) + '…' : (bodyText || '（空）');
  var summary = el('summary', null, p.ok === false || p.error ? '错误 · ' + preview : '结果 · ' + preview);
  resDetails.appendChild(summary);
  var out = el('div', 'tool-out' + (p.ok === false || p.error ? ' err-c' : ''));
  out.textContent = bodyText || '（空）';
  resDetails.appendChild(out);
  op.card.appendChild(resDetails);
  setAssistantStep(S.assistant, S.assistant.steps);
  autoscroll();
}

function onDone(p) {
  if (S.turn === null) S.turn = p.turn;
  if (p.turn !== undefined && S.turn !== null && p.turn !== S.turn) return;
  if (!S.assistant) return;
  if (typeof p.text === 'string' && p.text && S.assistant.text !== p.text) {
    S.assistant.text = p.text;
    renderAssistantText(S.assistant);
  }
  // done = 一轮模型输出结束；在 status completed/cancelled/error 之前可能还有工具轮次
  autoscroll();
}

// ---- SSE 接入 ----------------------------------------------------------------

var es = null;

function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onopen = function () {
    S.conn = 'online';
    setStatus(S.streaming ? '运行中…' : '就绪' + (S.streaming ? '' : ' · 在线'), S.streaming ? 'busy' : 'ok');
  };
  es.onerror = function () {
    S.conn = 'down';
    setStatus('重连中…', 'err');
  };
  es.addEventListener('status', function (e) { try { onStatus(parseSSE(e)); } catch (ex) { console.warn('SSE status', ex); } });
  es.addEventListener('text', function (e) { try { onText(parseSSE(e)); } catch (ex) { console.warn('SSE text', ex); } });
  es.addEventListener('thinking', function (e) { try { onThinking(parseSSE(e)); } catch (ex) { console.warn('SSE thinking', ex); } });
  es.addEventListener('tool', function (e) { try { onTool(parseSSE(e)); } catch (ex) { console.warn('SSE tool', ex); } });
  es.addEventListener('tool_result', function (e) { try { onToolResult(parseSSE(e)); } catch (ex) { console.warn('SSE tool_result', ex); } });
  es.addEventListener('done', function (e) { try { onDone(parseSSE(e)); } catch (ex) { console.warn('SSE done', ex); } });
}

// ---- 发送 / 取消 --------------------------------------------------------------

function send() {
  var text = InputEl.value.trim();
  if (!text || S.streaming) return;
  addUserMsg(text);
  InputEl.value = '';
  autoGrow();
  S.streaming = true;
  S.turn = null;
  BtnSend.disabled = true;
  BtnCancel.classList.remove('hidden');
  setStatus('启动中…', 'busy');
  setStatusStep('');
  postJson('/api/turn', { input: text }).then(function (r) {
    if (S.turn === null && r.turn !== undefined) S.turn = r.turn;
    setStatusTurn(S.turn !== null ? S.turn : (r.turn !== undefined ? r.turn : 0));
    if (S.turn === null) startTimer();
    ensureAssistant();
    setStatus('运行中…', 'busy');
  }).catch(function (err) {
    // 403/409/… 直接展示
    S.streaming = false;
    BtnSend.disabled = false;
    BtnCancel.classList.add('hidden');
    stopTimer();
    setStatus('发送失败：' + err.message, 'err');
  });
}

function doCancel() {
  if (!S.streaming) return;
  setStatus('取消中…', 'busy');
  postJson('/api/cancel', {}).catch(function (err) {
    setStatus('取消失败：' + err.message, 'err');
  });
}

BtnSend.addEventListener('click', send);
BtnCancel.addEventListener('click', doCancel);
InputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

function autoGrow() {
  InputEl.style.height = 'auto';
  InputEl.style.height = Math.min(InputEl.scrollHeight, 240) + 'px';
}
InputEl.addEventListener('input', autoGrow);

// ---- 工具清单 -----------------------------------------------------------------

function renderTools(tools) {
  var box = $('#toolList');
  $('#toolCount').textContent = tools.length ? String(tools.length) : '0';
  box.innerHTML = '';
  if (!tools || !tools.length) {
    box.appendChild(el('div', 'side-note err', '未获取到工具'));
    return;
  }
  tools.forEach(function (t) {
    var item = document.createElement('div');
    item.className = 'tool-item';
    item.title = t.description || '';
    item.appendChild(el('div', 'tool-item-name', String(t.name)));
    if (t.description) item.appendChild(el('div', 'tool-item-desc', String(t.description)));
    box.appendChild(item);
  });
}

function loadTools() {
  var box = $('#toolList');
  box.innerHTML = '<div class="side-note">加载中…</div>';
  api('/api/tools').then(function (d) {
    renderTools(d.tools || []);
    $('#sideFoot').textContent = '工具接口正常 · ' + (d.tools || []).length + ' 项';
  }).catch(function (err) {
    box.innerHTML = '';
    box.appendChild(el('div', 'side-note err', '工具接口不可用'));
    box.appendChild(el('div', 'side-note', err.message));
    $('#sideFoot').textContent = '工具接口异常：' + err.message;
  });
}

$('#btnReloadTools').addEventListener('click', loadTools);

// ---- 会话清单 -----------------------------------------------------------------

function renderSessions(sessions) {
  var box = $('#sessionList');
  $('#sessionCount').textContent = String(sessions.length);
  box.innerHTML = '';
  if (!sessions || !sessions.length) {
    box.appendChild(el('div', 'side-note', '无会话记录'));
    return;
  }
  sessions.forEach(function (s) {
    var live = s.live === true || s.kind === 'host';
    var item = document.createElement('div');
    item.className = 'sess-item' + (S.selSession === s.id ? ' active' : '');
    item.dataset.id = s.id;
    var t = document.createElement('div');
    t.className = 'sess-title';
    t.appendChild(el('span', live ? 'sess-live' : 'sess-idle'));
    t.appendChild(el('span', null, s.title || '(未命名)'));
    item.appendChild(t);
    var meta = el('div', 'sess-meta');
    var bits = [];
    if (s.kind) bits.push(s.kind);
    if (s.workspace) bits.push(s.workspace);
    if (s.events !== undefined) bits.push('ev:' + s.events);
    bits.push(s.id || '');
    meta.textContent = bits.join(' · ');
    item.title = meta.textContent;
    item.appendChild(meta);
    item.addEventListener('click', function () {
      S.selSession = s.id;
      $$('.sess-item', box).forEach(function (n) { n.classList.toggle('active', n.dataset.id === s.id); });
      $('#sideFoot').textContent = '当前会话：' + (s.title || s.id || '—');
    });
    box.appendChild(item);
  });
}

function loadSessions() {
  var box = $('#sessionList');
  box.innerHTML = '<div class="side-note">加载中…</div>';
  api('/api/sessions').then(function (d) {
    S.sessions = d.sessions || [];
    renderSessions(S.sessions);
  }).catch(function (err) {
    box.innerHTML = '';
    box.appendChild(el('div', 'side-note err', '会话接口不可用'));
    box.appendChild(el('div', 'side-note', err.message));
  });
}

$('#btnClearSess').addEventListener('click', function () {
  if (!window.confirm('确认清空当前会话？')) return;
  postJson('/api/clear', {}).then(function (d) {
    if (d.ok) {
      $('#sideFoot').textContent = '会话已清空';
      Msgs.innerHTML = '';
      $('#messages').insertAdjacentHTML('afterbegin', '<div id="emptyHint" class="empty-hint"><div class="empty-mark">◇</div><div class="empty-title">Celestea Studio</div><div class="empty-sub">在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行</div></div>');
      S.assistant = null; S.turn = null;
    } else {
      $('#sideFoot').textContent = '清空失败（返回异常）';
    }
  }).catch(function (err) {
    $('#sideFoot').textContent = '清空失败：' + err.message;
  });
});

// ---- 配置弹层 -----------------------------------------------------------------

var CfgLabels = {
  model: '模型',
  base_url: 'Base URL',
  max_steps: '最大步数',
  max_parallel_tool_calls: '并行工具数',
  reasoning_effort: '推理档位',
  max_output_tokens: '最大输出 tokens',
  system_prompt: '系统提示词'
};

function loadConfig() {
  var box = $('#configBody');
  box.innerHTML = '<div class="side-note">加载中…</div>';
  api('/api/config').then(function (cfg) {
    box.innerHTML = '';
    Object.keys(CfgLabels).forEach(function (k) {
      if (cfg[k] === undefined || cfg[k] === null) return;
      var row = el('div', 'cfg-row');
      row.appendChild(el('div', 'cfg-k', CfgLabels[k]));
      var v = el('div', 'cfg-v' + (k === 'system_prompt' ? ' pre' : ' mono'));
      v.textContent = String(cfg[k]);
      row.appendChild(v);
      box.appendChild(row);
    });
    if (!box.children.length) box.appendChild(el('div', 'side-note', '无配置信息'));
  }).catch(function (err) {
    box.innerHTML = '';
    box.appendChild(el('div', 'side-note err', '配置接口不可用'));
    box.appendChild(el('div', 'side-note', err.message));
  });
}

function openModal() {
  $('#modal').classList.remove('hidden');
  loadConfig();
}
function closeModal() { $('#modal').classList.add('hidden'); }

$('#btnConfig').addEventListener('click', function () {
  openModal();
});
$('#modelChip').addEventListener('click', openModal);
$('#btnModalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeModal();
});

// ---- worker 编排 -------------------------------------------------------------

// 把返回 JSON 精简为可读摘要
function prettyRows(obj, keys) {
  var rows = [];
  keys.forEach(function (k) {
    if (obj[k] === undefined || obj[k] === null) return;
    var v = obj[k];
    if (typeof v === 'object') { try { v = JSON.stringify(v); } catch (e) { v = String(v); } }
    rows.push({ k: k, v: String(v) });
  });
  return rows;
}

function renderCards(box, list, keys) {
  if (!list || !list.length) {
    box.appendChild(el('div', 'side-note', '无 worker 记录'));
    return;
  }
  list.forEach(function (w) {
    var card = el('div', 'wcard');
    prettyRows(w, keys || ['wid', 'title', 'status', 'sessionId', 'model', 'workspace', 'cwd', 'live']).forEach(function (row) {
      var line = el('div', 'wcard-line');
      line.appendChild(el('span', 'wcard-k', row.k));
      var v = el('span', 'wcard-v');
      v.textContent = row.v;
      line.appendChild(v);
      card.appendChild(line);
    });
    box.appendChild(card);
  });
}

function showResult(node, text, kind) {
  node.className = 'wf-result show' + (kind ? ' ' + kind : '');
  node.textContent = text;
}

function setResultErr(node, err) {
  showResult(node, '请求失败：' + err.message, 'err');
}

$('#spawnForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var node = $('#spawnResult');
  var wid = $('#spawnWid').value.trim();
  var brief = $('#spawnBrief').value.trim();
  if (!wid) { showResult(node, '请填写 worker 编号', 'err'); return; }
  if (!brief) { showResult(node, '请填写任务简报', 'err'); return; }
  node.className = 'wf-result show';
  node.textContent = '创建中…';
  var body = {
    wid: wid,
    brief: brief,
    title: $('#spawnTitle').value.trim() || undefined,
    model: $('#spawnModel').value.trim() || undefined
  };
  postJson('/api/worker/spawn', body).then(function (d) {
    if (d.ok === false) {
      showResult(node, (d.error || 'spawn 失败') + (d.step ? ' · step:' + d.step : ''), 'err');
      return;
    }
    showResult(node,
      'ok · ' + (d.sessionId || '') + '\n' +
      (d.title || '') + ' · ' + ((d.wid || wid)), 'ok');
    // 创建后顺带刷新状态
    workerStatus();
  }).catch(function (err) { setResultErr(node, err); });
});

$('#sendForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var node = $('#sendResult');
  var target = $('#sendTarget').value.trim();
  var content = $('#sendContent').value.trim();
  if (!target) { showResult(node, '请填写目标会话', 'err'); return; }
  if (!content) { showResult(node, '请填写消息内容', 'err'); return; }
  node.className = 'wf-result show';
  node.textContent = '发送中…';
  postJson('/api/worker/send', { target: target, content: content }).then(function (d) {
    if (d.ok === false) {
      showResult(node, (d.error || 'send 失败') + (d.step ? ' · step:' + d.step : ''), 'err');
      return;
    }
    showResult(node, 'ok · delivered=' + (d.delivered !== false ? 'true' : 'false'), 'ok');
  }).catch(function (err) { setResultErr(node, err); });
});

function workerStatus() {
  var node = $('#statusResult');
  var wid = $('#statusWid').value.trim() || 'W217';
  node.className = 'wf-result show';
  node.textContent = '查询中…';
  api('/api/worker/status?wid=' + encodeURIComponent(wid)).then(function (d) {
    node.innerHTML = '';
    if (d.ok === false && d.error) {
      node.appendChild(el('div', 'side-note err', 'error: ' + d.error));
    }
    var head = 'total=' + (d.total !== undefined ? d.total : '?');
    if (d.by_status) {
      head += ' · ' + Object.keys(d.by_status).map(function (k) { return k + ':' + d.by_status[k]; }).join(' ');
    }
    node.appendChild(el('div', 'side-note', head));
    renderCards(node, d.workers, ['wid', 'title', 'status', 'phase', 'sessionId', 'model', 'workspace', 'cwd', 'live']);
  }).catch(function (err) { setResultErr(node, err); });
}

$('#btnStatusQuery').addEventListener('click', workerStatus);

$('#statusAuto').addEventListener('change', function () {
  var auto = this.checked;
  if (auto) {
    workerStatus();
    S.statusAuto = setInterval(workerStatus, 8000);
  } else if (S.statusAuto) {
    clearInterval(S.statusAuto);
    S.statusAuto = null;
  }
});

// ---- 顶栏 / 侧栏 --------------------------------------------------------------

$('#btnSidebar').addEventListener('click', function () {
  var app = $('#app');
  app.classList.toggle('no-sidebar');
});

// ---- 初始化 ------------------------------------------------------------------

function initHealth() {
  api('/api/health').then(function (h) {
    $('#modelChip').textContent = h.model || '—';
    $('#modelChip').title = (h.base_url || '') + ' · ' + (h.name || '');
    $('#sideFoot').textContent = (h.base_url || '') + ' · ' + h.model;
    if (!S.streaming) setStatus('就绪 · 在线', 'ok');
  }).catch(function () {
    $('#modelChip').textContent = '离线';
    setStatus('后端不可达', 'err');
  });
}

function init() {
  loadTools();
  loadSessions();
  initHealth();
  connectSSE();
  workerStatus();
  InputEl.focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}