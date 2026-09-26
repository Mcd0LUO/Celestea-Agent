// ============================================================================
// plugins/descriptor.ts — 内建「客户端插件」登记表（W859 · 唯一真源）。
// ----------------------------------------------------------------------------
// 一行 = 一个挂在提示注册缝（ui/hint/registry.ts）或增强缝（ui/enhance/registry.ts）
// 上的提供者：
//   · id 即身份（诊断/持久化/开关/配置都用它，与提供者自身的 id 一致）；
//   · label / hint 是设置页「插件」一格渲染给用户的两个字段（不含实现细节）；
//   · config（W9108）是**通用可选**的可调项描述：插件页按它机械渲染，不认识任何具体插件；
//   · create() 只造提供者对象、**不做注册** —— 注册与记账由 plugins/register.ts
//     统一做，注销器才有人保存（这正是热开关能真注销的前提）。
//
// W9108：内置增强遍（代码高亮 builtin.hljs / 数学 builtin.math）也登记在这里，
// 于是它们复用同一套开关/持久化/回滚记账。它们的**执行顺序**由增强缝的 order 常量
// 声明（见 ui/enhance/registry.ts），不靠注册时机 —— 否则「关掉再打开」会把
// hljs 排到 code-extras 之后，行号会被静默抹掉。
// ============================================================================
import { TEXT_HINT_ID, textCardPlugin } from '../ui/hint/builtin';
import { RAIL_HINT_ID, railHintPlugin } from '../ui/rail';
import type { HintPlugin } from '../ui/hint/registry';
import { CODE_COPY_ID, codeCopyEnhancer } from '../ui/enhance/code-copy';
import { CODE_EXTRAS_ID, CODE_FOLD_LINES, codeExtrasEnhancer, setCodeFoldLines } from '../ui/enhance/code-extras';
import { CSV_TABLE_ID, csvTableEnhancer } from '../ui/enhance/csv-table';
import { IMAGE_ZOOM_ID, imageZoomEnhancer } from '../ui/enhance/image-zoom';
import { HLJS_ENHANCER_ID, MATH_ENHANCER_ID, hljsEnhancer, mathEnhancer } from '../ui/enhance/builtin';
import type { Enhancer } from '../ui/enhance/registry';
import { readNumber, type PluginConfigSpec, type PluginConfigValues } from './config';
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

/** 两种缝共用的登记项字段（开关/持久化/配置与缝无关）。 */
interface ClientPluginCommon {
  /** 提供者身份（与提供者自身的 id 必须是同一个值）。 */
  id: string;
  /** 设置页展示名。 */
  label: string;
  /** 一句话说明开关的后果（用户语言，无实现细节）。 */
  hint: string;
  /** 客户端插件一律支持热开关（宿主插件才是只读的）。 */
  hot: true;
  /** W895-L：插件库分类（浏览/搜索用）。 */
  category: ClientPluginCategory;
  /**
   * W9108：**通用可选**的可调项描述。省略 = 该插件没有可调项，
   * 插件页必须如实呈现（不伪造控件、不写「加载中」）。
   */
  config?: PluginConfigSpec;
  /**
   * W9108：配置生效后的**副作用**（可选）。生效值算好后由 plugins/apply.ts 调用。
   *
   * 为什么需要它：实现住在渲染管线里（例如 code-extras 的折叠阈值），管线不认识
   * 插件配置，所以要有人把值**推**过去。让登记项自带这个回调，apply 层就完全
   * 通用（不出现任何 `if (id === ...)` 分支）。
   */
  onConfig?(values: PluginConfigValues): void;
}

/** 一个可热开关的客户端插件（两种缝共用同一套开关/持久化/回滚）。 */
export type ClientPluginDescriptor =
  | (ClientPluginCommon & { kind: 'hint'; /** 提供者工厂（幂等）。 */ create(): HintPlugin })
  | (ClientPluginCommon & { kind: 'enhancer'; /** 提供者工厂（幂等）。 */ create(): Enhancer });

/** 登记表（顺序 = 设置页展示顺序；函数：文案走 t()）。 */
export function clientPlugins(): readonly ClientPluginDescriptor[] {
  return [
    // W9108：内置两遍排在最前 —— 它们是**基础设施**（过去写死在渲染管线里），
    // 进登记表只是为了可开关，不是「可选显示组件」的语义。
    {
      id: HLJS_ENHANCER_ID,
      label: t('plugins.desc.hljs.label'),
      hint: t('plugins.desc.hljs.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'reading',
      create: () => hljsEnhancer(),
    },
    {
      id: MATH_ENHANCER_ID,
      label: t('plugins.desc.math.label'),
      hint: t('plugins.desc.math.hint'),
      hot: true,
      kind: 'enhancer',
      category: 'reading',
      create: () => mathEnhancer(),
    },
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
      // W9108：**第一个真实可调项**。选它的理由见报告：阈值是纯展示策略，
      // 不同屏幕/不同语言习惯的人答案不同，且它**只影响渲染**（不改数据）。
      config: {
        items: [
          {
            kind: 'number',
            key: 'foldLines',
            labelKey: 'plugins.config.codeExtras.foldLines.label',
            hintKey: 'plugins.config.codeExtras.foldLines.hint',
            def: 30,
            min: 5,
            max: 500,
            step: 5,
          },
        ],
      },
      // 把生效值推给实现（渲染管线里的模块镜像）。**按 key 取值**，不认识控件类型。
      onConfig: (values) => setCodeFoldLines(readNumber(values, 'foldLines', CODE_FOLD_LINES)),
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

/** W9108：按 id 取配置描述（未声明/未知 id ⇒ undefined = 没有可调项）。 */
export function clientPluginConfig(id: string): PluginConfigSpec | undefined {
  return clientPluginById(id)?.config;
}
