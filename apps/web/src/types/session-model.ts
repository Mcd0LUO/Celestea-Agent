// ============================================================================
// types/session-model.ts — W870：会话级模型切换的线格式。
//
//   权威依据：contracts/endpoints.json 的 `put_session_model`（W870 新增，
//   TS-only）。为何单独一个文件：types.ts 有模块体积棘轮（只许降不许升），
//   按 W784 的 ./types/context、W788 的 ./types/mode 先例拆出，types.ts 原样再导出。
//
//   产品语义：statusline 的模型选择器切的是**当前聚焦会话**的模型；
//   `POST /api/config` 仍是全局默认（设置页「通用配置」）。
// ============================================================================

/**
 * `PUT /api/sessions/{id}/model {model}` 响应。
 *   200 → {ok:true, session, model, covered, effective:{model,base_model,source,next_turn}}
 *   409 → {ok:false,error}：该会话轮次进行中（冻结文案）
 *   400 → 非法模型名；404 → 会话不存在 / 该部署未提供此端点（老服务）；
 *   422 → model 不是字符串。
 *
 * `model` 是**下一轮实际会用**的模型（有覆盖 = 覆盖值，无覆盖 = 全局默认）；
 * `covered` 说明这个值是不是该会话自己的覆盖 —— 选择器里那句「本会话已固定模型」
 * 就读它，用户因此知道它为什么不跟全局走。
 */
export interface SessionModelResp {
  ok?: boolean;
  session?: string;
  model?: string;
  /** true = 该会话有自己的 `session.json.model`（不跟全局默认走）。 */
  covered?: boolean;
  effective?: {
    model?: string;
    /** 作答时刻的全局默认模型。 */
    base_model?: string;
    /** `'session'` = 覆盖生效；`'global'` = 回落全局默认。 */
    source?: 'session' | 'global';
    /** 生效时机：下一轮边界（不打断在飞轮次）。 */
    next_turn?: boolean;
  };
  error?: string;
}
