// ============================================================================
// ui/contextview.ts — W726：只读「完整上下文」浮层（点状态栏上下文圆环打开）。
//
//   用途：让用户看清**模型本轮实际看到的内容**——系统提示词全文、工具清单
//   （含参数结构）、消息流（用户 / 助手 / 工具结果，带序号与字符数）与用量。
//   纯只读：无输入框、无编辑、无提交。
//
//   基建沿用既有约定：
//     - 挂到 body 的浮层压入 utils/overlays 层级栈（一次 Esc 只关栈顶一层）；
//     - 铁律 1/8：正文先离屏构建，就绪后单次 replaceChildren——「正在读取…」只
//       出现在首次空容器里，绝不逐条清空重建；
//     - 铁律 3：请求带序号守卫，晚到的旧结果一律丢弃；
//     - 铁律 4：折叠/展开走 <details>（与本仓工具卡/会话树同一套做法），不重建 DOM；
//     - 铁律 5：打开/关闭不触碰背景视图（不改消息区、不触发重渲染）。
//
//   能力位降级：GET /api/health 的 capabilities.context !== true（旧服务 / 探测
//   失败）→ 调用方只给一句轻提示，**不打开浮层、不报错**（见 contextSupported）。
// ============================================================================
import { api, userErrorText } from '../api';
import type { ContextMessage, ContextToolInfo, SessionContextResp } from '../types';
import { el, fmtCompact } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';

/** 能力位缓存时长：避免每次点击都打一次健康检查。 */
const CAP_TTL_MS = 60000;

let capState: 'unknown' | 'on' | 'off' = 'unknown';
let capAt = 0;

/**
 * 能力位探测：只有显式 `true` 才算可用；字段缺失 / 请求失败 / 旧服务
 * 一律按不可用处理（不报错、不崩溃）。结果在 CAP_TTL_MS 内复用。
 */
export async function contextSupported(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && capState !== 'unknown' && now - capAt < CAP_TTL_MS) return capState === 'on';
  capAt = now;
  try {
    const h = await api.health();
    capState = h.capabilities?.context === true ? 'on' : 'off';
  } catch {
    capState = 'off';
  }
  return capState === 'on';
}

/** 当前打开的浮层序号（0 = 未打开）+ 是否已打开：用于丢弃晚到的请求结果。 */
let openSeq = 0;
let opened = false;

/**
 * 打开只读上下文浮层。`sessionId` 必须非空（未解析出会话时调用方先给提示）。
 * 重复调用安全：已打开时忽略。
 */
export function openContextView(sessionId: string): void {
  if (sessionId === '' || opened) return;
  const seq = ++openSeq;
  opened = true;

  const scrim = el('div', 'modal-scrim ctx-scrim');
  const card = el('div', 'modal-card ctx-card');

  // ---- 顶栏与骨架（正文稍后单次替换） ----
  const head = el('div', 'ctx-head');
  head.appendChild(el('span', 'ctx-title', '完整上下文'));
  head.appendChild(el('span', 'ctx-tag', '只读'));
  const closeBtn = el('button', 'btn btn-soft btn-mini ctx-close', '关闭') as HTMLButtonElement;
  closeBtn.type = 'button';
  head.appendChild(closeBtn);
  card.appendChild(head);

  const meta = el('div', 'ctx-meta');
  const modelEl = el('span', 'ctx-model', '—');
  const usageEl = el('span', 'ctx-usage');
  const countsEl = el('span', 'ctx-counts');
  meta.appendChild(modelEl);
  meta.appendChild(el('span', 'ctx-sep', '·'));
  meta.appendChild(usageEl);
  meta.appendChild(el('span', 'ctx-sep', '·'));
  meta.appendChild(countsEl);
  card.appendChild(meta);

  const body = el('div', 'ctx-body');
  body.appendChild(el('div', 'ctx-note', '正在读取…')); // 首次空容器占位（铁律 1 例外）
  card.appendChild(body);

  const foot = el('div', 'ctx-foot', '只读快照 · 不发送、不修改任何内容');
  card.appendChild(foot);

  scrim.appendChild(card);
  document.body.appendChild(scrim);

  let handle: OverlayHandle | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (handle) popOverlay(handle);
    handle = null;
    scrim.remove();
    if (openSeq === seq) {
      openSeq = 0;
      opened = false;
    }
  };
  handle = pushOverlay(close);
  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });

  // 竞态守卫：浮层已关闭 / 已被更新的请求取代 → 丢弃本次结果（铁律 3）
  const alive = (): boolean => !closed && openSeq === seq;

  void api
    .sessionContext(sessionId)
    .then((res) => {
      if (!alive()) return;
      renderMeta(modelEl, usageEl, countsEl, res);
      // 铁律 1/8：正文离屏构建 → 单次替换
      const off = document.createElement('div');
      off.className = 'ctx-body-inner';
      off.appendChild(renderSystem(res));
      off.appendChild(renderTools(res));
      off.appendChild(renderMessages(res));
      body.replaceChildren(...off.childNodes);
      foot.textContent =
        (typeof res.session === 'string' && res.session !== ''
          ? '会话 ' + res.session + ' · '
          : '') +
        '只读快照 · 不发送、不修改任何内容' +
        (res.truncated === true ? ' · 部分条目过长已截断' : '');
    })
    .catch((err: unknown) => {
      if (!alive()) return; // 浮层已关闭：不打扰用户
      body.replaceChildren(
        el('div', 'ctx-error', userErrorText(err, '暂时无法读取上下文，请稍后重试')),
      );
    });
}

