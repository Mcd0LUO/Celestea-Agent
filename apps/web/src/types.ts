// ============================================================================
// Celestea Studio — shared type contracts
// SSE  GET /api/events  event: status|text|thinking|tool|tool_result|done
//      data 为 {"turn":N,"seq":M,"payload":{...}}
//   HTTP  POST /api/turn {input} · POST /api/cancel · POST /api/config {patch}
//         GET /api/health · GET /api/tools · GET /api/config · GET /api/sessions
//         GET /api/status · POST /api/clear
// 视图层合同（AssistantView / ToolOpView）见 ui/view.ts（与 API 合同分离）。
// ============================================================================

// ---- SSE -------------------------------------------------------------------

/** SSE envelope: every event carries { turn, seq, payload }. */
export interface SseEnvelope {
  /** W514: envelope version (2 = carries `session`; absent/1 = legacy single-session). */
  v?: number;
  /** W514: target session id — the frontend routes every frame by this field. */
  session?: string;
  turn?: number;
  seq?: number;
  payload?: Record<string, unknown>;
}

/**
 * W514: fields the envelope contributes to every payload (the SSE client merges
 * them flat). All optional — a legacy backend omits them and the frontend falls
 * back to the single-session behaviour.
 */
export interface SseMeta {
  v?: number;
  session?: string;
  turn?: number;
  seq?: number;
}

/** SSE event names (mirrored from the engine LoopEvent variants). */
export type SseEventName =
  | 'status'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'done'
  | 'context'
  | 'compact'
  /** W515：Agent Inbox / worker 回执等系统注入（kind='inbox' 的转录条目）。 */
  | 'inbox';

export type ConnState = 'connecting' | 'online' | 'down';

// ---- statusline / runtime status ------------------------------------------

export interface ContextUsage {
  used: number;
  window: number;
  ratio: number;
}

/** Statusline snapshot (GET /api/status + SSE status 增量字段，共享合同). */
export interface StatusSnapshot {
  model?: string;
  reasoning_effort?: string | null;
  steps?: number;
  tokens_per_sec?: number;
  context_usage?: ContextUsage;
  /** W263: engine token usage (latest LLM stream + cumulative `total`). */
  usage?: UsageSnapshot;
  /** W237/W514: the session this snapshot describes (GET /api/status?session=). */
  session?: string | null;
  /** W514: whether that session currently has a turn running (may be absent). */
  busy?: boolean;
  /**
   * W701（设计 §5.7）：该会话当前生效的放宽项名称列表（不含路径细节）。
   * 仅用于侧栏会话叶子的小盾牌标记；字段缺失 = 旧服务，不显示标记。
   */
  grants_active?: string[];
}

/**
 * W263: one usage block — provider-reported counters of one LLM stream.
 * `cache_hit_ratio` = cache_read / prompt_tokens (0 when prompt_tokens == 0).
 */
export interface UsageCounters {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_hit_ratio: number;
  reasoning_tokens: number;
}

/** W263: latest stream + cumulative (`total`) usage counters. */
export interface UsageSnapshot extends UsageCounters {
  total?: UsageCounters;
}

/** status SSE payload: turn lifecycle + optional statusline fields. */
export interface StatusPayload extends StatusSnapshot {
  /** W514: envelope version (2 = carries `session`). */
  v?: number;
  /** W514: `session` is inherited from StatusSnapshot (may be null on legacy). */
  seq?: number;
  phase?: 'start' | 'completed' | 'cancelled' | 'error' | 'lagged';
  turn?: number;
  error?: string;
  hint?: string;
  /**
   * W263: the backend nests the statusline snapshot under `statusline`
   * ({"phase":"progress","statusline":{...}}); flat fields stay supported.
   */
  statusline?: StatusSnapshot;
}

export interface TextPayload extends SseMeta {
  delta: string;
}

export interface ThinkingPayload extends SseMeta {
  delta: string;
}

export interface ToolPayload extends SseMeta {
  id: string;
  name?: string;
  args?: unknown;
}

export interface ToolResultPayload extends SseMeta {
  id: string;
  ok?: boolean;
  value?: unknown;
  render?: string;
  error?: string | null;
  decision?: 'allow' | 'deny' | 'ask' | null;
}

export interface DonePayload extends SseMeta {
  text?: string;
  tool_calls?: ToolPayload[];
}

/** context 类事件（W240：上下文注入 / 裁剪等系统提示）。 */
export interface ContextPayload extends SseMeta {
  text?: string;
  cls?: string;
}

/**
 * W515：inbox 事件（Agent Inbox / worker 回执 / 系统注入）。
 * DSH 的 inbox 分两车道：next-step（steer，最近 step 边界插入）与
 * next-turn（queue，下一回合独立投递）——前端只负责分类展示。
 * 字段全部可选：后端未就绪时不发该事件（现状降级）。
 */
