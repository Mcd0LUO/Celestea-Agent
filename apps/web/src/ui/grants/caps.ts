// ============================================================================
// ui/grants/caps.ts — 能力位定义与生效快照的纯读取（W748 从 ui/grants.ts 拆出）
//
//   只做搬家：文案、阈值、数据结构、判定语义与拆分前**逐字一致**。
//   本模块零 DOM、零网络：只有常量 + 纯函数（可在 node 里直接加载）。
// ============================================================================
import type { EffectiveGrants, GrantCap, GrantEntry, GrantScope } from '../../types';

/** 危险能力（侧栏红色小盾 + 二次确认，设计 §3.1/§3.3；W751 起不再要求逐字确认词）。 */
export const DANGER_CAPS: ReadonlySet<string> = new Set(['network', 'write_roots', 'unsandboxed']);

/** 每项能力的用户语言定义（名称 / 一句话影响 / 表单形态；文案逐字取自设计 §3.2）。 */
export interface CapDef {
  cap: GrantCap;
  label: string;
  impact: string;
  /** 追加的影响说明（如「撤销前一直有效」）。 */
  extra?: string;
  /** bool = 无范围；dirs = 选目录；hosts = 站点文本框；tools = 工具名文本框。 */
  kind: 'bool' | 'dirs' | 'hosts' | 'tools';
  danger: boolean;
  /**
   * 需要逐字输入的确认词（设计 §3.3）；空串 = 只需点击确认。
   * @deprecated W751：授予不再要求逐字输入确认词（只保留一次点击确认），
   *   本字段恒为空串，仅为结构兼容保留；新代码不要读取它，也不要再填值。
   */
  confirmWord: string;
  /**
   * 授权的默认有效期（秒）；**0 = 永久（W773 起的默认路径）**。
   * 只有用户在「临时授权…」里显式选了时长，请求体才带非 0 的 `ttl_sec`。
   */
  defaultTtl: number;
  /** 临时授权的时长上限（秒）；服务返回 max_ttl_sec 时以服务端值为准（§2.3）。 */
  maxTtl: number;
}

export const CAPS: readonly CapDef[] = [
  {
    cap: 'network',
    label: '访问网络',
    impact: '允许会话中运行的命令访问互联网与内网（含本机服务）。',
    extra: '⚠ 撤销前一直有效。',
    kind: 'bool',
    danger: true,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 3600,
  },
  {
    cap: 'write_roots',
    label: '额外可写目录',
    impact: '允许会话在所选目录中创建与修改文件。',
    kind: 'dirs',
    danger: true,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 86400,
  },
  {
    cap: 'read_roots',
    label: '额外只读目录',
    impact: '允许会话读取该目录内的文件（不能修改）。',
    kind: 'dirs',
    danger: false,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 86400,
  },
  {
    cap: 'net_hosts',
    label: '访问指定网站',
    // W757：原文案「只对下面列出的站点生效」是错误暗示 —— 站点清单是**并集放宽**
    // （并入放行清单，永不收窄），且在未配置站点策略的部署下完全不生效。
    impact: '把下列站点加入会话的网络放行清单（并集放宽，不会收窄；是否生效取决于部署的站点策略）。',
    kind: 'hosts',
    danger: false,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 86400,
  },
  {
    cap: 'tool_extra',
    label: '启用额外工具',
    impact: '启用默认未开放的额外工具（不放行已被拒绝的操作）。',
    kind: 'tools',
    danger: false,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 86400,
  },
  {
    cap: 'unsandboxed',
    label: '降低隔离运行',
    impact: '允许会话中的命令不经额外隔离运行。',
    kind: 'bool',
    danger: true,
    confirmWord: '',
    defaultTtl: 0,
    maxTtl: 900,
  },
];

export const CAP_BY_NAME = new Map<string, CapDef>(CAPS.map((c) => [c.cap, c]));

/**
 * 有效期选项（秒 → 用户语言标签）。**0 = 永久，且是第一位**（W773：主路径直接授予，
 * 不再强迫用户先选时长）。
 */
