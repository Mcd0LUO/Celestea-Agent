// ============================================================================
// ui/grants/state.ts — 提权通道的模块级状态（W748 从 ui/grants.ts 拆出）。
//   只做搬家：变量所有权、初值、写入时机与拆分前逐字一致。
//   提供读写访问器，避免子模块之间互相 import 造成的循环引用。
// ============================================================================
import type { GrantEntry, GrantsResp } from '../../types';
import type { OverlayHandle } from '../../utils/overlays';
import type { CapDef } from './caps';
import type { GrantPreset } from './presets';
import type { GrantCap } from '../../types';

/** 能力位：unknown = 尚未探测（此期间不显示入口、不发起任何请求）。 */
let capability: 'unknown' | 'on' | 'off' = 'unknown';
let capProbeAt = 0;

let button: HTMLButtonElement | null = null;
let badgeEl: HTMLElement | null = null;
/** W1517：合并入口徽标区里的**档位格**（#slGrantTier；由 statusline/permission.ts 写入）。 */
let tierEl: HTMLElement | null = null;

/** 当前聚焦会话的完整权限数据（盾牌/面板的真源）。 */
let data: GrantsResp | null = null;
let dataSession = '';
/** 面板打开状态。 */
let panel: HTMLElement | null = null;
let panelOverlay: OverlayHandle | null = null;
/** 面板级状态行（成功/失败提示）。 */
let panelNote: { text: string; cls: string } | null = null;
/** 就地校验错误（按能力位）。 */
export const inlineError = new Map<string, string>();
/** 站点/工具文本框草稿（按能力位；重渲染不丢字）。 */
export const drafts = new Map<string, string>();
/**
 * 有效期选择（按能力位）：**0 = 永久（默认，也是主路径）**；
 * 只有用户在「临时授权…」里显式改了时长，这里才会出现非 0 的值（W773）。
 */
export const ttlPick = new Map<string, number>();
/**
 * 「临时授权…」的展开态（按能力位）。W773：主按钮是「授予」（永久），
 * 时长选项收在这一次级入口里，默认不展开；它只影响面板形态，不影响请求体。
 */
export const tempOpen = new Set<string>();

/**
 * 快捷授权预设的执行进度（W751 任务 1c）；null = 没有在跑。
 * 面板据此显示「进行中 i/n」并禁用其它预设按钮（避免并发授予搅乱顺序语义）。
 */
export interface PresetRun {
  id: string;
  /** 当前步骤下标（0 起）。 */
  index: number;
  total: number;
}
let presetRun: PresetRun | null = null;

/**
 * 编排宿主：面板/授予流程调用回编排入口（本文件的调用方 grants.ts），
 * 避免子模块反向 import 入口造成循环引用。
 */
export interface GrantsHost {
  /** 重新读取聚焦会话权限（force=true 时忽略「数据仍新鲜」的短路）。 */
  refresh(force?: boolean): Promise<void>;
  /** 当前聚焦会话 id（空串 = 尚未打开任何会话）。 */
  focusedSession(): string;
  /** 面板整体重绘（离屏构建 + 单次替换）。 */
  renderPanel(): void;
  /** 授予流程（令牌 + 二次确认 + 结果预览）。 */
  startGrant(def: CapDef): Promise<void>;
  /** 撤销（cap=null 表示全部撤销）。 */
  revoke(cap: GrantCap | null): Promise<void>;
}

/**
 * 快捷授权预设的执行入口（W751 任务 1c）。
 *
 * 为什么用「注册」而不是给 GrantsHost 加一个方法：flow.ts 需要 panel.ts 的
 * phraseFor/ttlOf，panel.ts 若反向 import flow.ts 就成环（W748 拆分时正是
 * 用 state.ts 的读写访问器消掉这类环）。flow.ts 在模块加载时把自己的
 * startPreset 注册进来，panel.ts 只经本文件取用 —— 方向仍然是单向的。
 * 若以后允许改编排入口 ui/grants.ts，可把这里换成 GrantsHost.startPreset。
 */