export interface InboxPayload extends SseMeta {
  /** 展示文本（缺省时回落到 note/hint）。 */
  text?: string;
  /** 来源标记：worker id / 'system' 等。 */
  source?: string;
  /** 'next-step' | 'next-turn'（与 InboxTarget 对齐）。 */
  target?: string;
  note?: string;
  hint?: string;
}

/** compact 类事件（W259：/compact 压缩完成；payload 带会话 id）。 */
export interface CompactPayload {
  session?: string;
  kept_turns?: number;
  note?: string;
  rebound?: boolean;
}

// ---- REST -------------------------------------------------------------------

/**
 * W701：能力位（设计 §6.5）——某项特性在当前服务上是否可用。
 * 只有显式 `true` 才算可用；字段缺失/为 false（旧服务）一律按不可用处理：
 * 入口**隐藏**而不是置灰报错（设计 §6.5）。
 */
export interface HealthCapabilities {
  grants?: boolean;
  /** W726：只读上下文快照（点状态栏上下文圆环可查看）。 */
  context?: boolean;
  /** 其它能力位（未知键原样保留，本层不解释）。 */
  [key: string]: unknown;
}

export interface HealthInfo {
  ok?: boolean;
  name?: string;
  model?: string;
  base_url?: string;
  bind?: string;
  /** W701：能力位（缺失 = 旧服务，全部按不可用处理）。 */
  capabilities?: HealthCapabilities;
}

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ToolsResp {
  ok?: boolean;
  tools?: ToolInfo[];
  error?: string;
}

export interface SessionInfo {
  id?: string;
  title?: string;
  /** W514: 'session' | 'worker' (absent on legacy backends). */
  kind?: 'session' | 'worker' | string;
  /** W514: a turn is running on this session (absent on legacy backends). */
  busy?: boolean;
  workspace?: string | null;
  events?: number;
  live?: boolean;
  model?: string;
  file?: string;
  size?: number;
  modified?: number;
  archived?: boolean;
  /** W237：是否为当前活跃会话 */
  active?: boolean;
  /**
   * W515：谱系父会话 id（对齐 DSH 的 parentSessionId）。
   * 兼容三种写法：parent / parentSessionId / parent_session；缺失 → 现状平坦展示。
   */
  parent?: string | null;
  parentSessionId?: string | null;
  parent_session?: string | null;
  /**
   * W701：该会话当前生效的放宽项名称列表（可选字段；服务给出时优先用它，
   * 省掉逐会话查询）。缺失 = 走按需查询 / 不显示标记。
   */
  grants_active?: string[];
}

export interface SessionsResp {
  ok?: boolean;
  sessions?: SessionInfo[];
  error?: string;
}

// ---- 会话历史（GET /api/sessions/{id}/messages，回放/恢复用） --------------------

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'thinking' | 'inbox';

/**
 * 消息契约（W252 结构化，无兼容层）：
 *   user/assistant/thinking → content 文本；
 *   tool → kind='call'（tool_call_id/tool_name/tool_args）
 *          或 kind='result'（tool_call_id/tool_value/tool_error）。
 */
export interface HistoryMsg {
  role: HistoryRole;
  /** 普通消息文本（tool 消息无此字段）。 */
  content?: string;
  /**
   * tool 消息：'call' | 'result'；
   * user 消息（W515）：'steering'（插话）/ 'queued'（排队）；
   * 'inbox'（worker 回执 / 系统注入）。
   */
  kind?: 'call' | 'result' | 'steering' | 'queued' | 'inbox';
  /** W515：inbox 条目的来源标记（worker id 等）。 */
  source?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_args?: unknown;
  tool_value?: unknown;
  tool_error?: string | null;
}

export interface MessagesResp {
  ok?: boolean;
  session?: string;
  messages?: HistoryMsg[];
  error?: string;
}

// ---- 工作区 / 会话管理（W236） ------------------------------------------------

export interface WorkspaceInfo {
  name: string;
  path?: string;
  sessions?: number;
}

export interface WorkspacesResp {
  ok?: boolean;
  workspaces?: WorkspaceInfo[];
  active_session?: string | null;
  error?: string;
}

/** POST /api/sessions/{id}/activate 响应。 */
export interface ActivateResp {
  ok?: boolean;
  active_session?: string;
  error?: string;
}

/** POST /api/sessions/{id}/compact 响应（W259：三态——压缩/无需压缩/错误）。 */
export interface CompactResp {
  ok?: boolean;
  /** true=已压缩；false=历史不足，无需压缩（note 给出说明）。 */
  compacted?: boolean;
  kept_turns?: number;
  note?: string;
  error?: string;
}

