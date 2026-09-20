# 特性设计 · 模型向用户提问（ask_user_question）

> 📦 **历史文档**。本文件是**已实现决策的归档记录**（为什么这样设计、当时的验收标准），
> W893 起从 `docs/` 移入 `docs/archive/decisions/`。它**不是**现行口径：
> 当前行为请看 `contracts/`（线格式）、[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)（架构规则）、
> 以及各功能对应的现行文档。归档**不删除正文** —— 决策的理由仍然可查。

> 状态：**历史参考**（本决策**已实现**）。本文是当时的决策依据与验收记录，**不再随代码更新**；现行行为见 [`docs/README.md`](../../README.md) 与 [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)。原状态：已实现（W783 后端 + W784 前端，2026-09-15）。落地见 `packages/core/src/question.ts`、`apps/studio/src/user-questions.ts`、`packages/tools/src/tools/ask-user.ts`、`apps/web/src/ui/question/`；seam 已登记进 [`ARCHITECTURE.md
> 依赖：[`ARCHITECTURE.md`](../../ARCHITECTURE.md) 的 seam 纪律；`packages/core/src/event-bus.ts` 的 waterfall 原语（**本设计新增的异步版本 `runWaterfallAsync` 已落地，同步 API 未动**）。
> 借鉴来源：**DSH 官方实现**（`@deepseek-ai/dsh-user-questions` + `dsh-tool-ask-user` + `dsh-client-ui-user-questions`）—— 三层拆分、工具 schema、答案编码、挂起/唤醒机制**均对齐官方**；本仓只做四项增量：异步 waterfall 适配、最大等待时间、断线恢复、本地化。
> 一句话目标：模型在回合中调用 `ask_user_question` 向用户提问（选项 + 自定义输入），**挂起等待**作答，答案作为**普通工具结果**回传模型继续推理。

---

## 0. 结论速览

| # | 设计决定 | 落点 |
|---|---|---|
| A1 | **三层拆分**（对齐 DSH）：core 定服务接口 → 宿主实现 → 工具调用；UI 作为 answerer 挂在 waterfall 上 | `core/question.ts`、`apps/studio/src/user-questions.ts`、`packages/tools/src/tools/ask-user.ts`（均新增） |
| A2 | **答案经 waterfall 返回值直接 resolve** —— **不**经 `POST /api/turn` 消息注入 | §4.2、§5.1（**绕开死锁的关键**） |
| A3 | 新增 **`runWaterfallAsync`**；同步 `runWaterfall` **一行不动**（零回归） | `packages/core/src/event-bus.ts` |
| A4 | 工具名 **`ask_user_question`**，参数/答案 schema **照抄 DSH** | §3 |
| A5 | **最大等待时间**（DSH 无，本仓增量）：绝对 `expires_at` + 读时判定 + `setTimeout` 主动唤醒 | §6 |
| A6 | **超时不由系统替代决策**：返回 `{answered:false, timed_out:true}`，由**提示词**引导模型自行决定 | §6.3 |
| A7 | **断线恢复**：提问/回答落 session log；前端重连拉未决列表重建卡片 | §7 |
| A8 | **语义本地化**：采纳 DSH 语义（`(Recommended)` 约定、`selected` 用 **label**、`intent` 呈现可换而协议不变）+ 中文文案 | §8 |
| A9 | 子 agent 防护：**只有精确 live 根 agent 可提问**；被拥有的子 agent 提问直接拒绝 | §5.3 |

---

## 1. 需求

模型需要**人类决策**（确认 / 二选一 / 补充缺失信息）时：
1. 调工具提问，可带若干**选项**（标签 + 可选一句说明）；
2. 用户可选**选项**，也可**自定义输入**；
3. 答案**回传模型**，模型继续推理；
4. 带**最大等待时间**（超时不阻塞会话）；
5. 尽量做成**官方可插拔插件**。

---

## 2. 现状：为什么今天做不到

### 2.1 已有地基（可复用）

| 能力 | 位置 | 说明 |
|---|---|---|
| `ask` 决策类型 | `packages/core/src/types.ts:278` | `ToolDecision = allow \| deny \| ask` 早已存在 |
| `ask` 展示链路 | `registry.ts:74-76` → `runtime/src/frames.ts:39-45` → `apps/web/src/ui/toolcards.ts:228-232` | 后端发、SSE 传、前端显示「待确认」 |
| **waterfall 原语** | `packages/core/src/event-bus.ts` | 已存在（**但同步**，见 §5.2） |
| 可取消等待内核 | `packages/workers/src/mailbox.ts:108-127` | `recv(to, signal)` 的 park/wake/abort，语义可借鉴 |
| 工具构造注入依赖 | `packages/tools/src/tools/run-shell.ts:66` | `runShellTool({sandbox, processes})` 既有模式 |
| 前端模态骨架 | `apps/web/src/ui/confirm.ts:35` | `confirmDialog` 的遮罩/键控/`overlays` 层级栈 |
| 绝对过期 + 读时判定 | `apps/studio/src/store/grants.ts:257-259` | `isExpired`：`now >= expires_at`，**不依赖定时器** |

### 2.2 结构性缺口

**缺口 1：`ask` 目前是「拒绝」不是「挂起」。**

```ts
// packages/tools/src/registry.ts:74-76
if (decision.kind === "deny") return decisionFailure(input.call_id, "deny", decision.reason);
if (decision.kind === "ask")  return decisionFailure(input.call_id, "ask",  decision.reason);  // ← 与 deny 同构
```

`ask` 只产生一条错误结果即结束，**不保存状态、不等待、不重试**；全仓（排除测试）**无任何 `{kind:"ask"}` 生产者**。

**缺口 2：⚠️ 死锁 —— 挂起期间「用户回答」进不来。**（已核实，本设计核心约束）

1. 工具被 `await`（`packages/agent-loop/src/loop.ts:306-308`），工具体内可无限等待；
2. 等待期间该会话 **TurnRunner 单槽被占**（`packages/runtime/src/turn-runner.ts:136`）；
3. 用户此时 `POST /api/turn` **不会 409**，而是被当 steering 注入 `next-step` 车道（`apps/studio/src/handlers/dialog.ts:72`）；
4. steering **只在步骤边界 drain**（`loop.ts:197-199`）—— 工具卡在 `await`，**永远走不到下一个边界**。

> **结论：把用户回答当一条 user message 注入行不通。** 必须有**直接 resolve 挂起 promise** 的旁路（DSH 即如此）。

**缺口 3：`packages/tools` 拿不到 Context。** `packages/tools` 只依赖 `@celestea/core`（L1 约束），`ToolRegistry.dispatch(input)` 无 Context 参数（`core/src/tool.ts:58-70`）。**解法：工具构造时注入**（照 `runShellTool`）。

**缺口 4：`decision` 不落 session log。** `tool_result` 无 `decision` 字段 —— 只进 SSE 事件，**不进日志**，故提问状态无法持久化。§7 专门解决。

---

## 3. 对外契约（照抄 DSH）

### 3.1 工具参数

```jsonc
{
  "questions": [{
    "id":          "q1",            // required，稳定 id，回显在答案里
    "question":    "选哪个方案？",   // required
    "header":      "确认",           // 可选短标题
    "detail":      "...",           // 可选补充说明（与选项标签分开）
    "options": [                     // 可选；不传则纯自由输入
      { "label": "方案 A（推荐）", "description": "一句权衡说明" }
    ],
    "multi_select": false            // 可选，默认单选
  }]
}
```

### 3.2 工具输出

```jsonc
{
  "answers": [
    { "id": "q1", "selected": ["方案 A（推荐）"], "custom": "可选自由文本" }
  ],
  "timed_out": false            // 本仓增量：超时专用
}
```

**三条语义约定（采纳 DSH）**：
1. **`selected` 存 label 不存索引** —— DSH 原文 *"Named rather than positional so no UI infers the verdict from option order."*
2. **推荐项用文案约定**：描述写明把推荐项放首位并加 `(Recommended)`（中文本地化为「（推荐）」）。
3. **`detail` 与选项标签分开**，`detail` 不参与 label 匹配。

### 3.3 `intent` 机制（呈现可插拔）

```jsonc
{ "intent": { "kind": "plan-review", "approve": "批准" } }
```

标记「这是什么类型的决策」，UI 可据此换呈现（如把 plan 渲染成文档 + 批准/驳回），**但答案编码完全相同** —— DSH 原文 *"an intent changes presentation only, never the protocol."*

校验：`approve` 必须命中本问题某 option 的 label，且必须提供 `detail`；否则 `BAD_INTENT`。

---

## 4. 架构

### 4.1 分层（对齐 DSH，落在本仓层级里）

```
packages/core/src/question.ts        ← 服务接口 + token + 错误分类（L1 只加类型）
packages/core/src/event-bus.ts       ← 新增 runWaterfallAsync（不改同步 API）
        ↑
apps/studio/src/user-questions.ts    ← 服务实现：校验 + waterfall 调度 + 超时
apps/studio/src/question-registry.ts ← PendingQuestion 表
        ↑
packages/tools/src/tools/ask-user.ts ← ask_user_question 工具（构造注入服务）
        ↑
apps/studio/src/handlers/questions.ts← POST 作答 + GET 未决列表（§7）
apps/web/src/ui/question.ts          ← 提问卡片
```

**为什么这样分**：`core` 只放接口（保持 L1）；实现在宿主（可被 fake 覆盖，符合 `NamedRegistry` last-wins 意图）；工具**构造注入**服务 —— 照抄 `runShellTool({sandbox, processes})`，**不破坏层级**。

### 4.2 数据流（关键：答案直接 resolve）

```
模型 → tool_call: ask_user_question({questions})
  → 工具 execute()
  → 服务 ask() → 生成 request_id，登记 pending，emit SSE
  → ctx.waterfall("user-questions/request", ...) ← 挂起 await
前端收到 SSE → 渲染提问卡片（选项 + 自定义输入 + 倒计时）
用户提交 → POST /api/questions/{id}/answer
  → PendingQuestion.answer() → #resolve(answer)
  → waterfall 返回 → 工具拿到答案
  → 作为普通 tool_result 回传模型 → 模型继续推理
```

**⚠️ 全程没有用到 `POST /api/turn`。** 答案走「waterfall 返回值」直接唤醒挂起的 `await` —— 这正是绕开 §2.2 缺口 2 的机制。

---

## 5. 挂起与唤醒机制

### 5.1 `PendingQuestion`（照抄 DSH，四件套）

| 成员 | 作用 |
|---|---|
| `Promise.withResolvers()` | 持有 `#resolve`/`#reject`；`result` 即交给 waterfall 的 Promise |
| `answer(a)` | 用户提交 → `#resolve(a)` → 唤醒 Host |
| `cancel()` | 用户关闭 → `#reject(ASK_CANCELLED)` |
| `abort(reason)` | 传输/作用域/插件生命周期结束 → reject |
| `delegate()` + `isDelegation()` | 本层不处理 → 交给 waterfall 下一层（**可组合性来源**） |
| `#signal` + `#onAbort` | `addEventListener('abort', onAbort, { once: true })`；`finish()` 里 `removeEventListener`（**无泄漏**） |
| `finish(settle)` | **幂等保护**：已 settled 再 settle **直接抛错**，把 bug 暴露出来 |

### 5.2 异步 waterfall（本仓唯一必要的 core 改动）

现状：`packages/core/src/event-bus.ts:83-89` 的 `runWaterfall` **同步**（`value = fn(event, value)`，无 await）。

**方案：新增 `runWaterfallAsync`**：
```ts
runWaterfallAsync<E, R>(key: EventKey<E>, event: E, init: () => Promise<R>): Promise<R>;
```
语义对齐 DSH：每层 listener 收 `(event, next)`，**返回答案即认领**，调 `next()` 则委托下一层；无人认领时 `init()` 兜底（抛 `NO_PROVIDER`）。

**保留同步 `runWaterfall` 不动**（实测全仓 `grep 'waterfall('` **零命中**，seam 闲置，但不动即零回归）。

### 5.3 子 agent 防护（照抄 DSH）

| 错误码 | 触发条件 |
|---|---|
| `CALLER_NOT_LIVE` | 传入 agent 不是 registry 里的**精确 live 实例** |
| `DELEGATED_CALLER` | 该 live agent 被**另一个 agent 拥有**（子 agent）→ 提示把未决问题写进子 agent 最终结果 |
| `NO_PROVIDER` | 无 answerer 认领 |
| `ASK_ABORTED` | signal 已/变为 aborted |
| `EMPTY_QUESTIONS` | `questions` 为空 |
| `BAD_INTENT` | `intent.approve` 未命中选项，或缺 `detail` |

> 理由（DSH 原文）：被拥有的子 agent **没有人类 answerer，会永久阻塞**，必须显式拒绝而非硬等。

---

## 6. 最大等待时间（本仓净增量）

> DSH 全链**无任何超时/TTL**（严格 grep 四个相关包均零命中）。DSH 把等待视为无上限，靠 abort signal 收尾。故本节**自设计**。

### 6.1 双轨设计

| 轨 | 作用 | 实现 |
|---|---|---|
| **权威判定** | 可持久化、重启后仍正确、重连可见剩余时间 | 存**绝对 `expires_at`**，**读时比较**（仿 `grants.ts:257-259`） |
| **主动唤醒** | 到点必须 settle，否则工具永久悬挂 | `setTimeout` → 调 `pending.timeout()`；**settle 后 `clearTimeout`** |

### 6.2 与用户回答的竞态

超时与用户回答**谁先到谁赢**，后者落空；由 `finish()` 幂等保护保证**不双重 settle**。

### 6.3 超时后的行为（**由提示词引导模型自行决定**）

**系统不替模型决定**：不自动选默认项、不终止 turn。超时后返回：

```jsonc
{ "answers": [], "timed_out": true }
```

并在**工具描述**写明语义，要求模型**据此继续**（自行判断/降级/说明后继续），**不要重复提问**。

### 6.4 参数与默认值

| 项 | 值 |
|---|---|
| `DEFAULT_ASK_TIMEOUT_MS` | `300000`（5 分钟） |
| 工具参数 `timeout_ms` | 可选，覆盖默认；设上限（建议 ≤ 3600000） |

---

## 7. 断线恢复

### 7.1 现状

`contracts/session-event.schema.json` 现有 **11 种事件**：`assistant_message` / `thinking_delta` / `tool_call` / `tool_result` / `turn_start` / `turn_end` / `user_message` / `cancelled` / `completed` / `interrupted` / `step_limit` —— **无提问/回答事件**。

### 7.2 方案

1. **新增 session 事件**（`user_question` / `user_answer`）→ 动 schema + 手写 codec + `projectMessages` 投影 + 前端渲染；
2. **前端重连拉未决列表**：新增 `GET /api/sessions/{id}/questions?pending=1`，据此重建卡片（含剩余时间）；
3. **契约三方对拍**：`tests/contract-parity.test.ts` 已有「schema vs 手写 codec vs 真实事件流」机制，**新事件必须让它通过**；
4. **恢复语义**：进程重启后 pending 表丢失 → 该提问**不可再答**，前端显示为「已过期/未回答」终态，且恢复时**不阻塞模型**。

---

## 8. 语义本地化

| DSH | 本地化 |
|---|---|
| `(Recommended)` | 「（推荐）」—— 工具描述与 UI 一致 |
| `approve` label | 由 `intent` 指定，UI 按 label 匹配（不变） |
| 工具描述 | 参考 DSH 措辞中文化，并补超时语义（§6.3） |
| UI 文案 | 全部中文；须过 `tools/check-ui-copy.mjs` 门禁（**用户可见中文文案禁出现实现细节词**） |

---

## 9. 实施分解

| # | 改动 | 文件 | 负责 |
|---|---|---|---|
| 1 | 服务接口 + token + 错误分类 | `packages/core/src/question.ts`（新） | A 后端 |
| 2 | `runWaterfallAsync` | `packages/core/src/event-bus.ts` | A |
| 3 | 服务实现（校验 + 调度 + 超时） | `apps/studio/src/user-questions.ts`（新） | A |
| 4 | `PendingQuestion` 表 | `apps/studio/src/question-registry.ts`（新） | A |
| 5 | `ask_user_question` 工具 | `packages/tools/src/tools/ask-user.ts`（新） | A |
| 6 | 装配注册 | `packages/tools/src/builtin.ts`、宿主 engine-plugins | A |
| 7 | 作答 + 未决列表端点 | `apps/studio/src/handlers/questions.ts`（新）+ `contracts/endpoints.json` | A |
| 8 | session 事件（提问/回答） | schema + codec + 投影 + 契约对拍 | A |
| 9 | SSE 事件 `question` | `contracts/sse-events.json` + `frames.ts` | A |
| 10 | 提问卡片 UI | `apps/web/src/ui/question.ts`（新） | B 前端 |
| 11 | SSE 接线（**4 处**） | `apps/web/src/sse.ts`、`types.ts`、`chat.ts`、UI | B |
| 12 | 断线恢复 UI | `apps/web/src/` | B |
| 13 | 倒计时显示 | 卡片内 | B |
| 14 | 提示词/工具清单同步 | `contracts/tools.json`、`builtin-sections.ts`（**字节冻结门禁**） | A + B |

**注**：B 的前端接线依赖 A 的 SSE 事件与端点契约，故 **A 先出契约、B 再接线**；两者可在契约冻结后并行。