// ---- 顶栏 -------------------------------------------------------------------

function renderMeta(
  modelEl: HTMLElement,
  usageEl: HTMLElement,
  countsEl: HTMLElement,
  res: SessionContextResp,
): void {
  const model = typeof res.model === 'string' && res.model !== '' ? res.model : '—';
  modelEl.textContent = model;
  modelEl.title = '当前模型：' + model;

  const c = res.context ?? {};
  const parts: string[] = [];
  if (typeof c.used === 'number') parts.push(fmtCompact(c.used) + ' / ' + fmtCompact(c.window));
  const ratio =
    typeof c.ratio === 'number'
      ? c.ratio
      : typeof c.used === 'number' && typeof c.window === 'number' && c.window > 0
        ? c.used / c.window
        : null;
  if (ratio !== null && Number.isFinite(ratio)) parts.push(fmtPct(ratio) + '%');
  const usageText = el('span', 'ctx-usage-text', parts.length ? parts.join(' · ') : '—');
  usageEl.replaceChildren(usageText);
  usageEl.title = '上下文用量（已用 / 容量）';
  if (c.estimated === true) usageEl.appendChild(el('span', 'ctx-badge', '估算'));

  const n = res.counts ?? {};
  const sysChars = typeof n.system_chars === 'number' ? n.system_chars : len(res.system);
  const tools = typeof n.tool_count === 'number' ? n.tool_count : (res.tools ?? []).length;
  const msgs = typeof n.message_count === 'number' ? n.message_count : (res.messages ?? []).length;
  countsEl.textContent = '系统 ' + fmtInt(sysChars) + ' 字符 · 工具 ' + tools + ' · 消息 ' + msgs;
  countsEl.title = '本轮上下文的条目数量';
}

// ---- 系统提示词 --------------------------------------------------------------

function renderSystem(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const text = typeof res.system === 'string' ? res.system : '';
  const det = document.createElement('details');
  det.className = 'ctx-fold ctx-fold-sys';
  det.open = true; // 系统提示词默认展开；其余默认折叠，用户按需展开
  const sum = el('summary', 'ctx-fold-head');
  sum.appendChild(el('span', 'ctx-fold-name', '系统提示词'));
  sum.appendChild(el('span', 'ctx-count', fmtInt(text.length) + ' 字符'));
  det.appendChild(sum);
  const pre = el('pre', 'ctx-pre ctx-pre-sys');
  pre.textContent = text === '' ? '（空）' : text;
  det.appendChild(pre);
  sec.appendChild(det);
  return sec;
}

// ---- 工具清单 ----------------------------------------------------------------

function renderTools(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const tools: ContextToolInfo[] = Array.isArray(res.tools) ? res.tools : [];

  const head = el('div', 'ctx-sec-head');
  head.appendChild(el('span', 'ctx-sec-name', '工具清单'));
  head.appendChild(el('span', 'ctx-count', tools.length + ' 个'));
  if (tools.some((t) => t.truncated === true)) {
    head.appendChild(el('span', 'ctx-badge', '部分已截断'));
  }
  sec.appendChild(head);

  if (!tools.length) {
    sec.appendChild(el('div', 'ctx-note', '本轮没有可用工具'));
    return sec;
  }

  const list = el('div', 'ctx-tools');
  tools.forEach((t, i) => {
    const det = document.createElement('details');
    det.className = 'ctx-fold ctx-tool';
    const sum = el('summary', 'ctx-tool-head');
    sum.appendChild(el('span', 'ctx-tool-idx', '#' + (i + 1)));
    sum.appendChild(el('span', 'ctx-tool-name', t.name || '（未命名）'));
    sum.appendChild(el('span', 'ctx-tool-desc', oneLine(t.description)));
    if (t.truncated === true) sum.appendChild(el('span', 'ctx-badge', '已截断'));
    det.appendChild(sum);

    const pre = el('pre', 'ctx-pre ctx-pre-schema');
    pre.textContent = schemaText(t.parameters);
    det.appendChild(pre);
    list.appendChild(det);
  });
  sec.appendChild(list);
  return sec;
}

