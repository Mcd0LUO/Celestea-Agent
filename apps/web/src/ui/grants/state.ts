// ============================================================================
// ui/grants/state.ts — 提权通道的模块级状态（W748 从 ui/grants.ts 拆出）。
//   只做搬家：变量所有权、初值、写入时机与拆分前逐字一致。
//   提供读写访问器，避免子模块之间互相 import 造成的循环引用。
// ============================================================================
import type { GrantsResp } from '../../types';
import type { OverlayHandle } from '../../utils/overlays';
import type { CapDef } from './caps';
import type { GrantPreset } from './presets';
import type { GrantCap } from '../../types';

/** 能力位：unknown = 尚未探测（此期间不显示入口、不发起任何请求）。 */
let capability: 'unknown' | 'on' | 'off' = 'unknown';
let capProbeAt = 0;

let button: HTMLButtonElement | null = null;
let badgeEl: HTMLElement | null = null;

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

export function getPanelNote(): { text: string; cls: string } | null {
  return panelNote;
}

export function setPanelNote(v: { text: string; cls: string } | null): void {
  panelNote = v;
}