export const TTL_CHOICES: readonly { sec: number; label: string }[] = [
  { sec: 0, label: '永久' },
  { sec: 900, label: '15 分钟' },
  { sec: 1800, label: '30 分钟' },
  { sec: 3600, label: '1 小时' },
  { sec: 86400, label: '24 小时' },
];

/** 临时授权可选的时长（不含永久）——只出现在「临时授权…」次级入口里（W773）。 */
export const TTL_TEMP_CHOICES: readonly { sec: number; label: string }[] = TTL_CHOICES.filter(
  (c) => c.sec > 0,
);

/** 「临时授权」展开时的初始时长（分钟档里最常用的 30 分钟，再按该能力的上限收敛）。 */
export const TEMP_DEFAULT_SEC = 1800;

/** 永久授权的用户语言（唯一真源：面板徽标/明细/确认/回执都取自这里）。 */
export const PERMANENT_LABEL = '永久';
/** 永久授权的补充说明（「可随时撤销」：避免读者以为授权不可撤回）。 */
export const PERMANENT_NOTE = '可随时撤销';
/** 独立成句的永久短语：'永久（可随时撤销）'。 */
export const PERMANENT_TEXT = PERMANENT_LABEL + '（' + PERMANENT_NOTE + '）';
/** 跟在范围明细后面的括号短语：'（永久，可随时撤销）'。 */
export const PERMANENT_PAREN = '（' + PERMANENT_LABEL + '，' + PERMANENT_NOTE + '）';
export interface GrantMark {
  /** 生效条数（已过期的不计，设计 §3.2）。 */
  count: number;
  /** 是否含危险能力（侧栏红盾）。 */
  danger: boolean;
  caps: string[];
}
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** unix 秒 → 本地 HH:MM（面板徽标与确认文案共用）。 */
export function hhmm(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 该条授权是否永久（W773）：`expires_at` 为空/非正 = 永久。
 *
 * 服务端 `ttl_sec: 0` 写的就是 `expires_at: null`（`handlers/grants.ts`），
 * `isExpired` 对 null 永不为真 —— 所以永久条目只会被**撤销**收回。
 */
export function isPermanentExpiry(expiresAt: number | null | undefined): boolean {
  return !(typeof expiresAt === 'number' && expiresAt > 0);
}

/**
 * 到期短语（接在「此授权…」后面）：
 *   永久 → 「撤销前一直有效」；有期限 → 「至 HH:MM」。
 * 唯一真源：确认弹窗与面板明细都取这里，永久文案不会在某处退化成时间。
 */
export function untilPhrase(expiresAt: number | null | undefined): string {
  return isPermanentExpiry(expiresAt) ? '撤销前一直有效' : '至 ' + hhmm(expiresAt as number);
}

/** 括号版到期短语（跟在范围明细后面）：永久 → 「（永久，可随时撤销）」。 */
export function expiryParen(expiresAt: number | null | undefined): string {
  return isPermanentExpiry(expiresAt) ? PERMANENT_PAREN : '（至 ' + hhmm(expiresAt as number) + '）';
}

/** 生效条数：已过期的不计入（§3.2 / §3.1）。 */
export function isExpired(g: GrantEntry): boolean {
  if (g.expired === true) return true;
  if (typeof g.expires_at === 'number' && g.expires_at > 0) return g.expires_at <= nowSec();
  return false;
}

export function scopeOf(g: GrantEntry | null): GrantScope {
  return g && g.scope && typeof g.scope === 'object' ? g.scope : {};
}

export function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 生效快照 → 侧栏标记（不含过期项）。 */
export function markFromEffective(eff: EffectiveGrants | undefined): GrantMark {
  const caps: string[] = [];
  if (!eff) return { count: 0, danger: false, caps };
  if (eff.network === true) caps.push('network');
  if (listOf(eff.read_roots).length) caps.push('read_roots');
  if (listOf(eff.write_roots).length) caps.push('write_roots');
  if (listOf(eff.net_hosts).length) caps.push('net_hosts');
  if (listOf(eff.tool_extra).length) caps.push('tool_extra');
  if (eff.unsandboxed === true) caps.push('unsandboxed');
  return { count: caps.length, danger: caps.some((c) => DANGER_CAPS.has(c)), caps };
}
