# 迭代方向 E · 模型降级回退（§4）

> 状态：**设计（未实现）** ｜ 本册是 [`README.md`](./README.md) 的分册：FallbackLlm 装饰器与触发规则。
> 章节编号沿用原文；总览与跨能力结论见索引。

---

## 4. 模型降级回退（model fallback）

### 4.1 现状与缺口

**已经成立的**：三档超时语义清晰且可配（`timeouts.ts:1-16,54-58`，env > profile > 默认，0 = 关闭）；`LlmError` 已带 `kind`/`isTimeout`/`timeoutStage`（`errors.ts:16-39`）；`LlmRegistry` 是按名注册的 last-wins 多 provider seam（`core/llm.ts:21-39`）；宿主侧已有 `providers.json` 与 `resolveProviderTarget`（`provider-target.ts`）。

**缺口**：

| ID | 缺口 | 后果 |
|---|---|---|
| G4-1 | 非 2xx 的状态码只在**文案**里（`client.ts:175`），`LlmError` 无 `httpStatus` | 无法机械判定 429/5xx 可重试、401/403 不可回退 |
| G4-2 | 零重试、零回退（`client.ts:132-146` 单次尝试） | 上游抖动 = 整轮失败 |
| G4-3 | profile 12 键冻结（`profile.ts:8-36`），无回退链字段 | 回退链无处配置（且扩 profile = 改冻结契约） |
| G4-4 | 无 attempt 账 | 回退会重复计费且不可见（与 G3-4/G3-6 同源） |
| G4-5 | 部分流已产生时无止损规则 | 若整轮重做：用户已看到的文本消失、上游重复计费；若 step 内已执行工具：**副作用双写** |
| G4-6 | 没有"这次回答来自哪个模型"的可见字段（statusline 的 `model` 是配置值，`real-runtime-adapter.ts:358-374`） | 静默降级无法被发现（本能力的第一红线） |
| G4-7 | 无法观测"劣化"（慢但在超时内、失败率升高） | 只能做**可用性回退**，做不了质量回退（后者不可机械判定，明确不做） |

### 4.2 目标契约

#### 4.2.1 回退链 = `Llm` 的装饰实现（不是新 seam）

新增 `packages/llm/src/fallback.ts`：`createFallbackLlm({ targets, policy, onAttempt })`，返回一个 `Llm`。
每个 target 有自己的 client（自己的 `base_url`/`api_key_env`/三档超时），因此**三档超时语义逐字不变**（回退不改变"多久算失败"，只改变"失败后谁接"）。

```ts
interface LlmTarget { name: string; provider: string; model: string; baseUrl?: string; apiKeyEnv?: string; }
interface FallbackPolicy {
  maxAttempts: number;            // 默认 2（1 主 + 1 回退）
  cooldownMs: number;             // 默认 60_000（target 级冷却）
  failureThreshold: number;       // 默认 3（连续失败进冷却）
  notRetryableStatuses: number[]; // 默认 [400, 401, 403, 404, 422]
  retryableStatuses: number[];    // 默认 [408, 425, 429, 500, 502, 503, 504]
  respectRetryAfter: boolean;     // 默认 true（P1 读 retry-after 头，上限 = cooldownMs）
}
```

#### 4.2.2 触发与止损规则表（逐条可检）

| 触发条件 | 判据（结构化） | 动作 |
|---|---|---|
| 连接超时 / DNS / TCP | `isTimeout && timeoutStage==="connect"` | 下一个 target |
| 响应头超时 | `isTimeout && timeoutStage==="response"` | 下一个 target |
| 429 / 5xx / 408 / 425 | `httpStatus ∈ retryableStatuses` | 下一个 target（遵守 `retry-after`） |
| 401 / 403 / 400 / 404 / 422 | `httpStatus ∈ notRetryableStatuses` | **终止**（换模型无用，属配置/凭据/请求问题）→ 显式报错 |
| 流 idle 超时，**未产出任何 text/tool_call** | `kindOf==="timeout"` 且 `produced===0` | 下一个 target |
| 流 idle 超时，**已产出** | `produced>0` | **终止**（不重做：避免重复计费与副作用双写） |
| 流撕裂（`kindOf==="stream"`）未产出 | `produced===0` | 下一个 target |
| 流撕裂且已产出 | `produced>0` | 终止 |
| 达到 `maxAttempts` | — | 终止，返回最后一次错误（`TurnOutcome{error}` 或 `interrupted`） |
| target 连续失败 ≥ `failureThreshold` | 计数器 | 进冷却 `cooldownMs`，冷却期内不作为首选 |

