// ============================================================================
// plugins/server.ts — 显示组件**启用表 + 配置**的服务端线协议（W895-C1 · W9108）。
// ----------------------------------------------------------------------------
//   GET  /api/display-plugins -> { ok, disabled: string[], config?: {id: {key: value}} }
//   PUT  /api/display-plugins   body { disabled: string[], config?: {...} }
// 只做取数与落库；语义（降级/回滚/迁移）在 store.ts。这里不吞错：任何非 2xx 都
// 抛，调用方据此走「如实降级」或「回滚」分支 —— 绝不伪造成功。
//
// W9108：配置**复用同一条端点**（而不是新开一条）。理由见 store.ts 头部。
// config 是**不透明**的（本层不解析、不校验键）：认识插件与其配置项是前端的事
// （与 disabled 只存 id 同一条边界）。
// ============================================================================

/** 服务端响应里被读取的字段。 */
export interface DisplayPluginsWire {
  ok?: boolean;
  /** 服务端返回的原始 disabled 字段（本层已 normalize，类型放宽只为宽容解析）。 */
  disabled?: unknown;
  /** W9108：插件 id -> { 配置项 key -> 字符串值 }；缺失/坏形状按「没配过」处理。 */
  config?: unknown;
}

/** 数组里只留非空字符串（服务端已规范化，这里再兜一层）。 */
function normalize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // 开发者日志（不渲染给用户；copy 门禁只认中文用户文案，这里用英文）。
    throw new Error('display-plugins network error: ' + detail);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error('display-plugins HTTP ' + res.status);
  return data;
}

/** 读服务端启用表 + 配置（失败即抛，由 store 决定降级）。 */
export async function fetchDisplayPlugins(): Promise<DisplayPluginsWire> {
  const data = (await request('/api/display-plugins')) as DisplayPluginsWire | null;
  return { ok: data?.ok === true, disabled: normalize(data?.disabled), config: data?.config };
}

/** 写服务端启用表 + 配置（失败即抛，由 apply 决定回滚）。整表替换语义。 */
export async function saveDisplayPlugins(disabled: readonly string[], config: unknown): Promise<void> {
  await request('/api/display-plugins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: [...disabled], config }),
  });
}
