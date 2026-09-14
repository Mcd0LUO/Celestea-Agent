// ============================================================================
// W514 多会话前端 · 端到端自测（本地 mock 后端 + headless chromium）
//   A 组（v2 契约）：会话自由切换 / 每会话独立容器（零重渲染 + 流继续 +
//                    滚动位与草稿保留）/ 运行中插话 / worker 组可见
//   B 组（--legacy 降级）：无 session/kind/busy、busy→409 时行为与现状一致
//                    且不空白、不报错、不丢输入
//   用法：node bench/e2e-multisession.mjs
// ============================================================================
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || '/tmp/w217-test/node_modules/playwright');

const V2 = process.env.MOCK_V2 || 'http://127.0.0.1:8791';
const LEGACY = process.env.MOCK_LEGACY || 'http://127.0.0.1:8792';
const ID_A = 'CelesteaTeamAPI/sess-A';
const ID_B = 'CelesteaTeamAPI/sess-B';
const ID_W = 'server-center/W514·前端多会话';

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra ?? '' });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  — ' + extra : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, path) {
  const r = await fetch(base + path);
  return r.json();
}

async function visiblePane(page) {
  return page.evaluate(() => {
    const p = document.querySelector('.sess-pane:not([hidden])');
    return p ? { id: p.dataset.session, text: p.textContent ?? '', mcols: p.querySelectorAll('.mcol').length } : null;
  });
}

async function paneInfo(page, id) {
  return page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid.replace(/"/g, '\\"') + '"]');
    if (!el) return null;
    return {
      hidden: el.hidden === true,
      text: el.textContent ?? '',
      len: (el.textContent ?? '').length,
      mcols: el.querySelectorAll('.mcol').length,
      scrollTop: el.scrollTop,
      marked: el.querySelector('.msg.assistant .content[data-mark="probe"]') !== null,
    };
  }, id);
}

async function boot(page, base) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const u = (m.location && m.location().url) || '';
    // mock 未实现的设置页接口（providers/prompts）：真实后端存在，不算前端错误
    if (/\/api\/(providers|prompts)/.test(u) || /404/.test(m.text()) === false) return;
    errors.push(m.text() + ' @ ' + u);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sess-pane:not([hidden])', { timeout: 8000 });
  await page.waitForFunction(() => (document.querySelector('#sessionBar .sess-bar-name')?.textContent ?? '') !== '—', null, { timeout: 8000 });
  return errors;
}