export type PresetRunner = (host: GrantsHost, preset: GrantPreset) => Promise<void>;
let presetRunner: PresetRunner | null = null;

export function setPresetRunner(fn: PresetRunner | null): void {
  presetRunner = fn;
}

export function getPresetRunner(): PresetRunner | null {
  return presetRunner;
}

export function getCapability(): 'unknown' | 'on' | 'off' {
  return capability;
}

export function setCapability(v: 'unknown' | 'on' | 'off'): void {
  capability = v;
}

export function getCapProbeAt(): number {
  return capProbeAt;
}

export function setCapProbeAt(v: number): void {
  capProbeAt = v;
}

export function getShieldButton(): HTMLButtonElement | null {
  return button;
}

export function setShieldButton(v: HTMLButtonElement | null): void {
  button = v;
}

export function getShieldBadge(): HTMLElement | null {
  return badgeEl;
}

export function setShieldBadge(v: HTMLElement | null): void {
  badgeEl = v;
}

export function getShieldTier(): HTMLElement | null {
  return tierEl;
}

export function setShieldTier(v: HTMLElement | null): void {
  tierEl = v;
}

export function getData(): GrantsResp | null {
  return data;
}

export function getDataSession(): string {
  return dataSession;
}

export function setData(v: GrantsResp | null, session: string): void {
  data = v;
  dataSession = session;
}

export function getPanelEl(): HTMLElement | null {
  return panel;
}

export function setPanelEl(v: HTMLElement | null): void {
  panel = v;
}

export function getPanelOverlay(): OverlayHandle | null {
  return panelOverlay;
}

export function setPanelOverlay(v: OverlayHandle | null): void {
  panelOverlay = v;
}

export function getPresetRun(): PresetRun | null {
  return presetRun;
}

export function setPresetRun(v: PresetRun | null): void {
  presetRun = v;
}

// ---- 乐观生效态（W795） --------------------------------------------------------
//
//   为什么单独存在这里而不是改写 data：`data` 是**服务端快照**（盾牌/面板/预览的
//   唯一真源），乐观项只是「用户刚点、请求还在飞」的临时视图。因此：
//     · 渲染层（panel/active.ts）把两者合并成生效集，`data` 本身一个字节都不动；
//     · 请求失败 ⇒ 调用方把这一项摘掉并给出原因（flow.ts），界面回到动作前的样子；
//     · **新鲜快照落定 ⇒ 只作废已被服务端确认的乐观项**（settleOptimistic）：
//         已含该项（授予）⇒ 乐观项冗余，删；
//         已不含该项（撤销）⇒ 乐观项冗余，删；
//         该项请求**早已结束**而快照仍与它矛盾 ⇒ 以服务端为准，删（避免乐观层长期盖住真源）。
//       还有一项在飞的乐观项**不**被竞态快照带走 —— 否则「点完授予马上重开面板 / 20s
//       轮询恰好插进来」会看到已授予→未授予→已授予的闪回（真机 Blink 实测到的竞态）。
//   本模块零 DOM、零网络：check-grants-permanent 会在 node 里直接加载它。

/** 乐观项：`settledAt` = 该项请求结束（成功/失败已定）的时刻；null = 还在飞。 */
interface OptimisticPending {
  settledAt: number | null;
}

/** 乐观授予：cap → 视为已生效的条目（服务端尚未确认）。 */
const optimisticAdds = new Map<GrantCap, { entry: GrantEntry; settledAt: number | null }>();
/** 乐观撤销：这些 cap 先在界面上按「已撤销」画（请求在飞 / 已成功但快照未落定）。 */
const optimisticRemoved = new Map<GrantCap, OptimisticPending>();
/** 乐观「全部撤销」：整块先按「没有任何放宽项」画。 */
let optimisticRevokeAll: OptimisticPending | null = null;

/** 乐观层只读视图（渲染层用；revoked 里的 cap 一律先按已撤销处理）。 */
export interface OptimisticGrantsView {
  granted: GrantEntry[];
  revoked: ReadonlySet<GrantCap>;
  revokeAll: boolean;
}