**"已产出"的判定**：装饰器包装 `LlmStream`，在转发事件时计数 `text/thinking/tool_call` 事件数；`>0` 即锁定"不可重做"。这是**唯一**能保证"不重复副作用"的机械判据（`agent-loop` 只在 `sawDone` 时落 `assistant_message`，见 `loop.ts:246-253`，因此重做会丢已显示文本）。

#### 4.2.3 显式可见（反对静默降级，五条硬要求）

1. **账本**：每次 attempt 一行（能力 3 的 `attempt` + `fallback_from` + `model`）；
2. **SSE**：切换时发一帧 **`status`**（事件名冻结，见 K5），payload 纯增字段 `{phase:"fallback", from, to, reason, attempt}`——**不新增事件名**；
3. **审计**：本地 `fallbacks-audit.jsonl` + best-effort 平台 `POST /api/audit`（复用 grants §4.4 的双通道纪律）；
4. **statusline**：`/api/status` 增 `effective_model`（实际生效）与 `fallback:{active, chain, last_reason}`；`model` 字段语义**不变**（配置值）；
5. **日志/报告**：失败 attempt 的错误文本进入该轮的 `TurnOutcome{error.message}`（既有路径），带 target 名。

#### 4.2.4 配置来源（不扩冻结 profile）

`<data dir>/fallbacks.json`（或 env `CELESTEA_LLM_FALLBACKS` = 同一 JSON）+ `CELESTEA_LLM_FALLBACK=on|off`（默认 **off**）。

```jsonc
{ "version": 1, "enabled": true,
  "targets": [ { "name": "primary", "provider": "deepseek", "model": "deepseek-chat" },
               { "name": "backup",  "provider": "openai-compat", "model": "gpt-x", "baseUrl": "…", "apiKeyEnv": "BACKUP_API_KEY" } ],
  "policy": { "maxAttempts": 2, "cooldownMs": 60000, "failureThreshold": 3 } }
```

**诚实取舍**：也可以把回退链放进 `Profile`，但 `Profile` 是**冻结的 12 键契约**（`profile.ts:1-6`），扩它要向 `contracts/` 同步；本条能力选择"侧车配置 + 装饰器"，使回退对引擎其余部分**零侵入**（`SessionComposer.llmFactory()` 一行替换）。

### 4.3 分期

| 阶段 | 内容 |
|---|---|
| **P0** | `LlmError` 增 `httpStatus: number \| null` + `retryable: boolean`；`client.assertSuccess` 构造时带上状态码；**行为零变更**（只是错误对象更结构化）+ 单测 |
| **P1** | `fallback.ts` 装饰器 + 规则表 + `produced` 计数 + 冷却（内存）+ 账本/审计挂钩 + statusline/SSE 字段 + `notRetryableStatuses` 硬断言 + `retry-after` 遵守 |
| **P2** | 冷却状态持久化（`<data dir>/llm-cooldown.json`，重启不丢）+ `context_length_exceeded` 特例降级（到更大窗口 target）+ 与能力 3 的预算联动（超预算 → 强制低档 target 或拒绝）+ targets 由 `providers.json` 自动派生 |

### 4.4 验收标准（机械可检验）

