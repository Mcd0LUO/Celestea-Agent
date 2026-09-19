// ============================================================================
// i18n/index.ts — 前端 i18n **内核**（零框架、零第三方依赖、模块 ≤400 行）。
// ----------------------------------------------------------------------------
//   · t(key, params?)：只做 {name} 插值，**不做复数/日期**（中英都不需要）；
//   · 字典按语言 + 域拆分（locales/{zh,en}/{common,api}.ts）；
//   · 类型安全：zh 是基准，导出 Key 联合；en 声明为 Record<Key,string> ⇒ 漏译编译期报错；
//   · 语言来源：localStorage → navigator.language（zh* ⇒ 中文，否则英文）→ 默认**中文**；
//   · 切换只通知订阅者重画文案承载节点，**不重建会话**。
// 品牌名与命令名（Celestea Studio / /run / /goal / @）不译，原样出现在两种字典里。
// ============================================================================
import { zh, type Key } from './locales/zh';
import { en } from './locales/en';

export type Locale = 'zh' | 'en';
export type { Key };

const DICTS: Record<Locale, Record<Key, string>> = { zh, en };
const STORAGE_KEY = 'celestea-locale';
const listeners = new Set<() => void>();

/** localStorage → navigator.language → 默认中文。 */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* 隐私模式 / 无 localStorage：继续按系统语言 */
  }
  const nav = typeof navigator !== 'undefined' && navigator.language ? navigator.language : '';
  if (nav === '') return 'zh'; // 取不到系统语言 → 默认中文
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Locale = detectLocale();

/** 当前语言。 */
export function getLocale(): Locale {
  return current;
}

/** 切换语言：持久化 + 通知订阅者（不重建任何会话/DOM 树，由订阅者自行重画文案）。 */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* 存不下也不影响本次会话 */
  }
  for (const cb of listeners) cb();
}

/** 订阅语言变化（返回取消订阅）。 */
export function onLocaleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 取文案；未知 key 回落到中文（运行期兜底，编译期已由 Key 约束）。 */
export function t(key: Key, params?: Record<string, string | number>): string {
  const dict = DICTS[current] ?? zh;
  let s = dict[key] ?? zh[key];
  if (params) {
    for (const name of Object.keys(params)) {
      s = s.split('{' + name + '}').join(String(params[name]));
    }
  }
  return s;
}

/** 某语言的完整字典（诊断/测试：zh 与 en 的 key 集合必须完全一致）。 */
export function localeDict(locale: Locale): Record<Key, string> {
  return DICTS[locale];
}

/** 全部 key（诊断/测试：zh 与 en 必须完全一致）。 */
export function allKeys(): Key[] {
  return Object.keys(zh) as Key[];
}

/** 语言的自称（语言选择器用）。 */
export function localeLabel(locale: Locale): string {
  return locale === 'zh' ? zh['common.language.zh'] : zh['common.language.en'];
}
