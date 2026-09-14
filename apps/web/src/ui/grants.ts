// ============================================================================
// ui/grants.ts — W701 提权通道 UI（本会话权限盾牌）
//
//   入口：状态栏右侧盾牌按钮（index.html #slGrant），三态（设计 §3.1）：
//     未授予 = 灰色空心盾 · 已授予 = 橙实心盾 + 角标数字 · 即将失效(<2min) = 橙盾 + 圆点。
//   面板：复用 utils/overlays 的 Esc 层级栈 + statusline 的 .sl-popup 样式族（§3.2）。
//   危险能力二次确认：ui/confirm.ts 的 confirmDialog({danger:true}) + 输入确认词（§3.3）。
//   结果预览：确认弹窗**原样**展示服务返回的生效快照，绝不自行拼措辞（§3.4）。
//   令牌流程：POST 前先取一次性确认令牌（TTL 60s），带 X-Celestea-Grant-Confirm 头提交（§5.5）。
//   降级：能力位 capabilities.grants !== true → 入口**隐藏**（不置灰报错，§6.5）。
//
//   文案纪律（安全不变量）：所有面向用户的字符串都是**固定常量**，
//   绝不采用工具输出或模型文本中的任何字符串 —— 否则模型可伪造一个无害的
//   「确认」按钮。范围值（路径/站点/工具名）只作为**数据**填入固定句式。
//
//   W748：按职责拆到 ./grants/*，本文件只保留**编排入口**（能力位探针 / 聚焦会话
//   刷新 / 轮询 / 装配）并原样再导出对外 API（import 路径与拆分前兼容）。
//   拆分是纯搬家：无行为变更。
//     ./grants/caps.ts    能力位定义（CAPS/TTL/危险集）与生效快照的纯读取
//     ./grants/scope.ts   范围输入校验（纯函数、零 DOM）
//     ./grants/marks.ts   侧栏叶子标记（按需查询 + 缓存 + 变更事件）
//     ./grants/state.ts   模块级状态（data/panel/inlineError/…）与 GrantsHost 契约
//     ./grants/panel.ts   盾牌三态 + 权限面板（渲染）
//     ./grants/flow.ts    授予流程（令牌 + 二次确认）与撤销
// ============================================================================
import { api, ApiError } from '../api';
import { canonicalScopeJson } from '../security/scope-hash';
import { S } from '../state';
import { activeSessionId, onPaneChange } from './viewctx';
import type { GrantCap } from '../types';
import { DANGER_CAPS, isExpired, type CapDef } from './grants/caps';
import { startGrant, revoke } from './grants/flow';
import { noteProbed, setMark, setMarksEnabled } from './grants/marks';
import { closePanel, renderPanel, renderShield, togglePanel } from './grants/panel';
import {
  getCapability,
  getCapProbeAt,
  getData,
  getDataSession,
  getPanelEl,
  getShieldButton,
  inlineError,
  setCapability,
  setCapProbeAt,
  setData,
  setPanelNote,
  setShieldBadge,
  setShieldButton,
  type GrantsHost,
} from './grants/state';

/** 兼容再导出：形状契约见 security/scope-hash.ts（漂移守护在 tools/check-scope-hash.mjs）。 */
export { canonicalScopeJson };

/** 放宽标记变化事件（侧栏会话叶子订阅；只做局部更新）。 */
export { GRANTS_CHANGED_EVENT } from './grants/marks';

/** 侧栏标记读取 / 按需查询（W748：实现见 ./grants/marks.ts）。 */
export { ensureGrantMarks, grantMarkOf } from './grants/marks';

/** 放宽标记结构（侧栏会话叶子消费）。 */
export type { GrantMark } from './grants/caps';

/** 面板打开时的刷新节奏（秒）；只更新盾牌与面板，不触碰其它视图。 */
const POLL_MS = 20000;

let probeTimer: number | null = null;
let pollTimer: number | null = null;
let wired = false;

/** 子模块回调进编排入口（避免子模块反向 import 本文件造成循环引用）。 */
const HOST: GrantsHost = {
  refresh: (force?: boolean) => refresh(force),
  focusedSession: () => focusedSession(),
  renderPanel: () => renderPanel(HOST),
  startGrant: (def: CapDef) => startGrant(HOST, def),
  revoke: (cap: GrantCap | null) => revoke(HOST, cap),
};

// ---- 能力位（§6.5 降级） --------------------------------------------------------

