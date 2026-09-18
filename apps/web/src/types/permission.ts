// ============================================================================
// types/permission.ts — 权限预设 / 会话权限档位（W9）的线格式。
//
//   端点：GET/POST /api/permissions/presets、PUT/DELETE /api/permissions/presets/{id}、
//         GET/PUT /api/sessions/{id}/permission（精确形状见 contracts/endpoints.json）。
//
//   为什么单独一个文件：types.ts 有模块体积棘轮（≤ tools/module-size-baseline.json
//   登记行数，只许降不许升），按 ./attachment、./history 的先例整族拆出；
//   调用方直接从 './types/permission' 取（ui/attachments.ts 同款），
//   不动 types.ts 的棘轮行数。
// ============================================================================

/**
 * 一个权限档位（内置三档 = 服务端代码常量；自定义档 = <data dir>/permissions.json）。
 * 每个字段都是布尔/字符串数组——展示层只读，不解释「为什么」，避免与部署侧封顶打架。
 */
export interface PermissionPreset {
  id: string;
  label: string;
  /** 允许网络访问（真正能否出网还会被运行时封顶收窄）。 */
  network: boolean;
  /** 会话工作区可写。 */
  workspaceWritable: boolean;
  /** 部署侧工具根（repo/harness/tmp）可写。 */
  toolRootsWritable: boolean;
  /** 除工作区与工具根之外的显式绝对路径白名单。 */
  writeRoots: string[];
  /** 整台机器（所有目录）可读写；只动路径，不改网络与免沙箱。 */
  allPaths: boolean;
  /** 声明免沙箱；是否真正生效取决于部署侧环境开关。 */
  unsandboxed: boolean;
  /** 从会话工具面移除的工具名（基线过滤，先于 tool_extra）。 */
  toolDeny: string[];
}

/** GET /api/permissions/presets —— 内置三档 + 自定义档 + 运行时封顶 max。 */
export interface PermissionPresetsResp {
  ok?: boolean;
  builtin?: PermissionPreset[];
  custom?: PermissionPreset[];
  /** CELESTEA_PERMISSION_MAX：运行时封顶档位 id（可能低于用户所选档）。 */
  max?: string;
  warnings?: string[];
  error?: string;
}

/** 服务端解析出的**生效**能力（已过封顶）；界面原样展示，不自行折算。 */
export interface PermissionEffective {
  network: boolean;
  workspaceWritable: boolean;
  toolRootsWritable: boolean;
  writeRoots: string[];
  /** 生效的整机可读写（被运行时封顶收窄后）。 */
  allPaths: boolean;
  unsandboxed: boolean;
  toolDeny: string[];
}

/** GET/PUT /api/sessions/{id}/permission —— 该会话选中的档位 + 生效快照。 */
export interface SessionPermissionResp {
  ok?: boolean;
  session?: string;
  /** 选中的档位 id（GET 时为封顶后的生效 id）。 */
  preset?: string;
  effective?: PermissionEffective;
  warnings?: string[];
  error?: string;
}

/** POST/PUT /api/permissions/presets[/{id}] 的响应。 */
export interface PermissionPresetResp {
  ok?: boolean;
  preset?: PermissionPreset;
  error?: string;
}

/** DELETE /api/permissions/presets/{id} 的响应。 */
export interface PermissionPresetDeletedResp {
  ok?: boolean;
  deleted?: string;
  error?: string;
}
