# 只读上下文快照：`GET /api/sessions/{id}/context`（W725）

前端「点上下文圆环看完整上下文」的后端端点。契约已冻结，前端按此逐字实现；
本文件是该端点的口径说明（`contracts/endpoints.json#get_session_context` 的 docRef）。

## §1 端点

```
GET /api/sessions/{id}/context          # id = <workspace>/<session>（URL 编码）
```

- 未知会话 → `404 {"ok":false,"error":"unknown session '<id>'"}`；容量拒绝沿用 503 + `Retry-After`。
- 只读：会话实例不存在时按 `entryFor` 路径**按需组装**（与 activate / 一轮 turn 同一条路），
  但**绝不起 turn**、不写日志、不消耗步骤预算。
- 不进 SSE：本端点不新增任何事件名。

## §2 组装口径（唯一真源 = 引擎）

模型实际看到的上下文 =
`packages/agent-loop/src/loop.ts` 的 `buildRequest(seams)`
= `{ model, system: config.system_prompt, messages: trimContext(deriveMessages()), tools: registry.schemas() }`。

因此本端点的 body **不是** host 重新拼的，而是：

```
HTTP handler → runtime.sessionContext(id) → Runtime.contextSnapshot()
             → contextSnapshotOf(loop, ctx) → DefaultAgentLoop.contextSnapshot(ctx)
             → this.buildRequest(resolveSeams(ctx))        // 与 turn 用的是同一个方法
```

- handler 不做任何 trim / derive；host 只做一次「扁平化投影」（`Message[]` → 每消息一行），
  因为线上契约的 `content` 是字符串。
- 投影规则（冻结）：
  - 一条消息的 content 块用 `"\n"` 连接；
  - `tool_call` 块渲染为 `[tool_call] <name> <紧凑 JSON args>`；
  - assistant 的工具调用行带**第一个**调用的 `tool_name` + `tool_call_id`；
  - `tool` 结果行带自己的 `tool_call_id`，并按消息顺序回填对应的 `tool_name`；
  - `role` 逐字透传：engine 历史里被 trim 出来的标记消息可能是 `system`，
    其余为 `user|assistant|tool`（不做映射，不隐藏——视图必须诚实）。
- `tools` 是 `registry.schemas()` 逐字透传（`name` / `description` / `parameters`），顺序即引擎顺序。

## §3 用量口径（复用 statusline，不另起一套）

`context = { used, window, ratio, estimated }` 就是 `GET /api/status` 的
`context_usage`（`packages/runtime/src/status.ts`）去掉 `method` 判别字段：

| 情形 | used | estimated | 原 method |
|---|---|---|---|
| 已见过 provider 的 usage 帧 | 最近一次请求的真实 `prompt_tokens` | `false` | `usage_prompt_tokens` |
| 尚无 usage 帧 | 会话日志的字符估算 | `true` | `session_event_chars` |

`window` 取该会话实例 profile 的 `context_window_tokens`。

## §4 截断（线上体积护栏）

- 单条 > **20000** 字符：截到 20000 字符。
  - message 条目 → 该条目加 `"truncated": true`；
  - 顶层 `system`（字符串，无处挂标记）→ 只体现在顶层 `truncated`；
- 顶层 `truncated` = 任一被截断（含 system）。
- `counts` 描述的是**实际发出的** payload（截断后）：
  `system_chars = system.length`、`tool_count = tools.length`、`message_count = messages.length`。

## §5 能力位

`GET /api/health` 的 `capabilities.context = true`（与 W516 的 `capabilities.grants` 并列）。
前端只在该位**恰为** `true` 时显示上下文入口，否则降级为不显示。

## §6 测试锚点

| 断言 | 位置 |
|---|---|
| 200 形状（字段齐全 / counts 自洽 / truncated=false） | `apps/studio/src/app-domains.test.ts` |
| 未知会话 404 逐字文案 | 同上 |
| 截断标记（条目 + 顶层） | 同上 |
| `capabilities.context === true` | 同上、`tests/studio-routes.test.ts` |
| 真实引擎路径：快照 = 引擎 buildRequest（无 host 侧漂移） | `apps/studio/src/runtime/real-runtime.test.ts` |
| 端点数 44（契约 / 常量 / 路由三方一致） | `tests/contracts.test.ts`、`apps/studio/src/app.test.ts`、`tests/studio-routes.test.ts` |
