// ============================================================================
// plugins/config.ts — 客户端插件的**通用配置描述**（W9108 · 唯一真源）。
// ----------------------------------------------------------------------------
// 目标（用户原话「所有注册的插件应该都有个可调节的配置」）：任何插件都能声明自己的
// 可调项，设置页**按描述机械渲染**，不认识任何具体插件。
//
// 本模块只有「数据形状 + 纯函数」：零 DOM、零 i18n 运行时、零网络 —— 于是
// 「每种控件都能从描述渲染出来」与「坏数据怎么收」都能用纯函数钉死。
//
// 为什么值一律用**字符串**：
//   · 启用表是 JSON 契约（服务端只存字符串），字符串化后往返无类型歧义；
//   · 边界（空串 / NaN / 越界 / 枚举越界）可以逐条断言，不用先猜类型；
//   · 布尔用 'on' / 'off' 两个显式字面量，不用 '' 之类靠 falsy 的写法。
//
// 控件类型是**闭集**（bool / enum / text / number）。渲染器按 kind 分派，
// **禁止**对插件 id 做 if/else（那是「不认识具体插件」的反面，测试用假 descriptor 钉住）。
// ============================================================================
import type { Key } from '../i18n';

/** 配置值：一律字符串（布尔 = 'on'/'off'，数字 = 十进制文本）。 */
export type PluginConfigValue = string;

/** 布尔的两态字面量（不用空串/真值表兜底 —— 服务端存的就是这两个）。 */
export const CONFIG_ON = 'on';
export const CONFIG_OFF = 'off';

/** 枚举的一个选项（value 落库，labelKey 走 t()）。 */
export interface PluginConfigOption {
  value: string;
  labelKey: Key;
}

interface PluginConfigBase {
  /** 项身份：同一插件内唯一，落库时作子键。 */
  key: string;
  /** 展示名（i18n key；渲染器只做 t()，不拼字符串）。 */
  labelKey: Key;
  /** 可选的一句话说明。 */
  hintKey?: Key;
}

/** 布尔开关（渲染成勾选框）。 */
export interface PluginConfigBool extends PluginConfigBase {
  kind: 'bool';
  def: boolean;
}
/** 枚举/单选（渲染成下拉框；options 至少一项）。 */
export interface PluginConfigEnum extends PluginConfigBase {
  kind: 'enum';
  options: readonly PluginConfigOption[];
  def: string;
}
/** 字符串（渲染成单行文本框；可选长度上限）。 */
export interface PluginConfigText extends PluginConfigBase {
  kind: 'text';
  def: string;
  maxLength?: number;
}
/** 数字（渲染成数字框；min/max/step 与默认值都进描述）。 */
export interface PluginConfigNumber extends PluginConfigBase {
  kind: 'number';
  def: number;
  min?: number;
  max?: number;
  step?: number;
}

/** 一个可调项（闭集四型）。 */
export type PluginConfigItem = PluginConfigBool | PluginConfigEnum | PluginConfigText | PluginConfigNumber;

/** 一个插件的配置描述（items 为空 = 该插件没有可调项，界面必须如实呈现）。 */
export interface PluginConfigSpec {
  items: readonly PluginConfigItem[];
}

/** 一个插件的值表：item.key -> 值。 */
export type PluginConfigValues = Record<string, PluginConfigValue>;
/** 全部插件的值表：插件 id -> 值表。 */
export type PluginConfigMap = Record<string, PluginConfigValues>;

/** 描述里有没有可调项（渲染器据此画「无可调项」的如实态，不伪造控件）。 */
export function hasConfigItems(spec: PluginConfigSpec | undefined): boolean {
  return spec !== undefined && spec.items.length > 0;
}