| # | 场景 | 断言 | 落点 |
|---|---|---|---|
| D1 | `statusError(429, body)` | `e.httpStatus===429 && e.retryable===true`；`statusError(401)` → `retryable===false`；超时错误 → `httpStatus===null` | `packages/llm/src/errors.test.ts` |
| D2 | 假上游：target#1 → 503，target#2 → 正常流 | 最终产出 `done`；两 target 调用次数 `[1,1]`；`onAttempt` 被调 1 次且 `reason==="http_503"` | `packages/llm/src/fallback.test.ts` + `mock-upstream.test-util.ts` |
| D3 | 401/403/400 | 只尝试 **1** 次（计数断言）；错误直接抛出，`ok===false` | 同上 |
| D4 | target#1 先产出 3 个 text 帧再撕裂 | **不**调用 target#2；终态为流错误（`{error:{kind:"stream"}}`/`interrupted`）；不含 `assistant_message`（既有语义） | `packages/agent-loop/src/loop.test.ts` 延伸 |
| D5 | 切换时 | `status` 帧 payload 含 `phase:"fallback"`+`effective_model`；`/api/status.model` == 配置值 且 `.effective_model` == 实际模型（两条独立断言） | `apps/studio/src/app-domains.test.ts` |
| D6 | 三次 attempt（503、idle 超时、成功） | 账本 2 行 `error` + 1 行 `ok`，`attempt` = 0/1/2，`fallback_from` 链正确，`turn_total.attempts===3` | `packages/llm` + `packages/runtime/src/ledger.test.ts` |
| D7 | 冷却（注入假 clock）：target#1 连续 3 次失败 | 60s 内新 turn 的**首选** target 变为 target#2；60s 后恢复首选 | `fallback.test.ts` |
| D8 | 契约 | `contracts/sse-events.json` 的事件名集合**逐字不变**（8 个）；`status` payload schema 以 optional 登记新字段并校验通过 | `tests/contracts.test.ts` |
| D9 | 关闭开关 | `CELESTEA_LLM_FALLBACK=off`（默认）时行为与今日**逐字一致**（调用次数 1、无新帧、账本 1 行） | `fallback.test.ts` |

### 4.5 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R4-1 | 质量劣化无法机械判定 | 明确**只做可用性回退**；质量回退不做（也不做"自动降智"） |
| R4-2 | 半途重做 → 重复计费/副作用双写 | "已产出即不重做"硬规则（`produced>0` 锁）；账本 attempt 维度使重复可见 |
| R4-3 | 回退链涉及多个凭据 env | 只读 env、只记 env **名**（不记值）；`describe()`/日志不含 key（沿用 `client.ts:17-20` 的既有纪律） |
| R4-4 | 429 带 `Retry-After` 被忽略 | P1 读 header，等待上限 = `cooldownMs`，超上限直接下一个 target |
| R4-5 | 与平台侧既有限流/多 key 轮换重叠 | 声明边界：本条只处理"引擎内单次请求失败后的目标切换"，不做 key 轮换、不做配额池 |
| R4-6 | 回退掩盖真实故障（"一直能用"） | statusline/审计/账本三处可见 + `failureThreshold` 冷却 + P2 的预算联动 |

### 4.6 与现有模块的接缝

| 模块 | 改动 | 类型 |
|---|---|---|
| `packages/llm` | `errors.ts`（+`httpStatus`/`retryable`）、`client.ts`（`assertSuccess` 带状态码）、新 `fallback.ts`、`index.ts` 导出 | 包内变更 + 新增实现 |
| `packages/core` | **不改**（`Llm`、`LlmError` 语义不变；状态码是实现细节） | — |
| `packages/agent-loop` | **不改**（回退发生在 `Llm` 之内，`loop.ts` 无感）——这是选择装饰器而非改 loop 的理由 | — |
| `packages/runtime` | 账本 attempt 挂钩（经 `UsageAccounting` 装饰） | 装配 |
| `apps/studio` | `llm-assembly.createEngineLlm()` 按开关包一层 `FallbackLlm`；`/api/status` 增 `effective_model`/`fallback` | 装配 + 契约增字段 |
| `contracts/` | `sse-events.json`（status payload 增 optional 字段）、`endpoints.json`（`get_status` 响应增字段）、`data-files/fallbacks.schema.json` + `llm-cooldown.schema.json` | 契约变更 |

---

### 4.7 实现状态（W785 回填，P1）

