// ============================================================================
// types/batch.ts — 通用回执与**批量端点**响应线格式（W792）。
//
//   为什么单独一个文件：types.ts 有模块体积棘轮（≤ tools/module-size-baseline.json
//   登记行数，只许降不许升），本轮为批量响应新增 failed[] 建模，按 W784 的
//   ./types/context、W788 的 ./types/mode 先例把 OkResp / ClearResp / CancelResp /
//   BatchIdsReq / BatchNamesReq 与本轮新增的 BatchFailedItem / BatchOpResp 整族拆出；
//   types.ts 原样再导出，调用方零改动。
//
//   BatchOpResp 的字面量来自对真实服务的实测（2026-09-16，http://127.0.0.1:3777）：
//     POST /api/sessions/batch-delete {"ids":["<归档会话>","<不存在的 id>"]} →
//       {"ok":true,"deleted":1,"failed":[{"id":"<不存在的 id>",
//        "error":"unknown session '<不存在的 id>'"}]}
//   即：**部分失败也返回 200 + ok:true**，失败项只在 failed[] 里 —— 调用方若只看
//   HTTP 状态码就会把失败当成功静默吞掉（W792 修的正是这一点）。
// ============================================================================

export interface OkResp {
  ok?: boolean;
  error?: string;
}

export interface ClearResp extends OkResp {}

export interface CancelResp extends OkResp {}

/** 批量端点请求体（会话 id 列表）。 */
export interface BatchIdsReq {
  ids?: string[];
}

/** 批量端点请求体（工作区名列表）。 */
export interface BatchNamesReq {
  names?: string[];
}

/**
 * 批量操作里的单个失败项。
 *   `error` 是**服务端原文**（如 `unknown session 'x'`）：只许写 console / 日志，
 *   不得拼进任何会渲染给用户的字符串（api.ts 的文案纪律：不透传服务端原文）。
 */
export interface BatchFailedItem {
  id?: string;
  error?: string;
}

/**
 * 批量端点响应（POST /api/sessions/batch-delete、POST /api/sessions/batch-archive）：
 *   `deleted` = 删除端点的成功条数，`archived` = 归档端点的成功条数（两者互斥出现）；
 *   `failed` 缺省 = 全部成功；非空 = **部分或全部失败**（`ok` 仍可能是 true）。
 *   legacy 服务只回 `{ok:true}`：此时 deleted/archived/failed 全缺省 —— 调用方按
 *   「无失败信息」处理，不得据此宣称具体条数。
 */
export interface BatchOpResp extends OkResp {
  deleted?: number;
  archived?: number;
  failed?: BatchFailedItem[];
}