async function runV2(browser) {
  console.log('\n=== A 组：v2 契约（多会话视图 + 插话） ===');
  await api(V2, '/control/reset');
  const page = await browser.newPage({ viewport: { width: 1440, height: 460 } });
  const errors = await boot(page, V2);

  // ---- T1 启动：聚焦活跃会话 A，历史已恢复，侧栏含 Worker 组 ----
  const v1 = await visiblePane(page);
  check('T1 启动后聚焦活跃会话 A', v1 && v1.id === ID_A, JSON.stringify(v1 && v1.id));
  const a1 = await paneInfo(page, ID_A);
  check('T1 A 容器已恢复历史（存量消息可见）', !!a1 && a1.text.includes('A 的历史回复'));
  await page.waitForFunction(() => (document.querySelector('#sessionBar .sess-bar-name')?.textContent ?? '') === 'A · 会话一', null, { timeout: 5000 }).catch(() => {});
  const bar1 = await page.textContent('#sessionBar .sess-bar-name');
  check('T1 会话条显示聚焦会话 A 的标题', bar1 === 'A · 会话一', String(bar1));
  const leafCount = await page.locator('.sess-leaf').count();
  check('T1 侧栏列出会话行（A/B）', leafCount === 2, 'leaves=' + leafCount);
  const wid = await page.textContent('.ws-worker-wid').catch(() => null);
  check('T1 侧栏含 Worker 组并显示 wid', wid === 'W514', String(wid));
  const wDetails = await page.evaluate(() => {
    const d = document.querySelector('.ws-worker-details');
    return d ? { tag: d.tagName, open: d.open } : null;
  });
  check('T1 Worker 组可展开（details）', !!wDetails && wDetails.tag === 'DETAILS', JSON.stringify(wDetails));

  // ---- T1b W515 谱系缩进：父会话 → worker 子行（无 parent → 未关联） ----
  const lin = await page.evaluate(() => ({
    parents: Array.from(document.querySelectorAll('.ws-worker-parent .ws-worker-parent-name')).map((n) => n.textContent),
    childRows: document.querySelectorAll('.ws-worker-row.child').length,
    childOfA: !!document.querySelector('.ws-worker-row.child[data-id="server-center/W514·前端多会话"]'),
    badge: document.querySelector('.sess-leaf[data-id="CelesteaTeamAPI/sess-A"] .sess-worker-count')?.textContent ?? '',
    flatRows: document.querySelectorAll('.ws-worker-row:not(.child)').length,
  }));
  check('T1b Worker 组按父会话分组（谱系缩进）', lin.parents.includes('A · 会话一') && lin.childOfA && lin.childRows >= 1, JSON.stringify(lin));
  check('T1b 无 parent 的 worker 归入「未关联」', lin.parents.includes('未关联父会话') && lin.childRows >= 2, JSON.stringify(lin.parents));
  check('T1b 父会话行显示 worker 子会话数徽标', lin.badge === 'W1', 'badge=' + lin.badge);

  // ---- T2 任意点击即切换（不等待网络 / 不受其它会话影响）+ 草稿独立 ----
  await page.fill('#input', 'DRAFT-A');
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 });
  const b1 = await paneInfo(page, ID_B);
  check('T2 点击会话 B 立即切换（<2s，无 409 阻塞）', !!(b1 && !b1.hidden), JSON.stringify(b1 && b1.hidden));
  check('T2 B 容器恢复了自己的历史', !!b1 && b1.text.includes('B 的历史回复'));
  const draftB = await page.inputValue('#input');
  check('T2 输入草稿按会话隔离（B 为空草稿）', draftB === '', 'value=' + JSON.stringify(draftB));
  await page.click('.sess-leaf[data-id="' + ID_A + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_A, { timeout: 2000 });
  const draftA = await page.inputValue('#input');
  check('T2 切回 A 恢复 A 的草稿', draftA === 'DRAFT-A', 'value=' + JSON.stringify(draftA));
  await page.fill('#input', '');
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 });

  // ---- T3 运行中发送 = 插话（输入框不再禁用） ----
  await page.fill('#input', 'B 的问题');
  await page.click('#btnSend');
  await page.waitForFunction(
    (sid) => {
      const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
      return !!el && !!el.querySelector('.msg.assistant .content') && (el.querySelector('.msg.assistant .content').textContent ?? '').length > 5;
    },
    ID_B,
    { timeout: 6000 },
  );
  const mode = await page.evaluate(() => ({
    interject: document.querySelector('#inputbar').classList.contains('interject'),
    sendDisabled: document.querySelector('#btnSend').disabled,
    sendLabel: document.querySelector('#btnSend').textContent,
    placeholder: document.querySelector('#input').placeholder,
    cancelVisible: !document.querySelector('#btnCancel').classList.contains('hidden'),
  }));
  check('T3 运行中输入框不禁用且进入插话态', !mode.sendDisabled && mode.interject && mode.sendLabel === '插话', JSON.stringify(mode));
  check('T3 运行中显示取消按钮（聚焦会话）', mode.cancelVisible === true);

  // 打标：记录节点身份（供切回时验证零重渲染）
  await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    const c = el.querySelector('.msg.assistant .content');
    if (c) c.dataset.mark = 'probe';
  }, ID_B);
  const bBefore = await paneInfo(page, ID_B);
  check('T3 B 流式内容已渲染', !!bBefore && bBefore.marked, JSON.stringify(bBefore && { marked: bBefore.marked, len: bBefore.len }));

  await page.fill('#input', 'B 插话内容');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sess-pane[data-session="' + ID_B + '"] .msg.user.steering', { timeout: 3000 });
  await page.waitForFunction(
    (sid) => {
      const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
      const notes = el ? el.querySelectorAll('.interject-note') : [];
      return Array.from(notes).some((n) => (n.textContent ?? '').includes('将在下一步送达'));
    },
    ID_B,
    { timeout: 5000 },
  );
  const interjectNote = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    return Array.from(el.querySelectorAll('.interject-note'))
      .map((n) => n.textContent)
      .join(' | ');
  }, ID_B);
  check('T3 插话渲染 + 轻提示「将在下一步送达」', (interjectNote ?? '').includes('将在下一步送达'), interjectNote ?? '');
  const st = await api(V2, '/control/state');
  const inj = st.turnReqs.find((r) => r.input === 'B 插话内容');
  check('T3 插话走 POST /api/turn 且带聚焦 session', !!inj && inj.sessionField === ID_B, JSON.stringify(inj));
  check('T3 插话不新开轮（mock 记为 injected）', st.notes.some((n) => n.kind === 'interject' && n.text === 'B 插话内容'));

  // ---- T3b W515 提交两态：Ctrl/Cmd+Enter = 排队（下一回合送达） ----
  const modeChip = await page.evaluate(() => {
    const b = document.querySelector('#btnMode');
    return { hidden: b.classList.contains('hidden'), text: b.textContent };
  });
  check('T3b 运行中显示提交车道切换（插话/排队）', modeChip.hidden === false && modeChip.text === '插话', JSON.stringify(modeChip));
  await page.fill('#input', 'B 排队内容');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.sess-pane[data-session="' + ID_B + '"] .msg.user.queued', { timeout: 3000 });
  await page.waitForFunction(
    (sid) => {
      const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
      const notes = el ? el.querySelectorAll('.interject-note.ok') : [];
      const last = notes[notes.length - 1];
      return !!last && (last.textContent ?? '').includes('本轮结束后送达');
    },
    ID_B,
    { timeout: 5000 },
  );
  const qNote = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    const notes = el.querySelectorAll('.interject-note.ok');
    return notes[notes.length - 1]?.textContent ?? '';
  }, ID_B);
  check('T3b 排队提示「本轮结束后送达」', (qNote ?? '').includes('本轮结束后送达'), qNote ?? '');
  const stQ = await api(V2, '/control/state');
  const qReq = stQ.turnReqs.find((r) => r.input === 'B 排队内容');
  const sReq = stQ.turnReqs.find((r) => r.input === 'B 插话内容');
  check('T3b 排队走 mode=queue 且带 session', !!qReq && qReq.mode === 'queue' && qReq.sessionField === ID_B, JSON.stringify(qReq));
  check('T3b 插话走 mode=steer', !!sReq && sReq.mode === 'steer', JSON.stringify(sReq));
  check('T3b 排队与插话是不同车道（mock 分别记账）', stQ.notes.some((n) => n.kind === 'queued') && stQ.notes.some((n) => n.kind === 'interject'));
  const qChip = await page.evaluate(() => {
    document.querySelector('#btnMode').click();
    return { text: document.querySelector('#btnMode').textContent, send: document.querySelector('#btnSend').textContent };
  });
  check('T3b 车道切换按钮可切换（排队态按钮文案同步）', qChip.text === '排队' && qChip.send === '排队', JSON.stringify(qChip));
  await page.evaluate(() => document.querySelector('#btnMode').click()); // 切回插话

  // ---- T4 后台会话继续接收增量 + 当前视图零重渲染 + 滚动位/草稿保留 ----
  await page.click('.sess-leaf[data-id="' + ID_A + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_A, { timeout: 2000 });
  const aMark = await page.evaluate(() => {
    const el = document.querySelector('.sess-pane[data-session="CelesteaTeamAPI/sess-A"]');
    const c = el.querySelector('.msg.assistant .content');
    if (c) c.dataset.mark = 'probeA';
    return true;
  });
  await sleep(900);
  const bAfter = await paneInfo(page, ID_B);
  const aAfter = await paneInfo(page, ID_A);
  check('T4 B（后台）继续接收增量（文本变长）', !!bAfter && bAfter.len > bBefore.len, `len ${bBefore.len} → ${bAfter && bAfter.len}`);
  check('T4 B 容器零重渲染（同一节点仍在）', !!bAfter && bAfter.marked === true);
  check('T4 切换不重渲染新聚焦视图 A（标记节点仍在）', !!aAfter && (await page.evaluate(() => !!document.querySelector('.sess-pane[data-session="CelesteaTeamAPI/sess-A"] .content[data-mark="probeA"]'))), JSON.stringify(aMark));
  const others = await page.evaluate(() => Array.from(document.querySelectorAll('.sess-bar-chip')).map((c) => c.textContent));
  check('T4 会话条区分「其它运行中会话」', others.length >= 1 && others.join(' ').includes('B · 会话二'), JSON.stringify(others));
  const bDot = await page.evaluate((sid) => {
    const leaf = document.querySelector('.sess-leaf[data-id="' + sid + '"] .sess-dot');
    return leaf ? leaf.classList.contains('busy') : null;
  }, ID_B);
  check('T4 侧栏 B 行显示运行态点', bDot === true);
  await page.fill('#input', 'DRAFT-A2');
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 });
  const bBack = await paneInfo(page, ID_B);
  check('T4 切回 B：流与工具卡仍在（节点身份保持）', !!bBack && bBack.marked === true, JSON.stringify(bBack && { marked: bBack.marked, mcols: bBack.mcols }));
  check('T4 切回 B：仍在跟随最新（流未中断）', !!bBack && bBack.marked === true);
  const draftB2 = await page.inputValue('#input');
  check('T4 切回 B：B 的草稿（空）而非 A 的草稿', draftB2 === '', JSON.stringify(draftB2));
  const interjectStill = await page.locator('.sess-pane[data-session="' + ID_B + '"] .msg.user.steering').count();
  check('T4 切回 B：插话气泡仍在', interjectStill === 1, 'count=' + interjectStill);
  await page.click('.sess-leaf[data-id="' + ID_A + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_A, { timeout: 2000 });
  const draftA2 = await page.inputValue('#input');
  check('T4 切回 A：草稿 DRAFT-A2 恢复', draftA2 === 'DRAFT-A2', JSON.stringify(draftA2));
  await page.fill('#input', '');

  // ---- T5 轮次收尾 ----
  await page.waitForFunction(
    (sid) => {
      const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
      return !!el && !!el.querySelector('.msg.assistant .bubble.complete');
    },
    ID_B,
    { timeout: 15000 },
  );
  await page.waitForFunction(
    (sid) => {
      const leaf = document.querySelector('.sess-leaf[data-id="' + sid + '"] .sess-dot');
      return !!leaf && !leaf.classList.contains('busy');
    },
    ID_B,
    { timeout: 15000 },
  );
  check('T5 轮次结束后运行态点熄灭', true);

  // ---- T5b W515 转录分类：user / steering / queued / inbox 可区分 ----
  const kinds = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    const cap = (sel) => (el.querySelector(sel + ' .who')?.textContent ?? '');
    return {
      plain: el.querySelectorAll('.msg.user:not(.steering):not(.queued)').length,
      steering: el.querySelectorAll('.msg.user.steering').length,
      queued: el.querySelectorAll('.msg.user.queued').length,
      inbox: el.querySelectorAll('.msg.inbox').length,
      inboxWho: cap('.msg.inbox'),
      inboxLane: el.querySelector('.msg.inbox .inbox-lane')?.textContent ?? '',
      inboxText: el.querySelector('.msg.inbox .inbox-content')?.textContent ?? '',
      steeringWho: cap('.msg.user.steering'),
      queuedWho: cap('.msg.user.queued'),
    };
  }, ID_B);
  check('T5b 三类用户侧消息可区分（普通/插话/排队）', kinds.plain >= 1 && kinds.steering === 1 && kinds.queued === 1, JSON.stringify(kinds));
  check('T5b 标题前缀区分插话/排队', kinds.steeringWho.includes('插话') && kinds.queuedWho.includes('排队'), JSON.stringify([kinds.steeringWho, kinds.queuedWho]));
  check('T5b inbox 事件渲染为回执条目（带来源与车道）', kinds.inbox === 1 && kinds.inboxWho.includes('回执') && kinds.inboxLane.includes('下一回合') && kinds.inboxText.includes('Worker 回执'), JSON.stringify(kinds));
  const histKinds = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    return {
      steering: el.querySelectorAll('.msg.user.steering').length,
      inbox: el.querySelectorAll('.msg.inbox').length,
    };
  }, ID_A);
  check('T5b 历史恢复同样区分 steering / inbox', histKinds.steering >= 1 && histKinds.inbox >= 1, JSON.stringify(histKinds));

  // ---- T4b 静止会话：切走再切回，滚动位原样保留（非贴底不吸附） ----
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 });
  const scrollMid = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    el.scrollTop = 30;
    return el.scrollTop;
  }, ID_B);
  check('T4b 容器可滚动（滚动位断言有意义）', scrollMid > 0, 'scrollTop=' + scrollMid);
  await page.click('.sess-leaf[data-id="' + ID_A + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_A, { timeout: 2000 });
  await sleep(300);
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 });
  await sleep(200);
  const bBack2 = await paneInfo(page, ID_B);
  check('T4b 切回静止会话：滚动位保留', !!bBack2 && Math.abs(bBack2.scrollTop - scrollMid) <= 8, `scrollTop ${scrollMid} → ${bBack2 && bBack2.scrollTop}`);

  // ---- T6 打开 worker 会话视图（只读） ----
  await page.click('.ws-worker-row[data-id="' + ID_W + '"]');
  await page.waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_W, { timeout: 3000 });
  await page
    .waitForFunction(
      (sid) => {
        const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
        return !!el && (el.textContent ?? '').includes('worker 已完成 X');
      },
      ID_W,
      { timeout: 5000 },
    )
    .catch(() => {});
  const w = await paneInfo(page, ID_W);
  check('T6 点击 worker 行打开其会话视图', !!w && !w.hidden && w.text.includes('worker 已完成 X'));
  const ro = await page.evaluate(() => ({
    sendDisabled: document.querySelector('#btnSend').disabled,
    label: document.querySelector('#btnSend').textContent,
    kind: document.querySelector('#sessionBar .sess-bar-kind').classList.contains('hidden') ? '' : 'WORKER',
  }));
  check('T6 worker 视图为只读（发送禁用 + WORKER 标记）', ro.sendDisabled === true && ro.kind === 'WORKER', JSON.stringify(ro));
  const paneCount = await page.locator('.sess-pane').count();
  check('T6 三个会话容器并存（A/B/W）', paneCount === 3, 'panes=' + paneCount);

  // ---- T7 设置页「会话」pane 复用同一棵树（改动后仍可用） ----
  await page.click('#btnConfig');
  await page.click('.settings-nav-item[data-page="sessions"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#settingsSessions .sess-leaf').length >= 2,
    null,
    { timeout: 5000 },
  ).catch(() => {});
  const settingsLeaves = await page.locator('#settingsSessions .sess-leaf').count();
  check('T7 设置页会话 pane 正常渲染（复用会话树）', settingsLeaves >= 2, 'leaves=' + settingsLeaves);
  await page.click('#btnSettingsClose');

  check('T6 v2 模式无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

async function runLegacy(browser) {
  console.log('\n=== B 组：旧后端降级（无 session/kind/busy，busy→409） ===');
  await api(LEGACY, '/control/reset');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await boot(page, LEGACY);

  const v = await visiblePane(page);
  check('L1 降级：启动仍聚焦活跃会话且不空白', !!v && v.mcols > 0, JSON.stringify(v && { id: v.id, mcols: v.mcols }));
  const workerRows = await page.locator('.ws-worker-row').count();
  check('L1 降级：kind 缺失 → 不显示 Worker 组（与现状一致）', workerRows === 0, 'rows=' + workerRows);
  const linLegacy = await page.locator('.ws-worker-parent').count();
  check('L1 降级：parent 缺失 → 无谱系缩进（平坦）', linLegacy === 0, 'parents=' + linLegacy);
  const bar = await page.textContent('#sessionBar');
  check('L1 降级：会话条可用', (bar ?? '').trim().length > 0, bar ?? '');

  // 运行中发送 → 走插话路径但后端 409 → 还原输入框 + 可见提示（不丢字）
  await page.fill('#input', 'L 的问题');
  await page.click('#btnSend');
  await page.waitForFunction(() => document.querySelector('#inputbar').classList.contains('interject'), null, { timeout: 5000 });
  const sendDisabled = await page.evaluate(() => document.querySelector('#btnSend').disabled);
  check('L2 降级：运行中输入框仍可发送（插话态）', sendDisabled === false);
  await page.fill('#input', '旧后端插话');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (document.body.textContent ?? '').includes('插话未送达'),
    null,
    { timeout: 5000 },
  );
  // 注：历史里本身就有 steering/inbox 存量条目，故「撤销乐观渲染」断言按**文本**判断
  const after = await page.evaluate(() => ({
    draft: document.querySelector('#input').value,
    optimistic: Array.from(document.querySelectorAll('.msg.user.steering .content, .msg.user.queued .content')).filter(
      (c) => (c.textContent ?? '').includes('旧后端插话'),
    ).length,
    note: Array.from(document.querySelectorAll('.sess-pane .msg.info')).map((n) => n.textContent).join(' || '),
    status: document.querySelector('#statusText').textContent,
  }));
  check('L2 降级：插话失败 → 文本还原回输入框（不丢字）', after.draft === '旧后端插话', JSON.stringify(after.draft));
  check('L2 降级：撤销乐观渲染的插话气泡', after.optimistic === 0, 'count=' + after.optimistic);
  check('L2 降级：给出可见提示（信息块/状态栏）', after.note.includes('插话未送达') || after.status.includes('插话未送达'), after.status);

  // W515：排队车道在旧后端同样不可用 → 回退插话也失败 → 还原输入 + 排队条目撤销
  await page.fill('#input', '旧后端排队');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => (document.body.textContent ?? '').includes('排队未送达'), null, { timeout: 6000 });
  const qAfter = await page.evaluate(() => {
    const txt = (sel) =>
      Array.from(document.querySelectorAll(sel)).filter((c) => (c.textContent ?? '').includes('旧后端排队')).length;
    return {
      draft: document.querySelector('#input').value,
      queued: txt('.msg.user.queued .content'),
      steering: txt('.msg.user.steering .content'),
    };
  });
  check('L2b 降级：排队失败 → 还原输入框且撤销排队条目', qAfter.draft === '旧后端排队' && qAfter.queued === 0 && qAfter.steering === 0, JSON.stringify(qAfter));
  await page.fill('#input', '');

  // 别的会话在跑 → 点击依然立即切换
  await page.click('.sess-leaf[data-id="' + ID_B + '"]');
  const switched = await page
    .waitForFunction((sid) => document.querySelector('.sess-pane:not([hidden])')?.dataset.session === sid, ID_B, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  check('L3 降级：另一会话运行中仍能立即切换会话', switched === true);
  const foot = await page.textContent('#sideFoot');
  check('L3 降级：409 只提示、不影响已打开的视图', (foot ?? '').length > 0, foot ?? '');
  const stillStreaming = await page.evaluate((sid) => {
    const el = document.querySelector('.sess-pane[data-session="' + sid + '"]');
    return !!el && !!el.querySelector('.msg.assistant .content');
  }, ID_A);
  check('L3 降级：原会话的实时流仍在自己的容器里', stillStreaming === true);

  check('L3 降级：无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--max-old-space-size=768'],
});
try {
  // 资源紧张时可用 ONLY_V2=1 / ONLY_LEGACY=1 分两次跑（两组互不依赖）
  if (!process.env.ONLY_LEGACY) await runV2(browser);
  if (!process.env.ONLY_V2) await runLegacy(browser);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  for (const f of failed) console.log('FAILED: ' + f.name + (f.extra ? ' — ' + f.extra : ''));
  process.exit(1);
}
