// ============================================================================
// types/config.ts — 配置族线格式（GET/POST /api/config 与模型清单）。
//
//   原在 types.ts 的「配置」一节；W870 按 W784 的 ./types/context、W788 的
//   ./types/mode 先例整段搬出（types.ts 有模块体积棘轮：只许降不许升），
//   types.ts 原样再导出，调用方零改动。纯类型，构建期擦除，不进产物。
// ============================================================================
import type { OkResp } from './batch';

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
  /**
   * W9104：同目标自动重试的**额外**尝试次数（0..3，默认 1；3 = 同一目标最多 4 次尝试）。
   * 它是重试预算，不是总尝试数。旧服务无此字段 → 前端不渲染该字段（不伪造默认值）。
   */
  max_retries?: number | null;
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
  /** W9104：同目标自动重试的额外次数（0..3）。范围外由后端 400 拒绝，不静默夹住。 */
  max_retries?: number;
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  system_prompt?: string;
}

/** POST /api/config 成功响应 = 消毒后的完整配置（同 GET 体型）。 */
export type ConfigSaveResp = ConfigInfo & OkResp;
