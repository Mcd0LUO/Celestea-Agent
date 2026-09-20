// ============================================================================
// plugins/server.ts — 显示组件启用表的**服务端线协议**（W895-C1）。
// ----------------------------------------------------------------------------
//   GET  /api/display-plugins -> { ok, disabled: string[] }
//   PUT  /api/display-plugins   body { disabled: string[] }
// 只做取数与落库；语义（降级/回滚/迁移）在 store.ts。这里不吞错：任何非 2xx 都
// 抛，调用方据此走「如实降级」或「回滚」分支 —— 绝不伪造成功。
// ============================================================================

/** 服务端响应里唯一被读取的字段。 */
export interface DisplayPluginsWire {
  ok?: boolean;
  disabled?: unknown;
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

/** 读服务端启用表（失败即抛，由 store 决定降级）。 */
export async function fetchDisplayPlugins(): Promise<string[]> {
  const data = (await request('/api/display-plugins')) as DisplayPluginsWire | null;
  return normalize(data?.disabled);
}

/** 写服务端启用表（失败即抛，由 apply 决定回滚）。 */
export async function saveDisplayPlugins(disabled: readonly string[]): Promise<void> {
  await request('/api/display-plugins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: [...disabled] }),
  });
}
