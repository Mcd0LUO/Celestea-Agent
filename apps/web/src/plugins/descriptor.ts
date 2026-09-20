// ============================================================================
// plugins/descriptor.ts — 内建「客户端插件」登记表（W859 · 唯一真源）。
// ----------------------------------------------------------------------------
// 一行 = 一个挂在提示注册缝（ui/hint/registry.ts）上的提供者：
//   · id 即身份（诊断/持久化/开关都用它，与提供者自身的 id 一致）；
//   · label / hint 是设置页「插件」一格渲染给用户的两个字段（不含实现细节）；
//   · create() 只造提供者对象、**不做注册** —— 注册与记账由 plugins/register.ts
//     统一做，注销器才有人保存（这正是热开关能真注销的前提）。
// 目前 6 项：2 个提示类 + 4 个增强类（代码复制 P0，代码块增强/表格视图/图片灯箱 C2）。
// ============================================================================
import { TEXT_HINT_ID, textCardPlugin } from '../ui/hint/builtin';
import { RAIL_HINT_ID, railHintPlugin } from '../ui/rail';
import type { HintPlugin } from '../ui/hint/registry';
import { CODE_COPY_ID, codeCopyEnhancer } from '../ui/enhance/code-copy';
import { CODE_EXTRAS_ID, codeExtrasEnhancer } from '../ui/enhance/code-extras';
import { CSV_TABLE_ID, csvTableEnhancer } from '../ui/enhance/csv-table';
import { IMAGE_ZOOM_ID, imageZoomEnhancer } from '../ui/enhance/image-zoom';
import type { Enhancer } from '../ui/enhance/registry';
import { t } from '../i18n';

/** W895：客户端插件挂到哪条缝上。 */
export type ClientPluginKind = 'hint' | 'enhancer';

/**
 * W895-L：插件库的**分类轴**（与 kind 正交）。
 *
 * kind 是「挂到哪条缝」（实现事实，用于装配）；category 是「解决什么问题」
 * （用户语言，用于浏览/搜索）。两者刻意分开：用户找的是「让代码更好读」，
 * 不是「一个 enhancer」。分类是封闭集，新增插件必须选一个。
 */
export type ClientPluginCategory = 'reading' | 'structure' | 'media' | 'interaction';

/** 一个可热开关的客户端插件（两种缝共用同一套开关/持久化/回滚）。 */
export type ClientPluginDescriptor =
  | {
      /** 提供者身份（与 HintPlugin.id 必须是同一个值）。 */
      id: string;
      /** 设置页展示名。 */
      label: string;
      /** 一句话说明开关的后果（用户语言，无实现细节）。 */
      hint: string;
      /** 客户端插件一律支持热开关（宿主插件才是只读的）。 */
      hot: true;
      kind: 'hint';
      /** W895-L：插件库分类（浏览/搜索用）。 */
      category: ClientPluginCategory;
      /** 提供者工厂（幂等：可反复调用，每次得到同语义的新实例）。 */
      create(): HintPlugin;
    }
  | {
      id: string;
      label: string;
      hint: string;
      hot: true;
      kind: 'enhancer';
      /** W895-L：插件库分类（浏览/搜索用）。 */
      category: ClientPluginCategory;
      create(): Enhancer;
    };

/** 登记表（顺序 = 设置页展示顺序）。 */
/** 登记表（顺序 = 设置页展示顺序；函数：文案走 t()）。 */
export function clientPlugins(): readonly ClientPluginDescriptor[] {
  return [
    {
      id: TEXT_HINT_ID,
      label: t('plugins.desc.textCard.label'),
      hint: t('plugins.desc.textCard.hint'),
      hot: true,
      kind: 'hint',
      category: 'interaction',
      create: () => textCardPlugin(),
    },
    {
      id: RAIL_HINT_ID,
      label: t('plugins.desc.railPreview.label'),
      hint: t('plugins.desc.railPreview.hint'),
      hot: true,
      kind: 'hint',
      category: 'reading',
      create: () => railHintPlugin(),
    },
    {
      id: CODE_COPY_ID,
      label: t('plugins.desc.codeCopy.label'),
      hint: t('plugins.desc.codeCopy.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'reading',
      create: () => codeCopyEnhancer(),
    },
    // W895-C2：可选显示组件。顺序即增强链顺序 —— code-copy 先包 .code-wrap，
    // csv 随后用 dataset.structured 标记接管（code-extras 跳过已结构化的块）。

    {
      id: CSV_TABLE_ID,
      label: t('plugins.desc.csvTable.label'),
      hint: t('plugins.desc.csvTable.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'structure',
      create: () => csvTableEnhancer(),
    },
    {
      id: CODE_EXTRAS_ID,
      label: t('plugins.desc.codeExtras.label'),
      hint: t('plugins.desc.codeExtras.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'reading',
      create: () => codeExtrasEnhancer(),
    },
    {
      id: IMAGE_ZOOM_ID,
      label: t('plugins.desc.imageZoom.label'),
      hint: t('plugins.desc.imageZoom.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'media',
      create: () => imageZoomEnhancer(),
    },
  ];
}

/** W895-L：分类的展示顺序（封闭集；设置页按此分组）。 */
export const CLIENT_PLUGIN_CATEGORIES: readonly ClientPluginCategory[] = ['reading', 'structure', 'media', 'interaction'];

/** 分类 → i18n key（文案单一真源在 locales）。返回类型交给 t() 的 Key 联合校验。 */
export function categoryLabelKey(c: ClientPluginCategory): Parameters<typeof t>[0] {
  return ('settings.plugins.cat.' + c) as Parameters<typeof t>[0];
}

/** 全部已知 id（偏好持久化时用它过滤未知项）。 */
export function clientPluginIds(): readonly string[] {
  return clientPlugins().map((p) => p.id);
}

/** 按 id 查登记项（未知 id 返回 null，调用方据此拒绝开关）。 */
export function clientPluginById(id: string): ClientPluginDescriptor | null {
  return clientPlugins().find((p) => p.id === id) ?? null;
}
