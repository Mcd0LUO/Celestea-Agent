// ============================================================================
// plugins/descriptor.ts — 内建「客户端插件」登记表（W859 · 唯一真源）。
// ----------------------------------------------------------------------------
// 一行 = 一个挂在提示注册缝（ui/hint/registry.ts）上的提供者：
//   · id 即身份（诊断/持久化/开关都用它，与提供者自身的 id 一致）；
//   · label / hint 是设置页「插件」一格渲染给用户的两个字段（不含实现细节）；
//   · create() 只造提供者对象、**不做注册** —— 注册与记账由 plugins/register.ts
//     统一做，注销器才有人保存（这正是热开关能真注销的前提）。
// 目前两项：内置文字卡片（ui/hint/builtin.ts）与左侧长条预览卡（ui/rail.ts）。
// ============================================================================
import { TEXT_HINT_ID, textCardPlugin } from '../ui/hint/builtin';
import { RAIL_HINT_ID, railHintPlugin } from '../ui/rail';
import type { HintPlugin } from '../ui/hint/registry';

/** 一个可热开关的客户端插件。 */
export interface ClientPluginDescriptor {
  /** 提供者身份（与 HintPlugin.id 必须是同一个值）。 */
  id: string;
  /** 设置页展示名。 */
  label: string;
  /** 一句话说明开关的后果（用户语言，无实现细节）。 */
  hint: string;
  /** 客户端插件一律支持热开关（宿主插件才是只读的）。 */
  hot: true;
  /** 提供者工厂（幂等：可反复调用，每次得到同语义的新实例）。 */
  create(): HintPlugin;
}

/** 登记表（顺序 = 设置页展示顺序）。 */
export const CLIENT_PLUGINS: readonly ClientPluginDescriptor[] = [
  {
    id: TEXT_HINT_ID,
    label: '文字卡片',
    hint: '悬停时统一用卡片显示提示文字；关闭后回退为浏览器自带的提示。',
    hot: true,
    create: () => textCardPlugin(),
  },
  {
    id: RAIL_HINT_ID,
    label: '预览卡片',
    hint: '左侧长条悬停时显示消息预览；关闭后回退为文字卡片。',
    hot: true,
    create: () => railHintPlugin(),
  },
];

/** 全部已知 id（偏好持久化时用它过滤未知项）。 */
export const CLIENT_PLUGIN_IDS: readonly string[] = CLIENT_PLUGINS.map((p) => p.id);

/** 按 id 查登记项（未知 id 返回 null，调用方据此拒绝开关）。 */
export function clientPluginById(id: string): ClientPluginDescriptor | null {
  return CLIENT_PLUGINS.find((p) => p.id === id) ?? null;
}
