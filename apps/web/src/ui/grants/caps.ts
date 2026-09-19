// ============================================================================
// ui/grants/caps.ts — 能力位定义与生效快照的纯读取（W748 从 ui/grants.ts 拆出）
//
//   只做搬家：阈值、数据结构、判定语义与拆分前**逐字一致**。
//   本模块零 DOM、零网络：只有函数 + 纯函数（可在 node 里直接加载）。
//
//   i18n（P1-d/Batch4）：**所有面向用户文案改为惰性函数**（caps()/ttlChoices()/
//   permanentText()…）。绝不能写成 `const X = t(...)` —— 那会固化模块加载时的语言，
//   语言切换后面板徽标/明细/确认/回执全部停在旧语言（真 bug）。
// ============================================================================
import type { EffectiveGrants, GrantCap, GrantEntry, GrantScope } from '../../types';
import { t } from '../../i18n';

/** 危险能力（侧栏红色小盾 + 二次确认，设计 §3.1/§3.3；W751 起不再要求逐字确认词）。 */
export const DANGER_CAPS: ReadonlySet<string> = new Set(['network', 'write_roots', 'unsandboxed']);

/** 每项能力的用户语言定义（名称 / 一句话影响 / 表单形态）。 */
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
   * W819-8：预留能力位 —— 已知且仍可回读/撤销，但**不再对外可授**。
   * 面板只在已有存量条目时渲染它（供撤销），否则不出现。
   */
  reserved?: boolean;
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

/** 能力位定义（函数：文案走 t()，语言切换后必须跟着变）。 */
export function caps(): readonly CapDef[] {
  return [
    {
      cap: 'network',
      label: t('grants.cap.network.label'),
      impact: t('grants.cap.network.impact'),
      extra: t('grants.cap.network.extra'),
      kind: 'bool',
      danger: true,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 3600,
    },
    {
      cap: 'write_roots',
      label: t('grants.cap.writeRoots.label'),
      impact: t('grants.cap.writeRoots.impact'),
      kind: 'dirs',
      danger: true,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 86400,
    },
    {
      cap: 'read_roots',
      label: t('grants.cap.readRoots.label'),
      impact: t('grants.cap.readRoots.impact'),
      kind: 'dirs',
      danger: false,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 86400,
    },
    {
      cap: 'net_hosts',
      label: t('grants.cap.netHosts.label'),
      // W757：站点清单是**并集放宽**（并入放行清单，永不收窄），未配置站点策略的部署下不生效。
      impact: t('grants.cap.netHosts.impact'),
      kind: 'hosts',
      danger: false,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 86400,
    },
    {
      cap: 'tool_extra',
      label: t('grants.cap.toolExtra.label'),
      // W819-8：没有工具暴露面消费它，授予是空操作 —— 不再列为可授。
      impact: t('grants.cap.toolExtra.impact'),
      kind: 'tools',
      danger: false,
      reserved: true,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 86400,
    },
    {
      cap: 'unsandboxed',
      label: t('grants.cap.unsandboxed.label'),
      impact: t('grants.cap.unsandboxed.impact'),
      kind: 'bool',
      danger: true,
      confirmWord: '',
      defaultTtl: 0,
      maxTtl: 900,
    },
  ];
}

/** 能力名 → 定义（每次现取，跟随语言）。 */
export function capByName(): ReadonlyMap<string, CapDef> {
  return new Map(caps().map((c) => [c.cap, c]));
}

/**
 * W819-8：面板真正**可授**的能力位。预留位（tool_extra）仍留在 caps() 里，
 * 以便存量条目能显示与撤销，但绝不出现在可授集合里。
 */
export function offeredCaps(): readonly CapDef[] {
  return caps().filter((c) => c.reserved !== true);
}

/**
 * 有效期选项（秒 → 用户语言标签）。**0 = 永久，且是第一位**（W773：主路径直接授予，
 * 不再强迫用户先选时长）。`sec` 是语义真源；`label` 惰性解析。
 */
export function ttlChoices(): readonly { sec: number; label: string }[] {
  return [
    { sec: 0, label: permanentLabel() }, // 单一真源：与 permanentLabel() 同一条路径（门禁传递覆盖）
    { sec: 900, label: t('grants.ttl.min15') },
    { sec: 1800, label: t('grants.ttl.min30') },
    { sec: 3600, label: t('grants.ttl.hour1') },
    { sec: 86400, label: t('grants.ttl.hour24') },
  ];
}

/** 临时授权可选的时长（不含永久）——只出现在「临时授权…」次级入口里（W773）。 */
export function ttlTempChoices(): readonly { sec: number; label: string }[] {
  return ttlChoices().filter((c) => c.sec > 0);
}

/** 档位标签（现取，跟随语言）。 */
export function ttlLabel(choice: { sec: number; label: string }): string {
  return choice.label;
}

/** 「临时授权」展开时的初始时长（分钟档里最常用的 30 分钟，再按该能力的上限收敛）。 */
export const TEMP_DEFAULT_SEC = 1800;

/** 永久授权的用户语言（函数：唯一真源，语言切换后必须跟着变）。 */
export function permanentLabel(): string {
  return t('grants.permanent.label');
}
/** 永久授权的补充说明（「可随时撤销」：避免读者以为授权不可撤回）。 */
export function permanentNote(): string {
  return t('grants.permanent.note');
}
/** 独立成句的永久短语：'永久（可随时撤销）'。 */
export function permanentText(): string {
  return t('grants.permanent.text');
}
/** 跟在范围明细后面的括号短语：'（永久，可随时撤销）'。 */
export function permanentParen(): string {
  return t('grants.permanent.paren');
}

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
  return isPermanentExpiry(expiresAt)
    ? t('grants.until.permanent')
    : t('grants.until.at', { time: hhmm(expiresAt as number) });
}

/** 括号版到期短语（跟在范围明细后面）：永久 → 「（永久，可随时撤销）」。 */
export function expiryParen(expiresAt: number | null | undefined): string {
  return isPermanentExpiry(expiresAt)
    ? permanentParen()
    : t('grants.until.paren', { time: hhmm(expiresAt as number) });
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
  const list: string[] = [];
  if (!eff) return { count: 0, danger: false, caps: list };
  if (eff.network === true) list.push('network');
  if (listOf(eff.read_roots).length) list.push('read_roots');
  if (listOf(eff.write_roots).length) list.push('write_roots');
  if (listOf(eff.net_hosts).length) list.push('net_hosts');
  if (listOf(eff.tool_extra).length) list.push('tool_extra');
  if (eff.unsandboxed === true) list.push('unsandboxed');
  return { count: list.length, danger: list.some((c) => DANGER_CAPS.has(c)), caps: list };
}
