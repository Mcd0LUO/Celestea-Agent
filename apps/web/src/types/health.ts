// ============================================================================
// types/health.ts — 只读自省端点（GET /api/health · GET /api/tools）线格式。
//
//   为什么单独一个文件：types.ts 有模块体积棘轮（≤ tools/module-size-baseline.json
//   登记行数，只许降不许升），本族类型本轮新增了能力位（session_mode /
//   session_mode_tools），按 W784 的 ./types/context、./types/question 先例整族
//   拆出；types.ts 原样再导出，调用方零改动。
//   分层对齐：服务端 get_health / get_tools / get_status 三个只读端点同在
//   handlers/health.ts（设计 modes-standard-vs-execution §5.1 #6）。
// ============================================================================

/**
 * W701：能力位（设计 §6.5）——某项特性在当前服务上是否可用。
 * 只有显式 `true` 才算可用；字段缺失/为 false（旧服务）一律按不可用处理：
 * 入口**隐藏**而不是置灰报错（设计 §6.5）。
 */
export interface HealthCapabilities {
  grants?: boolean;
  /** W726：只读上下文快照（点状态栏上下文圆环可查看）。 */
  context?: boolean;
  /** W729 P0：会话工作方式（session.json.mode）是否已落地。 */
  session_mode?: boolean;
  /**
   * W787 P1：工作方式**切换**端点（POST /api/sessions/{id}/mode）与按会话工具
   * 暴露面差异是否已落地。缺省（老服务）→ 切换入口只读降级，不报错（W788）。
   */
  session_mode_tools?: boolean;
  /**
   * W805：多模态附件入口能力位（设计 §7.1）。只有显式 true 才显示
   * 粘贴/拖拽/选择图片入口；缺省（老服务）→ 入口隐藏，不当成故障。
   */
  multimodal?: boolean;
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