/** 单项的默认值（字符串形态）。 */
export function defaultOf(item: PluginConfigItem): string {
  switch (item.kind) {
    case 'bool':
      return item.def ? CONFIG_ON : CONFIG_OFF;
    case 'number':
      // W9202：描述里的 def 也可能越界（作者笔误）。走**同一把尺子**（clampNumber），
      // 否则控件初值会显示一个保存后被夹掉的数，前后不一致。
      return clampNumber(item, String(item.def));
    case 'enum':
      // W9202：def 不在 options 里时回落第一项 —— 控件能显示的值必须也是能存下去的值。
      // （options 为空是描述违规，契约要求「至少一项」；这里只保证不抛错。）
      return item.options.some((o) => o.value === item.def) ? item.def : (item.options[0]?.value ?? '');
    case 'text':
      return item.def;
  }
}

/** 数字项：夹进 [min, max]，非有限值回落默认值。 */
function clampNumber(item: PluginConfigNumber, raw: string): string {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return String(item.def);
  const lo = item.min ?? Number.NEGATIVE_INFINITY;
  const hi = item.max ?? Number.POSITIVE_INFINITY;
  return String(Math.min(hi, Math.max(lo, n)));
}

/**
 * 把任意字符串收进该项的合法域（渲染与落库**共用同一口径**，所以界面上显示的
 * 一定是能存下去的值）。不认识的值回落默认值 —— 不抛错、不猜。
 */
export function normalizeItem(item: PluginConfigItem, raw: string): string {
  switch (item.kind) {
    case 'bool':
      return raw === CONFIG_ON || raw === CONFIG_OFF ? raw : defaultOf(item);
    case 'enum':
      return item.options.some((o) => o.value === raw) ? raw : defaultOf(item);
    case 'number':
      return clampNumber(item, raw);
    case 'text':
      return item.maxLength === undefined ? raw : raw.slice(0, item.maxLength);
  }
}

/** 全部项的默认值表。 */
export function configDefaults(spec: PluginConfigSpec): PluginConfigValues {
  const out: PluginConfigValues = {};
  for (const item of spec.items) out[item.key] = defaultOf(item);
  return out;
}

/**
 * 宽容解析**已保存**的值（读盘/读服务端用）：
 *   · 不是对象 / 键不认识 / 值不是字符串 ⇒ 跳过（用默认值）；
 *   · 认得的键也走 normalizeItem（枚举越界、数字越界、超长文本都在这里收口）。
 * 绝不抛错：坏数据 = 用默认值，不是崩溃，也不是「假装已保存」。
 */
export function parseConfigValues(raw: unknown, spec: PluginConfigSpec): PluginConfigValues {
  const out: PluginConfigValues = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const item of spec.items) {
    const value = rec[item.key];
    if (typeof value !== 'string' || value === '') continue;
    out[item.key] = normalizeItem(item, value);
  }
  return out;
}

/** 生效值 = 默认值 + 已保存值（已保存的优先）。渲染与插件实现读的都是它。
 *
 * W9202：这里**复用 parseConfigValues**（而不是再写一遍同样的循环）——
 * 那正是「读路径归一化」的唯一实现。此前两者并存且只有本函数被调用，
 * parseConfigValues 成了无人调用的死代码（改它不会影响任何行为）。 */
export function effectiveConfig(spec: PluginConfigSpec, saved: PluginConfigValues | undefined): PluginConfigValues {
  return { ...configDefaults(spec), ...parseConfigValues(saved, spec) };
}

/** 从值表读数字（缺失/非有限 ⇒ fallback）。插件实现用。 */
export function readNumber(values: PluginConfigValues, key: string, fallback: number): number {
  const raw = values[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 从值表读布尔（缺失 ⇒ fallback）。插件实现用。 */
export function readBool(values: PluginConfigValues, key: string, fallback: boolean): boolean {
  const raw = values[key];
  if (raw === undefined) return fallback;
  return raw === CONFIG_ON;
}

/** 从值表读字符串（缺失 ⇒ fallback）。插件实现用。 */
export function readText(values: PluginConfigValues, key: string, fallback: string): string {
  const raw = values[key];
  return raw === undefined ? fallback : raw;
}