| 设计条目 | 状态 | 落点 / 说明 |
|---|---|---|
| ① `fallback.ts` 装饰器 + 规则表 + `produced` 计数 + 冷却（内存） | **已实现** | `packages/llm/src/fallback.ts`：`createFallbackLlm({targets, clientFor, policy, state, onAttempt, steps})`；规则表数据外提为 `DEFAULT_FALLBACK_POLICY`；`FallbackState`（进程级，连续失败 ≥ `failureThreshold` → `cooldownMs` 内靠后） |
| ② 账本 hook（每 attempt 一行） | **已实现** | 装饰器接受**结构型** `FallbackStepSink`（= runtime 的 `LedgerStepSink`，两层不互相依赖）：`beginStep(attempt, fallback_from)` → 每个 usage 帧 `record` → 流终态 `close` |
| ③ 审计双通道 | **已实现** | `apps/studio/src/runtime/fallback-host.ts`：本地 `<data dir>/fallbacks-audit.jsonl`（0600，超 16 MiB 轮转，权威）+ best-effort 平台 `POST /api/audit`（`CELESTEA_AUDIT_URL` 未设 = 只跑本地；投递失败如实记 `platform_audit_failed`）。只记 target 名/原因，零凭据 |
| ④ statusline + SSE 可见 | **已实现** | `/api/status` 纯增 `effective_model` 与 `fallback{active,chain,effective_model,last_reason,targets,problems}`（`model` 语义不变）；SSE `status` 帧 `phase:"fallback"` + `from`/`to`/`reason`/`attempt`/`effective_model`，**事件名集合不变**（K5/D8） |
| ⑤ `notRetryableStatuses` 硬断言（401/403/400 只试 1 次） | **已实现** | `statusRetryable()`；D3 三例 |
| ⑥ `Retry-After` 遵守（上限 `cooldownMs`） | **已实现** | 捕获点在 `client.assertSuccess`（响应还在手上时读 header），经 **WeakMap 侧信道**挂在错误对象上（`setRetryAfterMs`/`retryAfterMsOf`）——`core` 的 `LlmError` 字段与文案逐字未变（K7/§4.6）；超上限则不等、直接下一个 target |
| ⑦ 装配（开关默认关） | **已实现** | `session-compose.engineLlm()` 是唯一分叉点：`CELESTEA_LLM_FALLBACK` 关（默认）→ 返回**今日路径**（`createLedgerLlm` 包一层），D9 逐字一致；开 → 装饰器（每 attempt 一行账） |
| ⑧ 配置来源（不扩冻结 profile） | **已实现** | `<data dir>/fallbacks.json` 或 `CELESTEA_LLM_FALLBACKS`（同 JSON）；`profile` 12 键未动；`contracts/data-files/fallbacks.schema.json` + `index.json`（11 → 12） |

**偏离与取舍（逐条）**：

1. **`onAttempt` 的语义 = "发生了切换"**，不是"某次尝试失败"：只有真的换 target 时才回调（终态失败与 `produced>0` 锁都不回调）。因此 SSE 帧的 `attempt` 是**即将运行**的那次尝试序号，`reason` 是刚被放弃的 target 的失败原因 —— 这正是 §4.2.3 #2 "切换时发一帧" 的字面语义，也让 D2 的"`onAttempt` 恰好 1 次"成立。
2. **D4 的落点在 `packages/llm/src/fallback.test.ts`（流级），不在 `agent-loop/loop.test.ts`**：`loop.ts` 一行未改是选择装饰器的**理由**（§4.6），"已产出即不重做"是装饰器的机械判据；"无 `assistant_message`" 由既有 loop 语义（只在 `sawDone` 时落行）保证，本次未改该文件。
3. **D5 的两个半边分别落在 `apps/studio/src/runtime/fallback-host.test.ts`（SSE 帧，捕获 bus 回调）与 `fallback-status.test.ts`（HTTP 层：`model` 与 `effective_model` 两条独立断言）**；未做"真实上游 + 浏览器"的端到端（红线：不打真实上游）。
4. **链为空时的行为**：`enabled:true` 但 `config.targets` 为空 → 用 composed profile 自身作为唯一 target，并把 "no targets configured" 记进 `fallback.problems` + 审计 `target_unavailable`（U7：**不得静默跳过**）。
5. **未实现（属 P2，§4.3）**：冷却持久化（`llm-cooldown.json`，重启不丢）、`context_length_exceeded` 特例降级、与能力 3 预算联动、targets 由 `providers.json` 自动派生。

**U7 盘点结论（本次已核实的行为，而非猜测）**：凭据只按 **env 名**读取与记录；`targetAvailability()` 对每个 target 给出 `available`（`apiKeyEnv` 未设视为继承主 profile → available），不可用的 target 出现在 `/api/status.fallback.targets[].available=false` 与 `problems[]`，并各写一条 `fallbacks-audit.jsonl`。生产 `providers.json` 是否提供第二个可用凭据属运维事实，本能力**不依赖它**：缺凭据时行为是"显式报不可用"，不是"静默失效"。

---