function applyCapability(on: boolean): void {
  const next = on ? 'on' : 'off';
  if (getCapability() === next) return;
  setCapability(next);
  // 侧栏标记的「能力位未就绪即空操作」判定沿用同一状态（单向镜像）
  setMarksEnabled(on);
  const btn = getShieldButton();
  if (btn) btn.classList.toggle('hidden', !on);
  if (!on) {
    closePanel();
    stopPoll();
    // 入口隐藏即结束：不清空已有标记（避免闪烁），但不再发起任何请求
  } else {
    startPoll();
    void refresh(true);
  }
}

async function probeCapability(force = false): Promise<void> {
  const now = Date.now();
  if (!force && getCapability() !== 'unknown' && now - getCapProbeAt() < 60000) return;
  setCapProbeAt(now);
  try {
    const h = await api.health();
    applyCapability(h.capabilities?.grants === true);
  } catch {
    // 探测失败 = 不能确认可用 → 按不可用处理（不报错、不崩溃）
    applyCapability(false);
  }
}

// ---- 聚焦会话数据 --------------------------------------------------------------

function focusedSession(): string {
  const id = activeSessionId();
  if (id !== '') return id;
  return S.selSession ?? '';
}

async function refresh(force = false): Promise<void> {
  if (getCapability() !== 'on') return;
  const id = focusedSession();
  if (id === '') {
    setData(null, '');
    renderShield();
    if (getPanelEl()) renderPanel(HOST);
    return;
  }
  if (!force && getPanelEl() === null && id === getDataSession() && getData() !== null) {
    renderShield();
    return;
  }
  const asked = id;
  try {
    const r = await api.grants(asked);
    if (asked !== focusedSession()) return; // 竞态：期间已切换会话，丢弃
    setData(r, asked);
    noteProbed(asked);
    const active = (r.grants ?? []).filter((g) => typeof g.cap === 'string' && !isExpired(g));
    const caps = active.map((g) => String(g.cap));
    setMark(asked, { count: active.length, danger: caps.some((c) => DANGER_CAPS.has(c)), caps });
  } catch (err) {
    if (asked !== focusedSession()) return;
    if (err instanceof ApiError && err.status === 0) return; // 不可达：静默保留上次数据
    setData(null, asked);
  }
  renderShield();
  if (getPanelEl()) renderPanel(HOST);
}

function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    void refresh(true);
  }, POLL_MS);
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- 范围哈希（必须与服务端逐字一致 —— 契约见设计 §6.4） ----------------------
//
// 纯函数在 `security/scope-hash.ts`（零 import、零 DOM，可在 node 里直接加载
// 做对拍）。形状/算法与服务端 `apps/studio/src/store/grants.ts` 的
// `canonicalScopeJson` / `canonicalScopeHash` 必须**逐字一致**：任一侧改了形状而
// 另一侧没跟上，就会重现 692f19c 之前「每次授予都 403」的事故。
//
// 漂移守护（改了两侧任意一处都必须机械失败）：
//   contracts/scope-hash-vectors.json（冻结向量，TS 仓）
//   frontend/tools/check-scope-hash.mjs（前端侧，已接进 `pnpm check`）
//   /src/celestea_studio-ts/tests/scope-hash-vectors.test.ts（服务端侧, vitest）

// ---- 装配 ----------------------------------------------------------------------

export function initGrants(): void {
  if (wired) return;
  wired = true;
  setShieldButton(document.getElementById('slGrant') as HTMLButtonElement | null);
  setShieldBadge(document.getElementById('slGrantBadge'));
  const btn = getShieldButton();
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(HOST);
    });
  }
  // 点击面板外 / 盾牌外 → 收起（与 statusline 的弹层行为一致）
  document.addEventListener('click', (e) => {
    if (!getPanelEl()) return;
    const t = e.target as Node;
    if (getPanelEl()!.contains(t)) return;
    if (btn && btn.contains(t)) return;
    closePanel();
  });
  // 切换聚焦会话 → 换一份数据（盾牌与面板同步）
  onPaneChange(() => {
    inlineError.clear();
    setPanelNote(null);
    if (getCapability() === 'on') void refresh(true);
  });
  // 回到页面时补一次（长时间后台期间可能已过期）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh(true);
  });
  void probeCapability(true);
  // 能力位可能随后续部署就绪：低频复探（不可用时不做任何其它请求）
  probeTimer = window.setInterval(() => {
    if (getCapability() === 'off') void probeCapability(true);
  }, 60000);
}

/** 测试/自检用：当前能力位。 */
export function grantsCapability(): 'unknown' | 'on' | 'off' {
  return getCapability();
}

/** 测试用：清理定时器（页面卸载/自检）。 */
export function stopGrants(): void {
  stopPoll();
  if (probeTimer !== null) {
    window.clearInterval(probeTimer);
    probeTimer = null;
  }
}