function schemaText(params: unknown): string {
  if (params === undefined || params === null) return '无参数结构';
  if (typeof params === 'string') return params === '' ? '无参数结构' : params;
  try {
    return JSON.stringify(params, null, 2) ?? '无参数结构';
  } catch {
    return '参数结构无法展示';
  }
}

// ---- 消息流 ------------------------------------------------------------------

/** 分组顺序：用户 → 助手 → 工具结果；未知 role 各自成组放在末尾。 */
const ROLE_GROUPS: readonly { key: string; label: string }[] = [
  { key: 'user', label: '用户' },
  { key: 'assistant', label: '助手' },
  { key: 'tool', label: '工具结果' },
];

interface MsgRef {
  m: ContextMessage;
  /** 在原始消息流中的位置（0 基）：显示为 #(idx+1)，保留真实顺序信息。 */
  idx: number;
}

function renderMessages(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const msgs: ContextMessage[] = Array.isArray(res.messages) ? res.messages : [];

  const head = el('div', 'ctx-sec-head');
  head.appendChild(el('span', 'ctx-sec-name', '消息流'));
  head.appendChild(el('span', 'ctx-count', msgs.length + ' 条'));
  if (msgs.some((m) => m.truncated === true)) {
    head.appendChild(el('span', 'ctx-badge', '部分已截断'));
  }
  sec.appendChild(head);

  if (!msgs.length) {
    sec.appendChild(el('div', 'ctx-note', '本轮还没有消息'));
    return sec;
  }

  for (const g of ROLE_GROUPS) {
    const items: MsgRef[] = [];
    msgs.forEach((m, i) => {
      if (roleKey(m) === g.key) items.push({ m, idx: i });
    });
    if (items.length) sec.appendChild(renderGroup(g.label, items));
  }

  const extras = new Map<string, MsgRef[]>();
  msgs.forEach((m, i) => {
    const key = roleKey(m);
    if (ROLE_GROUPS.some((g) => g.key === key)) return;
    const list = extras.get(key);
    if (list) list.push({ m, idx: i });
    else extras.set(key, [{ m, idx: i }]);
  });
  for (const [key, items] of extras) sec.appendChild(renderGroup(key === '' ? '其它' : key, items));
  return sec;
}

function renderGroup(label: string, items: readonly MsgRef[]): HTMLElement {
  const group = el('div', 'ctx-group');
  const gh = el('div', 'ctx-group-head');
  gh.appendChild(el('span', 'ctx-group-name', label));
  gh.appendChild(el('span', 'ctx-count', items.length + ' 条'));
  group.appendChild(gh);

  for (const { m, idx } of items) {
    const text = typeof m.content === 'string' ? m.content : '';
    const det = document.createElement('details');
    det.className = 'ctx-fold ctx-msg';
    const sum = el('summary', 'ctx-msg-head');
    sum.appendChild(el('span', 'ctx-msg-idx', '#' + (idx + 1)));
    if (m.role === 'tool' && typeof m.tool_name === 'string' && m.tool_name !== '') {
      sum.appendChild(el('span', 'ctx-msg-tool', m.tool_name));
    }
    sum.appendChild(el('span', 'ctx-count', fmtInt(text.length) + ' 字符'));
    if (m.truncated === true) sum.appendChild(el('span', 'ctx-badge', '已截断'));
    sum.appendChild(el('span', 'ctx-msg-preview', preview(text)));
    if (typeof m.tool_call_id === 'string' && m.tool_call_id !== '') {
      sum.title = '调用标识：' + m.tool_call_id;
    }
    det.appendChild(sum);
    const pre = el('pre', 'ctx-pre ctx-pre-msg');
    pre.textContent = text === '' ? '（空）' : text;
    det.appendChild(pre);
    group.appendChild(det);
  }
  return group;
}

/** role 归一：工具结果的几种写法统一成 'tool'（大小写/下划线不敏感）。 */
function roleKey(m: ContextMessage): string {
  const r = typeof m.role === 'string' ? m.role.trim().toLowerCase() : '';
  if (r === 'tool' || r === 'tool_result' || r === 'toolresult') return 'tool';
  return r;
}

// ---- 小工具 ------------------------------------------------------------------

/** 摘要行预览：单行化 + 截断（正文全文在展开后的等宽块里）。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '（空）';
  return flat.length > 90 ? flat.slice(0, 90) + '…' : flat;
}

/** 工具的一句话说明（缺省给固定短语，不显示空行）。 */
function oneLine(text: unknown): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s === '' ? '（无说明）' : s;
}

function len(s: unknown): number {
  return typeof s === 'string' ? s.length : 0;
}

/** 千分位整数（字符数 / 条数可读性）。 */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(ratio: number): string {
  const pct = Math.max(0, ratio) * 100;
  return pct >= 10 ? String(Math.round(pct)) : String(Math.round(pct * 10) / 10);
}