/** GET /api/fs/browse?path= 响应（目录浏览；只列目录）。 */
export interface FsBrowseResp {
  path?: string;
  parent?: string | null;
  dirs?: string[];
  roots?: string[];
  error?: string;
}

export interface SessionCreateReq {
  workspace?: string | null;
  title: string;
  /** W243：可选模型（空=跟随默认）。 */
  model?: string;
  /** W245：绑定提示词（空=跟随默认）。 */
  prompt?: string;
}

/** POST /api/sessions 响应（W243 起携带新会话 id）。 */
export interface SessionCreateResp extends OkResp {
  id?: string;
}

export interface BatchIdsReq {
  ids?: string[];
}

export interface BatchNamesReq {
  names?: string[];
}

// ---- 模型提供商（W236） --------------------------------------------------------

export interface ProviderModelSpec {
  id: string;
  name: string;
  reasoning_efforts?: string[];
  context_window?: number | null;
  max_output_tokens?: number | null;
}

export interface ProviderInfo {
  id: string;
  name?: string;
  note?: string;
  base_url?: string;
  request_format?: string;
  models?: ProviderModelSpec[];
  is_default?: boolean;
  has_key?: boolean;
}

export interface ProvidersResp {
  ok?: boolean;
  providers?: ProviderInfo[];
  default_model?: string | null;
  error?: string;
}

export interface ProviderTestResp {
  ok?: boolean;
  latency_ms?: number;
  model_count?: number;
  error?: string;
}

export interface ProviderFetchResp {
  ok?: boolean;
  models?: { id: string }[];
  error?: string;
}

// ---- 提示词系统（W245） -----------------------------------------------------------

export interface PromptSection {
  id: string;
  name: string;
  template: string;
  order: number;
  scope: 'builtin' | 'global' | 'workspace';
}

export interface PromptInfo {
  id: string;
  name: string;
  is_default?: boolean;
  /** 段覆盖（编辑弹窗打开时必须回填，否则保存会清掉旧覆盖）。 */
  section_overrides?: Record<string, string>;
  scope: 'global' | 'workspace';
  shadowed?: boolean;
}

export interface PromptsResp {
  ok?: boolean;
  /** 显式 scope（后端固定声明；客户端不再从空值推断）。 */
  scope?: 'global' | 'workspace';
  sections?: PromptSection[];
  prompts?: PromptInfo[];
  default_prompt?: string | null;
  active_prompt?: string | null;
  error?: string;
}

/** POST /api/prompts upsert 载荷（P0-4：不传 workspace=全局）。 */
export interface PromptUpsertReq {
  workspace?: string;
  id: string;
  name: string;
  section_overrides: Record<string, string>;
  is_default?: boolean;
}

export interface OkResp {
  ok?: boolean;
  error?: string;
}

export interface ClearResp extends OkResp {}

export interface CancelResp extends OkResp {}

export interface TurnResp {
  ok?: boolean;
  turn?: number;
  /**
   * W514: true = the input was injected into the running turn (no new turn),
   * false/absent = a new turn was started with `turn` as its id.
   */
  injected?: boolean;
  /** W515: true = 已按「排队（下一回合投递）」接收（mode='queue'）。 */
  queued?: boolean;
  /** W515: 后端回声的投递车道（'next-step' | 'next-turn'）。 */
  inbox_target?: string;
  /** W514: session the turn (or the injection) belongs to. */
  session?: string;
  error?: string;
}

// ---- 配置（GET /api/config · POST /api/config） ----------------------------

/** available.models 条目：id=引擎模型标识，name=展示名（未定义时后端取 id）。 */
export interface ModelInfo {
  id: string;
  name: string;
  /** W262：提供商显示名；静态兜底目录的条目为空串（前端归入「其他」组）。 */
  provider?: string;
  /**
   * W750：提供商稳定 id（切换时回传用）。与 `provider`（显示名）是两回事：
   * 显示名可能被改、也可能与 id 不同，切 provider 必须用 id。
   */
  provider_id?: string;
  /**
   * W750：该 (provider, model) 组合就是当前生效项（后端按「同模型 + 同端点」判定）。
   * 旧服务无此字段 → 前端退回按模型 id 匹配。
   */
  active?: boolean;
  reasoning?: boolean;
}

/** 可选清单（后端发布时携带；缺失则前端降级为手输/预置档位）。 */
export interface ConfigAvailable {
  models?: ModelInfo[];
  efforts?: string[];
}

/** GET /api/config 返回的安全 Profile（永不携带 api_key 明文）。 */
export interface ConfigInfo {
  model?: string;
  base_url?: string;
  /** 后端通过 env/file 配密钥时返回 null；前端永不显示/回传真实值。 */
  api_key?: string | null;
  context_window?: number | null;
  context_window_tokens?: number | null;
  max_steps?: number | null;
  max_parallel_tool_calls?: number | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  system_prompt?: string | null;
  available?: ConfigAvailable;
}