export function optimisticView(): OptimisticGrantsView {
  return {
    granted: Array.from(optimisticAdds.values(), (a) => a.entry),
    revoked: new Set(optimisticRemoved.keys()),
    revokeAll: optimisticRevokeAll !== null,
  };
}

/** 记一项乐观授予（同一 cap 重复点 = 覆盖；它同时解除该 cap 的乐观撤销）。 */
export function optimisticGrant(cap: GrantCap, entry: GrantEntry): void {
  optimisticAdds.set(cap, { entry, settledAt: null });
  optimisticRemoved.delete(cap);
}

/**
 * 标记「这一项/这次全部撤销的请求已经结束」。
 * 只有它**早于**某次快照的发起时刻，那次快照才有资格否掉这个乐观项（见 settleOptimistic）。
 */
export function optimisticSettle(cap: GrantCap | null): void {
  const at = Date.now();
  if (cap === null) {
    if (optimisticRevokeAll !== null) optimisticRevokeAll.settledAt = at;
    return;
  }
  const add = optimisticAdds.get(cap);
  if (add) add.settledAt = at;
  const removed = optimisticRemoved.get(cap);
  if (removed) removed.settledAt = at;
}

/** 把一项乐观授予摘掉（= 请求失败回滚到动作前：这一项回到服务端快照说的样子）。 */
export function optimisticUngrant(cap: GrantCap): void {
  optimisticAdds.delete(cap);
}

/** 乐观撤销：`cap === null` = 全部撤销。 */
export function optimisticRevoke(cap: GrantCap | null): void {
  if (cap === null) {
    optimisticAdds.clear();
    optimisticRemoved.clear();
    optimisticRevokeAll = { settledAt: null };
    return;
  }
  optimisticAdds.delete(cap);
  optimisticRemoved.set(cap, { settledAt: null });
}

/**
 * 回滚一次乐观撤销。
 *
 * 注意（边界）：单项撤销不恢复「同一 cap 的乐观授予」—— 面板上「撤销」按钮只在
 * 该项已生效时出现，所以「乐观授予 → 同 cap 乐观撤销」这条路径在界面上不可达。
 */
export function optimisticUnrevoke(cap: GrantCap | null): void {
  if (cap === null) {
    optimisticRevokeAll = null;
    optimisticRemoved.clear();
    return;
  }
  optimisticRemoved.delete(cap);
}

/**
 * 新鲜快照落定 ⇒ 作废**已被它确认**的乐观项。
 * `askedAt` = 这次快照请求的**发起**时刻（请求结果只可能反映发起之后的服务端状态）。
 */
export function settleOptimistic(grants: readonly GrantEntry[], askedAt: number): void {
  const have = new Set<string>();
  for (const g of grants) if (typeof g.cap === 'string') have.add(g.cap);
  for (const [cap, add] of Array.from(optimisticAdds)) {
    const confirmed = have.has(cap);
    if (confirmed || (add.settledAt !== null && add.settledAt < askedAt)) optimisticAdds.delete(cap);
  }
  for (const [cap, removed] of Array.from(optimisticRemoved)) {
    const confirmed = !have.has(cap);
    if (confirmed || (removed.settledAt !== null && removed.settledAt < askedAt)) {
      optimisticRemoved.delete(cap);
    }
  }
  if (optimisticRevokeAll !== null) {
    const confirmed = have.size === 0;
    if (confirmed || (optimisticRevokeAll.settledAt !== null && optimisticRevokeAll.settledAt < askedAt)) {
      optimisticRevokeAll = null;
    }
  }
}

/** 乐观层整体作废（换聚焦会话：乐观项只属于当时那个会话）。 */
export function clearOptimistic(): void {
  optimisticAdds.clear();
  optimisticRemoved.clear();
  optimisticRevokeAll = null;
}

export function getPanelNote(): { text: string; cls: string } | null {
  return panelNote;
}

export function setPanelNote(v: { text: string; cls: string } | null): void {
  panelNote = v;
}
