// ============================================================================
// ui/plugins/host.ts — 宿主（服务端）插件清单的取数与**宽容解析**（W859 只读半边）。
// ----------------------------------------------------------------------------
// GET /api/plugins 由后续任务补；本次必须优雅降级：端点缺失（404/405）/网络不可达
// 时由渲染层显示如实的空态，**绝不伪造清单**。
// 解析只认能确认的字符串字段（name 或 id 作名字，version/description 作补充），
// 不认识的结构整项忽略 —— 不假设字段、不造默认值。
// ============================================================================
import { api } from '../../api';

/** 一行宿主插件（只读呈现用）。 */
export interface HostPluginRow {
  name: string;
  version: string;
  note: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 响应可能直接是数组，也可能是 { plugins: [...] }；两者都不是 → 空（不猜）。 */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return [];
  const inner = (payload as { plugins?: unknown }).plugins;
  return Array.isArray(inner) ? inner : [];
}

/** 纯函数：宽容解析宿主清单（认不出名字的项忽略）。 */
export function hostPluginRows(payload: unknown): HostPluginRow[] {
  const rows: HostPluginRow[] = [];
  for (const item of listOf(payload)) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = text(o['name']) || text(o['id']);
    if (name === '') continue;
    rows.push({ name, version: text(o['version']), note: text(o['description']) });
  }
  return rows;
}

/** 拉取宿主清单；端点缺失/网络失败时抛 ApiError（调用方按空态降级，不重试、不伪造）。 */
export async function fetchHostPlugins(): Promise<HostPluginRow[]> {
  return hostPluginRows(await api.plugins());
}