/** POST /api/config 热调补丁：只携带用户改动的键（空值=不改）。 */
export interface ConfigPatch {
  model?: string;
  base_url?: string;
  api_key?: string;
  context_window?: number | null;
  max_steps?: number | null;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  system_prompt?: string;
}

/** POST /api/config 成功响应 = 消毒后的完整配置（同 GET 体型）。 */
export type ConfigSaveResp = ConfigInfo & OkResp;

// ---- 会话权限（W701 提权通道；契约见 feature-session-grants.md §6） -------------

/** 6 项能力位（设计 §2.2）。 */
export type GrantCap =
  | 'network'
  | 'read_roots'
  | 'write_roots'
  | 'net_hosts'
  | 'tool_extra'
  | 'unsandboxed';

/** 能力范围：布尔类为空对象；目录/站点/工具类为列表。 */
export interface GrantScope {
  roots?: string[];
  hosts?: string[];
  tools?: string[];
  [key: string]: unknown;
}

/** 一条授权记录（GET /grants 的 grants[]）。 */
export interface GrantEntry {
  id?: string;
  cap?: GrantCap | string;
  scope?: GrantScope;
  granted_at?: number;
  granted_by?: string;
  expires_at?: number | null;
  uses_left?: number | null;
  note?: string;
  /** 服务端判定：该条已过期（读取时判定，设计 §2.3）。 */
  expired?: boolean;
}

/** 生效结果快照（服务端返回；UI 只原样展示，绝不改写措辞）。 */
export interface EffectiveGrants {
  network?: boolean;
  read_roots?: string[];
  write_roots?: string[];
  net_hosts?: string[];
  tool_extra?: string[];
  unsandboxed?: boolean;
  [key: string]: unknown;
}

export interface GrantsResp {
  ok?: boolean;
  session?: string;
  grants?: GrantEntry[];
  effective?: EffectiveGrants;
  /** 每种能力的有效期上限（秒）；缺失 = 不限制（前端只用文档默认值 1800）。 */
  max_ttl_sec?: Record<string, number>;
  /** 降低隔离运行是否在本部署中开放（设计 §2.2 注 3 / §8.1）。 */
  unsandboxed_available?: boolean;
  /**
   * W757：本次放宽的站点清单在当前部署下是否真的生效。
   * false = 会话确实带着站点清单，但本部署未启用站点策略，这份清单不会改变可访问范围。
   * 是否生效是部署事实，不随前端变化；旧服务不返回该字段（undefined）时按「不显示」处理。
   */
  net_hosts_effective?: boolean;
  /** 服务返回的提示条目（条目被忽略 / 文件读不出 / 放宽不生效等）；可能缺失或为空。 */
  warnings?: string[];
  error?: string;
}

export interface GrantTokenResp {
  ok?: boolean;
  token?: string;
  expires_at?: number;
  error?: string;
}

/** 授予请求体（POST /grants）。 */
export interface GrantReq {
  cap: GrantCap;
  scope?: GrantScope;
  ttl_sec?: number;
  uses_left?: number | null;
  note?: string;
}

export interface GrantResp {
  ok?: boolean;
  grant?: GrantEntry;
  effective?: EffectiveGrants;
  error?: string;
}

/** 撤销请求体（DELETE /grants）；两者都省略 = 全部撤销。 */
export interface RevokeReq {
  cap?: GrantCap;
  grant_id?: string;
}

export interface GrantRevokeResp {
  ok?: boolean;
  revoked?: string[];
  effective?: EffectiveGrants;
  error?: string;
}

// ---- W726：上下文快照（只读完整上下文，点状态栏上下文圆环查看） ----------------

/** 工具（名称 + 说明 + 参数结构）。 */
export interface ContextToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  /** 该条目超长被服务端截断。 */
  truncated?: boolean;
}

/** 一条消息（role: user / assistant / tool）。 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  /** 该条目超长被服务端截断。 */
  truncated?: boolean;
}

export interface ContextCounts {
  system_chars?: number;
  tool_count?: number;
  message_count?: number;
}

export interface ContextUsageInfo {
  used?: number;
  window?: number;
  ratio?: number;
  /** 用量为估算值（非精确计量）。 */
  estimated?: boolean;
}

export interface SessionContextResp {
  ok?: boolean;
  session?: string;
  model?: string;
  system?: string;
  tools?: ContextToolInfo[];
  messages?: ContextMessage[];
  counts?: ContextCounts;
  context?: ContextUsageInfo;
  /** 整份快照存在被截断的条目。 */
  truncated?: boolean;
  error?: string;
}
