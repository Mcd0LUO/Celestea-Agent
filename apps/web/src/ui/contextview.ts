// ============================================================================
// ui/contextview.ts — W726：只读「完整上下文」浮层（点状态栏上下文圆环打开）。
//
//   用途：让用户看清**模型本轮实际看到的内容**——系统提示词全文、工具清单
//   （含参数结构）、消息流（用户 / 助手 / 工具结果，带序号与字符数）与用量。
//   纯只读：无输入框、无编辑、无提交。
//
//   基建沿用既有约定：
//     - 挂到 body 的浮层压入 utils/overlays 层级栈（一次 Esc 只关栈顶一层）；
//     - 铁律 1/8：正文先离屏构建，就绪后单次 replaceChildren，绝不逐条清空重建；
//       W795：**不写任何「读取中」占位** —— 顶栏/页脚骨架当帧就位（打开即响应），
//       正文在数据到达前保持为空（它没有可推断的终态：内容本身就是服务端数据）；
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
import { t } from '../i18n';

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
  head.appendChild(el('span', 'ctx-title', t('chat.ctx.title')));
  head.appendChild(el('span', 'ctx-tag', t('chat.ctx.readonly')));
  const closeBtn = el('button', 'btn btn-soft btn-mini ctx-close', t('chat.ctx.close')) as HTMLButtonElement;
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

  // W795：正文容器当帧就位、内容为空 —— 不写占位文案；数据到达后单次换入。
  const body = el('div', 'ctx-body');
  card.appendChild(body);

  const foot = el('div', 'ctx-foot', t('chat.ctx.foot'));
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
          ? t('chat.ctx.footWithSession', { id: res.session })
          : t('chat.ctx.foot')) +
        (res.truncated === true ? t('chat.ctx.truncatedSuffix') : '');
    })
    .catch((err: unknown) => {
      if (!alive()) return; // 浮层已关闭：不打扰用户
      body.replaceChildren(
        el('div', 'ctx-error', userErrorText(err, t('chat.ctx.loadFailed'))),
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
  modelEl.title = t('chat.ctx.currentModel', { model });

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
  usageEl.title = t('chat.ctx.usageTitle');
  if (c.estimated === true) usageEl.appendChild(el('span', 'ctx-badge', t('chat.ctx.estimated')));

  const n = res.counts ?? {};
  const sysChars = typeof n.system_chars === 'number' ? n.system_chars : len(res.system);
  const tools = typeof n.tool_count === 'number' ? n.tool_count : (res.tools ?? []).length;
  const msgs = typeof n.message_count === 'number' ? n.message_count : (res.messages ?? []).length;
  countsEl.textContent = t('chat.ctx.counts', { sys: fmtInt(sysChars), tools, msgs });
  countsEl.title = t('chat.ctx.countsTitle');
}

// ---- 系统提示词 --------------------------------------------------------------

function renderSystem(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const text = typeof res.system === 'string' ? res.system : '';
  const det = document.createElement('details');
  det.className = 'ctx-fold ctx-fold-sys';
  det.open = true; // 系统提示词默认展开；其余默认折叠，用户按需展开
  const sum = el('summary', 'ctx-fold-head');
  sum.appendChild(el('span', 'ctx-fold-name', t('chat.ctx.systemPrompt')));
  sum.appendChild(el('span', 'ctx-count', t('chat.ctx.chars', { n: fmtInt(text.length) })));
  det.appendChild(sum);
  const pre = el('pre', 'ctx-pre ctx-pre-sys');
  pre.textContent = text === '' ? t('chat.ctx.empty') : text;
  det.appendChild(pre);
  sec.appendChild(det);
  return sec;
}

// ---- 工具清单 ----------------------------------------------------------------

function renderTools(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const tools: ContextToolInfo[] = Array.isArray(res.tools) ? res.tools : [];

  const head = el('div', 'ctx-sec-head');
  head.appendChild(el('span', 'ctx-sec-name', t('chat.ctx.toolList')));
  head.appendChild(el('span', 'ctx-count', t('chat.ctx.count', { n: tools.length })));
  if (tools.some((t) => t.truncated === true)) {
    head.appendChild(el('span', 'ctx-badge', t('chat.ctx.partialTruncated')));
  }
  sec.appendChild(head);

  if (!tools.length) {
    sec.appendChild(el('div', 'ctx-note', t('chat.ctx.noTools')));
    return sec;
  }

  const list = el('div', 'ctx-tools');
  tools.forEach((tool, i) => {
    const det = document.createElement('details');
    det.className = 'ctx-fold ctx-tool';
    const sum = el('summary', 'ctx-tool-head');
    sum.appendChild(el('span', 'ctx-tool-idx', '#' + (i + 1)));
    sum.appendChild(el('span', 'ctx-tool-name', tool.name || t('chat.ctx.unnamed')));
    sum.appendChild(el('span', 'ctx-tool-desc', oneLine(tool.description)));
    if (tool.truncated === true) sum.appendChild(el('span', 'ctx-badge', t('chat.ctx.truncatedBadge')));
    det.appendChild(sum);

    const pre = el('pre', 'ctx-pre ctx-pre-schema');
    pre.textContent = schemaText(tool.parameters);
    det.appendChild(pre);
    list.appendChild(det);
  });
  sec.appendChild(list);
  return sec;
}

function schemaText(params: unknown): string {
  if (params === undefined || params === null) return t('chat.ctx.noSchema');
  if (typeof params === 'string') return params === '' ? t('chat.ctx.noSchema') : params;
  try {
    return JSON.stringify(params, null, 2) ?? t('chat.ctx.noSchema');
  } catch {
    return t('chat.ctx.schemaUnavailable');
  }
}

// ---- 消息流 ------------------------------------------------------------------

/** 分组顺序：用户 → 助手 → 工具结果；未知 role 各自成组放在末尾。 */
function roleGroups(): readonly { key: string; label: string }[] {
  return [
    { key: 'user', label: t('chat.ctx.roleUser') },
    { key: 'assistant', label: t('chat.ctx.roleAssistant') },
    { key: 'tool', label: t('chat.ctx.roleTool') },
  ];
}

interface MsgRef {
  m: ContextMessage;
  /** 在原始消息流中的位置（0 基）：显示为 #(idx+1)，保留真实顺序信息。 */
  idx: number;
}

function renderMessages(res: SessionContextResp): HTMLElement {
  const sec = el('section', 'ctx-sec');
  const msgs: ContextMessage[] = Array.isArray(res.messages) ? res.messages : [];

  const head = el('div', 'ctx-sec-head');
  head.appendChild(el('span', 'ctx-sec-name', t('chat.ctx.messages')));
  head.appendChild(el('span', 'ctx-count', t('chat.ctx.countItems', { n: msgs.length })));
  if (msgs.some((m) => m.truncated === true)) {
    head.appendChild(el('span', 'ctx-badge', t('chat.ctx.partialTruncated')));
  }
  sec.appendChild(head);

  if (!msgs.length) {
    sec.appendChild(el('div', 'ctx-note', t('chat.ctx.noMessages')));
    return sec;
  }

  for (const g of roleGroups()) {
    const items: MsgRef[] = [];
    msgs.forEach((m, i) => {
      if (roleKey(m) === g.key) items.push({ m, idx: i });
    });
    if (items.length) sec.appendChild(renderGroup(g.label, items));
  }

  const extras = new Map<string, MsgRef[]>();
  msgs.forEach((m, i) => {
    const key = roleKey(m);
    if (roleGroups().some((g) => g.key === key)) return;
    const list = extras.get(key);
    if (list) list.push({ m, idx: i });
    else extras.set(key, [{ m, idx: i }]);
  });
  for (const [key, items] of extras) sec.appendChild(renderGroup(key === '' ? t('chat.ctx.roleOther') : key, items));
  return sec;
}

function renderGroup(label: string, items: readonly MsgRef[]): HTMLElement {
  const group = el('div', 'ctx-group');
  const gh = el('div', 'ctx-group-head');
  gh.appendChild(el('span', 'ctx-group-name', label));
  gh.appendChild(el('span', 'ctx-count', t('chat.ctx.countItems', { n: items.length })));
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
    sum.appendChild(el('span', 'ctx-count', t('chat.ctx.chars', { n: fmtInt(text.length) })));
    if (m.truncated === true) sum.appendChild(el('span', 'ctx-badge', t('chat.ctx.truncatedBadge')));
    sum.appendChild(el('span', 'ctx-msg-preview', preview(text)));
    if (typeof m.tool_call_id === 'string' && m.tool_call_id !== '') {
      sum.title = t('chat.ctx.callId', { id: m.tool_call_id });
    }
    det.appendChild(sum);
    const pre = el('pre', 'ctx-pre ctx-pre-msg');
    pre.textContent = text === '' ? t('chat.ctx.empty') : text;
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
  if (flat === '') return t('chat.ctx.empty');
  return flat.length > 90 ? flat.slice(0, 90) + '…' : flat;
}

/** 工具的一句话说明（缺省给固定短语，不显示空行）。 */
function oneLine(text: unknown): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s === '' ? t('chat.ctx.noDescription') : s;
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
