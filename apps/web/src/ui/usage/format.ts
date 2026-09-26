// ============================================================================
// ui/usage/format.ts — 「使用统计」的数字/日期格式化（纯函数，零 DOM）。
// ----------------------------------------------------------------------------
//   为什么不用 utils/dom.ts 的 fmtCompact：它把单位写死成 K/M/B（英文口径），
//   中文界面下「48万」比「482.8K」好读。这里交给 Intl 按当前语言出单位，
//   于是中英各自拿到自己习惯的数量级写法，且不需要在字典里堆单位词。
//
//   日期一律按 **UTC** 解释：账本 `day` 维度的 key 就是 UTC 日期
//   （`new Date(ts*1000).toISOString().slice(0,10)`），用本地时区去格式化
//   会让「9 月 19 日」在西半球显示成 9 月 18 日。
// ============================================================================
import { t } from '../../i18n';

/** 千分位紧凑数字：≥1000 走紧凑单位（1.2K / 48万），否则原样。非法值 → `—`。 */
export function formatCompact(locale: string, value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0,
  }).format(value);
}

/**
 * 摘要条里的 token 数：紧凑写法 + 单位。
 *   中文的紧凑单位会直接贴在数字后面（48万），与相邻的时长/天数指标并排时
 *   显得挤，故在数字与「万/亿」之间补一个空格（照参考实现的做法）。
 */
export function formatTokens(locale: string, value: number): string {
  const text = formatCompact(locale, value);
  const spaced = locale.startsWith('zh') ? text.replace(/(?<=\d)(?=[万亿])/u, ' ') : text;
  return spaced + ' ' + t('usage.unit.tokens');
}

/** 只要数字部分（摘要条的大字），单位由调用方另行排版。 */
export function formatTokenCount(locale: string, value: number): string {
  const text = formatCompact(locale, value);
  return locale.startsWith('zh') ? text.replace(/(?<=\d)(?=[万亿])/u, ' ') : text;
}

/** 短日期（9月19日 / Sep 19）。非法 key 原样返回，绝不抛错。 */
export function formatDay(locale: string, dateKey: string | null): string {
  const date = parseUtc(dateKey);
  if (date === null) return dateKey ?? '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** 完整日期（2026年9月19日 / September 19, 2026）—— tooltip 用。 */
export function formatFullDay(locale: string, dateKey: string | null): string {
  const date = parseUtc(dateKey);
  if (date === null) return dateKey ?? '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** 月份短名（9月 / Sep）。非法 key 回落成月份数字。 */
export function formatMonth(locale: string, dateKey: string): string {
  const date = parseUtc(dateKey);
  if (date === null) return dateKey.slice(5, 7);
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short' }).format(date);
}

/** `YYYY-MM-DD` → UTC Date；非法返回 null（调用方决定怎么显示，不抛错）。 */
export function parseUtc(dateKey: string | null): Date | null {
  if (typeof dateKey !== 'string' || dateKey === '') return null;
  const ms = Date.parse(dateKey + 'T00:00:00.000Z');
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 天数：`3 天` / `3 d`。 */
export function formatDays(locale: string, days: number): string {
  return formatCompact(locale, days) + ' ' + t('usage.unit.day');
}

/**
 * 时长：`2 小时 5 分钟`（照参考实现：天/时/分三段，全 0 时给 `0 分钟`，
 * 不显示无意义的「0 天 0 小时」）。`null` = 数据源答不了 ⇒ `—`，不编 0。
 */
export function formatDuration(locale: string, durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return '—';
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(formatCompact(locale, days) + ' ' + t('usage.unit.day'));
  if (hours > 0) parts.push(formatCompact(locale, hours) + ' ' + t('usage.unit.hour'));
  if (minutes > 0 || parts.length === 0) {
    parts.push(formatCompact(locale, minutes) + ' ' + t('usage.unit.minute'));
  }
  return parts.join(' ');
}
