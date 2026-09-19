// ============================================================================
// api.ts — HTTP 层（单一职责）：所有 REST 调用集中于此，唯一 fetch 出处。
// 封装：请求/响应解析/ApiError；不持有 UI 状态、不做 DOM 操作。
// ============================================================================
import type {
  ActivateResp,
  BatchIdsReq,
  BatchNamesReq,
  BatchOpResp,
  CancelResp,
  ClearResp,
  CompactResp,
  ConfigInfo,
  FsBrowseResp,
  ConfigPatch,
  ConfigSaveResp,
  GrantReq,
  GrantResp,
  GrantRevokeResp,
  GrantsResp,
  GrantTokenResp,
  HealthInfo,
  MessagesResp,
  ProviderFetchResp,
  ProviderTestResp,
  QuestionAnswerItem,
  QuestionAnswerResp,
  QuestionsResp,
  RevokeReq,
  ProvidersResp,
  PromptUpsertReq,
  PromptsResp,
  SessionCreateReq,
  SessionCreateResp,
  SessionMode,
  SessionModeResp,
  SessionModelResp,
  SessionContextResp,
  SessionsResp,
  StatusSnapshot,
  ToolsResp,
  TurnAttachmentInput,
  TurnResp,
  WorkspacesResp,
} from './types';
import type { ExecReq, ExecResp } from './types/exec'; // A3：用户直发命令
import type { GoalResp } from './types/goal'; // A3：持久目标
// W859：宿主插件清单类型（端点尚未发布；整包按 unknown 校验，见 ./types/plugin）
import type { PluginsResp } from './types/plugin';
// W858：权限族类型整族在 ./types/permission（types.ts 有模块体积棘轮，本轮不追加行数；
// 先例：ui/attachments.ts 直接 import ./types/attachment）。
import type {
  PermissionPreset,
  PermissionPresetDeletedResp,
  PermissionPresetResp,
  PermissionPresetsResp,
  SessionPermissionResp,
} from './types/permission';

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;
  /**
   * 原始技术细节（HTTP 状态行 / 服务端 error 原文 / 浏览器网络异常文本）。
   * 只供 console 与日志排查，不得拼进任何会渲染给用户的字符串。
   */
  readonly technical: string;

  constructor(message: string, status = 0, data: unknown = null, technical = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.technical = technical;
  }
}

/**
 * 状态码 → 面向用户的固定短语（不透传服务端/浏览器原文）。
 * 各 UI 落点统一以「X失败：<短语>」呈现，后缀永远来自这里。
 */
function userPhrase(status: number): string {
  if (status === 0) return '无法连接服务，请稍后重试';
  if (status === 400 || status === 422) return '请求内容有误，请检查后重试';
  if (status === 401 || status === 403) return '没有权限执行该操作';
  if (status === 404 || status === 405) return '当前版本不支持该操作';
  if (status === 409) return '当前状态暂时无法完成该操作，请稍后重试';
  if (status === 429) return '操作过于频繁，请稍后重试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return '服务暂时无法完成请求，请稍后重试';
}

/**
 * 服务端响应体 error 字段 / 任意底层异常 → 面向用户的固定短语。
 * 原始细节只写 console（开发者排查用），绝不进入 UI 文案。
 */
export function userErrorText(detail: unknown, phrase = '服务暂时无法完成请求，请稍后重试'): string {
  if (detail instanceof ApiError) {
    if (detail.technical) console.warn('[api] 服务端详情：' + detail.technical);
    return detail.message;
  }
  const raw = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  if (raw.trim() !== '') console.warn('[api] 服务端详情：' + raw);
  return phrase;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn('[api] ' + path + ' 网络层失败：' + detail);
    throw new ApiError(userPhrase(0), 0, null, detail);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const obj = data as { error?: unknown } | null;
    const detail =
      obj && typeof obj.error === 'string' && obj.error.trim() !== ''
        ? obj.error
        : 'HTTP ' + res.status;
    console.warn('[api] ' + path + ' → HTTP ' + res.status + '：' + detail);
    throw new ApiError(userPhrase(res.status), res.status, data, detail);
  }
  return (data ?? {}) as T;
}

function postJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** PUT + JSON body（与 postJson 同款：唯一 fetch 出处仍在本文件）。 */
function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  health: () => requestJson<HealthInfo>('/api/health'),
  /**
   * Statusline fallback source (polled + SSE incremental).
   * W514: `session` 非空 → GET /api/status?session=<id>（任意会话状态；旧后端
   * 忽略该参数，返回活跃会话快照 = 现状行为）。
   */
  status: (session?: string) =>
    requestJson<StatusSnapshot>(
      '/api/status' + (session ? '?session=' + encodeURIComponent(session) : ''),
    ),
  tools: () => requestJson<ToolsResp>('/api/tools'),
  /**
   * W859：GET /api/plugins —— 宿主（服务端）插件清单，设置页「插件」一格的取数口。
   * 端点尚未发布：404/405/网络不可达 → ApiError，调用方显示如实空态，不伪造清单。
   */
  plugins: () => requestJson<PluginsResp>('/api/plugins'),
  /** 当前运行配置（安全剖面，不含密钥）。 */
  config: () => requestJson<ConfigInfo>('/api/config'),
  /** 热调保存：POST /api/config {patch}（成功响应 = 消毒后完整配置）。 */
  saveConfig: (patch: ConfigPatch) => postJson<ConfigSaveResp>('/api/config', patch),
  /**
   * GET /api/sessions —— 会话列表。
   *   缺省（不传 opts）：**只列未归档**会话；实测（2026-09-16，3777）缺省行里
   *     **连 `archived` 键都没有** ⇒ 拿缺省列表去筛 `archived === true` 永远为空
   *     （W792 修的正是这个：归档面板曾因此永远列不出东西、也就删不掉）。
   *   `{archived:true}` → `?archived=1`：**只列已归档**会话，每行带 `archived:true`
   *     —— 设置页「归档会话管理」的唯一取数口。
   *   `{archived:false}` / 缺省 → 不加查询串，请求与响应体与过去逐字节一致。
   */
  sessions: (opts?: { archived?: boolean }) =>
    requestJson<SessionsResp>(
      '/api/sessions' + (opts?.archived === true ? '?archived=1' : ''),
    ),
  /** 会话历史（回放/恢复）；404/超时 → ApiError。 */
  messages: (id: string) =>
    requestJson<MessagesResp>('/api/sessions/' + encodeURIComponent(id) + '/messages'),
  /**
   * W726：只读上下文快照 —— 模型本轮实际看到的内容（系统提示词 / 工具清单 /
   * 消息流 + 用量）。404 = 该会话不存在（或服务未提供此能力，调用方按能力位降级）。
   */
  sessionContext: (id: string) =>
    requestJson<SessionContextResp>('/api/sessions/' + encodeURIComponent(id) + '/context'),
  clear: () => postJson<ClearResp>('/api/clear', {}),
  /**
   * W514/W515：POST /api/turn {input, session?, mode?}
   *   - 目标会话空闲 → 开新轮；
   *   - 运行中 + mode='steer'（默认）→ 插话（注入该轮最近 step 边界，
   *     响应 injected=true，不新开轮）；
   *   - 运行中 + mode='queue' → 排队（本轮结束后作为下一回合投递，
   *     响应 queued=true）。
   * 旧后端忽略多余字段（serde 默认），仍按现状返回 409/新轮 →
   * 前端按「插话/排队失败」提示并还原输入，不丢字。
   */
  turn: (
    input: string,
    session?: string,
    mode?: 'steer' | 'queue',
    attachments?: TurnAttachmentInput[],
  ) => {
    const body: Record<string, unknown> = { input };
    if (session) body.session = session;
    if (mode) body.mode = mode;
    // W805（设计 §7.4）：P0 内联 base64 附件，零新端点；无附件时不写该键，
    // 请求体与既有行为逐字节一致。
    if (attachments && attachments.length > 0) body.attachments = attachments;
    return postJson<TurnResp>('/api/turn', body);
  },
  /** 取消当前聚焦会话的轮次（W514：带 session，旧后端忽略）。 */
  cancel: (session?: string) => postJson<CancelResp>('/api/cancel', session ? { session } : {}),
  // ---- W784：模型向用户提问（未决列表 / 作答；契约见 feature-ask-user.md §3） ----
  /**
   * GET /api/questions?session= —— **仍未决**、仍可作答的提问（§7 恢复的唯一权威源）。
   * `remaining_ms`/`expired` 由服务端读时判定，前端不拿自己的钟做判断。
   * 未提供该端点（旧服务）→ 404，调用方保持现状、不显示任何卡片。
   */
  questions: (session?: string) =>
    requestJson<QuestionsResp>(
      '/api/questions' + (session ? '?session=' + encodeURIComponent(session) : ''),
    ),
  /**
   * POST /api/questions/{id}/answer —— 直接唤醒挂起的工具调用（§4.2，不经 /api/turn）。
   * `session` 是防串答守卫：与未决项不匹配时服务端明确拒绝（不猜、不静默）。
   */
  answerQuestion: (id: string, answers: QuestionAnswerItem[], session?: string) =>
    postJson<QuestionAnswerResp>(
      '/api/questions/' + encodeURIComponent(id) + '/answer',
      session ? { answers, session } : { answers },
    ),
  // ---- 工作区 / 会话管理（W236；缺失时 404 优雅降级） ----
  workspaces: () => requestJson<WorkspacesResp>('/api/workspaces'),
  /** W243 任务2：纯文件管理器建工作区——仅按目录注册（name 由后端取文件夹 basename）。 */
  createWorkspaceByPath: (path: string) =>
    postJson<ClearResp>('/api/workspaces', { path }),
  /** 重命名工作区（W243）：POST /api/workspaces/{name}/rename {"new_name"}。 */
  renameWorkspace: (name: string, newName: string) =>
    postJson<ClearResp>('/api/workspaces/' + encodeURIComponent(name) + '/rename', {
      new_name: newName,
    }),
  deleteWorkspace: (name: string) =>
    postJson<ClearResp>('/api/workspaces/' + encodeURIComponent(name) + '/delete', {}),
  batchDeleteWorkspaces: (names: string[]) =>
    postJson<ClearResp>('/api/workspaces/batch-delete', { names } as BatchNamesReq),
  createSession: (req: SessionCreateReq) => postJson<SessionCreateResp>('/api/sessions', req),
  /**
   * W788：切换该会话的工作方式 —— POST /api/sessions/{id}/mode {mode}。
   * 200 = {ok,session,mode,effective:'next_turn'}（不打断在飞轮次，下一轮生效）；
   * 409 = 该会话有在飞轮次（调用方按冻结文案提示，不重试）；400 = 非法 mode；
   * 404/405 = 该部署未提供此端点（老服务）→ 调用方只读降级，不假装成功。
   */
  setSessionMode: (id: string, mode: SessionMode) =>
    postJson<SessionModeResp>('/api/sessions/' + encodeURIComponent(id) + '/mode', { mode }),
  /**
   * W870：切换**该会话**的模型（PUT /api/sessions/{id}/model）。200 回
   * {ok,session,model,covered,effective}（下一轮生效）；`model: ''` = 清除覆盖、
   * 回落到全局默认；409 = 该会话有在飞轮次；400/422 = 模型名非法；404/405 = 会话
   * 不存在或该部署未提供此端点。理由与产品语义见 statusline/session-model.ts
   * （徽标轮询的 model 来自会话实例的 profile，只改全局会被下一次轮询打回）。
   */
  setSessionModel: (id: string, model: string) =>
    putJson<SessionModelResp>('/api/sessions/' + encodeURIComponent(id) + '/model', { model }),
  renameSession: (id: string, newTitle: string) => // W243：POST …/rename
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/rename', {
      new_title: newTitle,
    }),
  branchSession: (id: string, title?: string) => // W243：POST …/branch
    postJson<ClearResp & { id?: string; branch?: string }>(
      '/api/sessions/' + encodeURIComponent(id) + '/branch',
      title ? { title } : {},
    ),
  archiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/archive', {}),
  unarchiveSession: (id: string) =>
    postJson<ClearResp>('/api/sessions/' + encodeURIComponent(id) + '/unarchive', {}),
  activateSession: (id: string) => // W237：POST …/activate；409=轮次中
    postJson<ActivateResp>('/api/sessions/' + encodeURIComponent(id) + '/activate', {}),
  compactSession: (id: string) => // W259：POST …/compact；409=轮次中
    postJson<CompactResp>('/api/sessions/' + encodeURIComponent(id) + '/compact', {}),
  /** A3：用户直发命令（**不经模型**）；404/501 = 该部署未提供 → 调用方给可读提示。 */
  exec: (req: ExecReq) => postJson<ExecResp>('/api/exec', req),
  /** A3：设置/清除该会话的持久目标（text='' = 清除；200 回 goal，null = 无）。 */
  setGoal: (id: string, text: string) =>
    postJson<GoalResp>('/api/sessions/' + encodeURIComponent(id) + '/goal', { text }),
  /** 目录浏览（W237）：GET /api/fs/browse?path=（懒加载列目录，只显示目录）。 */
  fsBrowse: (path?: string) =>
    requestJson<FsBrowseResp>('/api/fs/browse' + (path ? '?path=' + encodeURIComponent(path) : '')),
  /** 批量归档（W792）：部分失败仍 ok:true，失败项只在 failed[]，调用方必须呈现。 */
  batchArchiveSessions: (ids: string[]) =>
    postJson<BatchOpResp>('/api/sessions/batch-archive', { ids } as BatchIdsReq),
  /** 批量删除（W792 起按 BatchOpResp 建模）：同上，成功条数在 `deleted`。 */
  batchDeleteSessions: (ids: string[]) =>
    postJson<BatchOpResp>('/api/sessions/batch-delete', { ids } as BatchIdsReq),
  // ---- 模型提供商（W236；缺失时 404 优雅降级） ----
  providers: () => requestJson<ProvidersResp>('/api/providers'),
  saveProvider: (payload: unknown) => postJson<ClearResp>('/api/providers', payload),
  deleteProvider: (id: string) =>
    postJson<ClearResp>('/api/providers/' + encodeURIComponent(id) + '/delete', {}),
  testProvider: (payload: unknown) => postJson<ProviderTestResp>('/api/providers/test', payload),
  fetchProviderModels: (id: string) =>
    postJson<ProviderFetchResp>('/api/providers/' + encodeURIComponent(id) + '/models/fetch', {}),
  /** W750：切默认 (provider, model)；`providerId` 只在跨 provider 撞名时传。 */
  setDefaultModel: (model: string, providerId?: string) =>
    postJson<ClearResp>(
      '/api/providers/default',
      providerId ? { model, provider_id: providerId } : { model },
    ),
  // ---- 提示词（W245；缺失时 404 优雅降级） ----
  // P0-4 scope 契约：不传 workspace=全局（后端默认 scope）；workspace=名=该工作区。
  prompts: (workspace?: string) =>
    requestJson<PromptsResp>(
      '/api/prompts' + (workspace ? '?workspace=' + encodeURIComponent(workspace) : ''),
    ),
  /** POST /api/prompts upsert：workspace 省略=全局；成功响应带 hot_applied。 */
  savePrompt: (payload: PromptUpsertReq) =>
    postJson<ClearResp & { hot_applied?: boolean }>('/api/prompts', payload),
  deletePrompt: (id: string, workspace?: string) =>
    postJson<ClearResp & { hot_applied?: boolean }>(
      '/api/prompts/' + encodeURIComponent(id) + '/delete',
      workspace ? { workspace } : {},
    ),
  setDefaultPrompt: (id: string, workspace?: string) =>
    postJson<ClearResp & { hot_applied?: boolean }>(
      '/api/prompts/' + encodeURIComponent(id) + '/default',
      workspace ? { workspace } : {},
    ),
  // ---- W9：权限预设 / 会话权限档位（设置页「权限预设」pane + statusline 档位徽标） ----
  /**
   * GET /api/permissions/presets —— 内置三档 + 自定义档 + 运行时封顶 max。
   * max 是**真源**（可能低于所选档）：界面如实展示，不替用户「修正」。
   */
  permissionPresets: () => requestJson<PermissionPresetsResp>('/api/permissions/presets'),
  /** POST /api/permissions/presets {preset}：409 = id 已存在（含内置 id）/ 422 = 字段非法。 */
  createPermissionPreset: (preset: PermissionPreset) =>
    postJson<PermissionPresetResp>('/api/permissions/presets', { preset }),
  /** PUT /api/permissions/presets/{id} {preset}：内置档 409、不存在 404、非法 422。 */
  updatePermissionPreset: (id: string, preset: PermissionPreset) =>
    putJson<PermissionPresetResp>('/api/permissions/presets/' + encodeURIComponent(id), { preset }),
  /** DELETE /api/permissions/presets/{id}：200 {deleted} / 内置 409 / 不存在 404。 */
  deletePermissionPreset: (id: string) =>
    requestJson<PermissionPresetDeletedResp>(
      '/api/permissions/presets/' + encodeURIComponent(id),
      { method: 'DELETE' },
    ),
  /** GET /api/sessions/{id}/permission：该会话选中的档位 + 已过封顶的生效快照。 */
  sessionPermission: (id: string) =>
    requestJson<SessionPermissionResp>('/api/sessions/' + encodeURIComponent(id) + '/permission'),
  /** PUT /api/sessions/{id}/permission {preset}：422 = 未知档位（调用方回滚徽标并说明）。 */
  setSessionPermission: (id: string, preset: string) =>
    putJson<SessionPermissionResp>('/api/sessions/' + encodeURIComponent(id) + '/permission', {
      preset,
    }),
  // ---- 会话权限 / 提权通道（W701；能力位未就绪时调用方不显示入口） ----
  /**
   * GET /api/sessions/{id}/grants：
   * 无 grants.json 时返回空列表 + 默认生效集（200，不是 404）。
   * 404 = 该会话不存在；405/404 亦可能是服务未提供此能力（调用方按能力位降级）。
   */
  grants: (id: string) =>
    requestJson<GrantsResp>('/api/sessions/' + encodeURIComponent(id) + '/grants'),
  /**
   * GET /api/sessions/{id}/grants/confirm-token?cap=&scope_hash=：
   * 一次性确认令牌（TTL 60s，绑定 会话+能力+范围哈希，用后即焚）。
   * 只在**授予**时使用；撤销降权不需要令牌。
   */
  grantToken: (id: string, cap: string, scopeHash: string) =>
    requestJson<GrantTokenResp>(
      '/api/sessions/' +
        encodeURIComponent(id) +
        '/grants/confirm-token?cap=' +
        encodeURIComponent(cap) +
        '&scope_hash=' +
        encodeURIComponent(scopeHash),
    ),
  /** POST /api/sessions/{id}/grants：带一次性确认令牌头（人工点击路径专用）。 */
  grantCap: (id: string, req: GrantReq, token: string) =>
    postJson<GrantResp>('/api/sessions/' + encodeURIComponent(id) + '/grants', req, {
      'X-Celestea-Grant-Confirm': token,
    }),
  /** DELETE /api/sessions/{id}/grants：撤销单项或全部；不带令牌（降权永远安全）。 */
  revokeCap: (id: string, req: RevokeReq = {}) =>
    requestJson<GrantRevokeResp>('/api/sessions/' + encodeURIComponent(id) + '/grants', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
};
