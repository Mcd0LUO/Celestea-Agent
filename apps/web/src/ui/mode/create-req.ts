// ============================================================================
// ui/mode/create-req.ts — 新建会话请求体组装（W788；纯函数，零 DOM）。
//
//   权威依据：docs/modes-standard-vs-execution.md §3.1（P0：POST /api/sessions
//   请求**纯增**可选 mode）、§2.2 #1 / K8（缺省 standard 且**不写该键**，保持与
//   今天逐字节一致；M3 断言的就是这条）。
//   拆成纯函数是为了能在 node/jsdom 里直接断言「请求体带不带 mode」，
//   而不必去点弹窗（本机无浏览器，见 tests/session-mode-dom.test.ts 的说明）。
// ============================================================================
import type { SessionCreateReq } from '../../types';

/** 弹窗控件的原始取值（空串 = 未选）。 */
export interface CreateReqInput {
  workspace: string | null;
  title: string;
  /** 空串 = 跟随默认。 */
  model?: string;
  /** 空串 = 跟随默认。 */
  prompt?: string;
  /** 下拉选中值；空串 = 默认（标准模式）。 */
  mode?: string;
}

/**
 * 组装 `POST /api/sessions` 请求体。
 *   1. `prompt`：非空才带（W245 现状不变）；
 *   2. `mode`：**只在非默认（execution）时带** —— 缺省 standard 的请求体与今天
 *      逐字节一致（K8/M3：无 mode 键 = standard，session.json 不多写键）；
 *   3. `includeOptional=false`（老服务 4xx 的降级重试）：丢掉 `model` 与 `mode`
 *      两个**新增**可选键，与今天「重试不带 model」同款（旧后端可能不认新字段）。
 */
export function buildCreateReq(input: CreateReqInput, includeOptional = true): SessionCreateReq {
  const req: SessionCreateReq = { workspace: input.workspace, title: input.title };
  const prompt = input.prompt ?? '';
  if (prompt !== '') req.prompt = prompt;
  if (!includeOptional) return req;
  const model = input.model ?? '';
  if (model !== '') req.model = model;
  if (input.mode === 'execution') req.mode = input.mode;
  return req;
}
