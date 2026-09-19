# 迭代方向 E · 成本与用量账本（§3）

> 状态：**设计（未实现）** ｜ 本册是 [`README.md`](./README.md) 的分册：usage-ledger / pricing 的目标契约与聚合视图。
> 章节编号沿用原文；总览与跨能力结论见索引。

---

## 3. 成本与用量账本（cost & usage ledger）

### 3.1 现状与缺口

**已经成立的**：`usage` 帧解析覆盖三种 cache key 形状 + nested reasoning（`packages/llm/src/usage.ts:22-35,89-113`）；agent-loop 每个 `usage` 帧都 `record()`（`loop.ts:229-230`）；`cache_hit_ratio` 已派生（`runtime/usage.ts:67-71`）；statusline 输出 `latest` + `total`（`core/types.ts:191`）。

**缺口**：

| ID | 缺口 | 后果 |
|---|---|---|
| G3-1 | tracker 纯内存，重建实例即 `reset()`（`session-registry.ts:273-281` → 新 compose → 新 tracker） | 重启/配置变更/授权变更后用量归零，"总花费"不存在 |
| G3-2 | 无价格表 | token 无法变成本 |
| G3-3 | `total` 是会话累计、`latest` 是最后一次响应 | **"这一轮花了多少"不可得**（轮次粒度缺失） |
| G3-4 | 失败/重试无记账（失败响应通常没有 usage 帧） | 一次用户意图对应 N 次计费时不可见（与能力 4 直接冲突） |
| G3-5 | 有 `cache_read` 计数但无 cache 单价 | 缓存收益无法折算 |
| G3-6 | 无 attempt 维度 | 重试/回退无法在账上区分"必要花费"与"浪费" |
| G3-7 | 未定价模型静默按 0 计费 | 账本会**低报**且无告警 |
| G3-8 | 与平台侧（newapi 计费）与宿主侧（DSH `tokenUsage` 投影）无对账 | 三方口径漂移无人发现 |

### 3.2 目标契约

#### 3.2.1 账本形状（append-only）

`<data dir>/usage-ledger.jsonl`，一行一条 `UsageRecord`（与 `grants-audit.jsonl` 同风格：本地权威 + best-effort 平台双写）：

```jsonc
{
  "v": 1, "ts": 1760000000,
  "session": "ws1/cli-main", "turn": 7, "turn_id": "turn-7", "step": 2, "attempt": 0,
  "kind": "ok",                       // ok | error
  "error_kind": null,                 // generate | stream | timeout（kind=error 时）
  "provider": "deepseek", "model": "deepseek-chat", "base_url_host": "api.deepseek.com",
  "usage": { "prompt_tokens": 8123, "completion_tokens": 411, "total_tokens": 8534,
             "cache_read": 4096, "reasoning_tokens": 0 },
  "billed_unknown": false,            // true = provider 未回 usage，成本不可知（不是 0）
  "price": { "version": "2026-09-11", "currency": "CNY", "in": 1.0, "out": 2.0, "cache_read": 0.1, "unit": "per_mtok" },
  "cost": { "in": 0.004027, "out": 0.000822, "cache": 0.000410, "total": 0.005259 },
  // in = UNCACHED input only, (8123 - 4096) x 1.0; the prompt counter already
  // contains the cache-hit region, which is billed ONCE at the cache price.
  "priced_by": "table",               // table | record | unpriced
  "fallback_from": null,              // 能力 4：本 attempt 因何而来（target 名）
  "request_id": "…"                   // P1：上游 request-id（若 header 有），用于对账
}
```

外加 **turn 级汇总行**（`kind:"turn_total"`，含 `attempts:N`、`steps:N`），只为对账便利，**明细仍在**。

#### 3.2.2 定价表

`<data dir>/pricing.json`：

```jsonc
{ "version": "2026-09-11", "effective_from": 1759968000, "currency": "CNY",
  "unit": "per_mtok",
  "models": { "deepseek-chat": { "in": 1.0, "out": 2.0, "cache_read": 0.1 },
              "deepseek-reasoner": { "in": 2.0, "out": 8.0, "cache_read": 0.2 } },
  "source": { "kind": "newapi-snapshot", "ref": "/src/CelesteaTeamAPI/newapi-ops/PRICING-ARCHITECTURE.md", "synced_at": 1760000000 } }
```

**纪律（防止成为第二真相）**：
1. 价格**不手写在引擎代码里**，由 `scripts/sync-pricing.ts`（P1）从 newapi 侧**只读**同步成快照，并记 `version`/`synced_at`/来源引用；
2. 引擎只做 `tokens × 单价`，**不**复刻平台侧的分组倍率/计费表达式（`/server-center/docs/docs/lts/biz/newapi.md:20-24` 的 I1–I3：价格单一事实源在 newapi 侧、`ratio = 官方CNY × factor`、展示≠计费）——否则我们就是第二个计费实现；

   **cache 口径（V2.6.0 修正）**：provider 的 `prompt_tokens` **已包含** cache 命中区（宿主 `turn-usage` 的 `total − output === input + cacheRead + cacheWrite`；`packages/llm/src/usage.ts` 把 `prompt_tokens` 当总数、cache 计数另取）。因此命中区**只按 `cache_read` 单价收一次**：`cost.in = max(0, prompt_tokens − cache_read) × in` 是**未命中输入**的成本，`cost.cache = cache_read × cache_read` 是命中区成本；旧口径「prompt 全额 × `in` + cache 另计」会把命中区收两次，已废弃；
3. 表里没有的模型 → `priced_by:"unpriced"`、`cost.total = null`、聚合视图返回 `unpriced_models[]`（**禁止静默 0**）。

#### 3.2.3 记账规则表（失败与重试，逐条可检）

| 情况 | 行数 | `kind` | `usage` | `cost` | `billed_unknown` |
|---|---|---|---|---|---|
| 正常一轮 N 个 step | N | `ok` | 各自 | 各自 | false |
| 连接/响应头超时、非 2xx（无 usage 帧） | 1/attempt | `error` | `null` | `null` | **true** |
| 流中途撕裂（可能已收到部分 usage） | 1/attempt | `error` | 已观测者 | 已观测者 | 有 usage=false，无则 true |
| fallback 换模型后成功 | M（每 attempt 一行）+ 1 汇总 | `error`×k + `ok` | 各自 | 各自 | 按实际 |
| 用户重发同一输入 | 新 turn、新 `step` 序列、`attempt` 独立计（≠重试） | `ok` | 各自 | 各自 | false |
| 取消（`cancelled`）| 已产生 usage 的 step 各一行 | `ok` | 各自 | 各自 | false |
| 实例重建（epoch/授权变更）| **不写新行**，账本连续（与内存 tracker 的 `reset()` 解耦） | — | — | — | — |

**写入时机**：**每收到一个 `usage` 帧即写一行**（step 粒度）。取舍：turn 边界批量写更省 IO，但崩溃会丢掉整轮已产生的成本；成本数据的价值正是"不可重建"，故选 step 粒度 + append-only 单次 `writeSync`。
**幂等**：行内容含 `(session, turn_id, step, attempt)`；写前查尾部 N 行同键 → 已存在则跳过（防重放/双重 record）。

#### 3.2.4 聚合视图

`GET /api/usage/ledger?session=&since=&until=&group_by=session|turn|model|day`（P1，**新增 1 个端点** → `API_ENDPOINT_COUNT` 43→44）：返回
`{ok, currency, group_by, rows:[{key, tokens:{…}, cost:{…}, records, unpriced_records}], totals:{…}, unpriced_models:[], price_version}`。
`/api/status` 增 `cost` 块（`{session_total, turn_total, attempts, currency, priced_by}`，纯增字段）。

### 3.3 分期

| 阶段 | 内容 |
|---|---|
| **P0** | ① `packages/runtime/src/ledger.ts`：`LedgerUsage`（实现 `UsageAccounting`，**装饰**既有 tracker，符合 `runtime/usage.ts:13-18` 已声明的"结构型 seam"惯例，无需改 core）；② step 级 append + turn 汇总行；③ `pricing.json` 读入 + `unpriced` 标记；④ `(session,turn_id,step,attempt)` 幂等；⑤ 单测（C1–C7 里的单进程部分） |
| **P1** | ① `GET /api/usage/ledger` 聚合端点 + `API_ENDPOINT_COUNT` 同步；② `/api/status` 的 `cost` 块；③ `scripts/sync-pricing.ts`（只读同步 + version）；④ 轮转（超 16MB 轮转，沿用审计纪律）；⑤ SSE `status` 帧附 `cost_delta`（可选，纯增字段） |
| **P2** | ① 三方对账器（studio 账本 vs newapi 平台账 vs DSH `tokenUsage` 投影）：只读比对，输出差异报告（`scripts/reconcile-usage.ts`）；② 预算与止损（每会话/每日上限 → 达限拒绝新 turn 或触发能力 4 的确定性降级）；③ 按 `request_id` 的逐请求核对 |

### 3.4 验收标准（机械可检验）

| # | 场景 | 断言 | 落点 |
|---|---|---|---|
| C1 | 注入固定 clock + 假 pricing，跑一轮 3 step 且每 step 有 usage 帧 | 账本行数 = 3 + 1(turn_total)；`(turn, step)` 严格递增 | `packages/runtime/src/ledger.test.ts` |
| C2 | 对账不变量 | `Σ steps.usage.prompt_tokens === turn_total.usage.prompt_tokens`（token 维度必须逐字相等） | 同上 |
| C3 | 未定价模型 `"nope"` | 行 `priced_by==="unpriced"` 且 `cost.total===null`（`!== 0`）；聚合 `unpriced_models` 含 `"nope"` | 同上 + `app-domains.test.ts` |
| C4 | mock 非 2xx | 1 行 `kind:"error"`,`cost:null`,`billed_unknown:true`；该会话 `cost.total` **不含**它（不是 0 元而是"未知"） | `packages/llm` 假上游 + ledger 测试 |
| C5 | 重启不丢 | 写 3 行 → 新 tracker/ledger 实例 → `GET /api/usage/ledger?session=X` 的 `totals` 与重启前逐字段相等 | `apps/studio/src/app-domains.test.ts` |
| C6 | 幂等 | 同一 `(turn_id, step, attempt)` 重复 record → 文件行数不变 | `ledger.test.ts` |
| C7 | 价格版本不可追溯 | pricing `version` 变化后，新行带新 version，**旧行字节不变** | `ledger.test.ts` |
| C8 | 不写正文 | 账本行**不含** prompt/消息文本（断言序列化行不含输入串） | `ledger.test.ts` + `tests/redact.test.ts` 延伸 |
| C9 | 契约 | `API_ENDPOINT_COUNT === 44`；`app.ts:109` 的 `assertCoverage` 通过 | `apps/studio/src/app.test.ts` |

### 3.5 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R3-1 | 定价来源未验证（本次 `/src/CelesteaTeamAPI/newapi-ops/PRICING-ARCHITECTURE.md` **读取被拒**：`Permission denied`；仅从 LTS `biz/newapi.md:15` 得到指针） | P0 **不依赖**该文件：`pricing.json` 可手工/运维提供，缺表即 `unpriced`；P1 的同步脚本落地前先确权 |
| R3-2 | 与平台计费口径不一致（倍率/分组/缓存语义） | 只记 `provider 原始 usage × 快照单价`，**声明为引擎侧估算**；差异由 P2 对账器暴露，不掩盖 |
| R3-3 | step 粒度写放大 | append-only 单次 `writeSync`（无 fsync，除非运维开启）；轮转 + 可选 `CELESTEA_USAGE_LEDGER=off` 关闭 |
| R3-4 | 账本含会话名/模型名（敏感面） | 字段白名单（无正文、无 key）；落盘前过 `core/redact.ts`；`0600` |
| R3-5 | 与会话删除不一致（会话没了账还在） | 有意保留（成本是审计事实）；对账视图标 `session_deleted:true` |

### 3.6 与现有模块的接缝

| 模块 | 改动 | 类型 |
|---|---|---|
| `packages/llm` | `LlmError` 增 `httpStatus`（能力 4 P0，账本消费它）；`usage.ts` 不变 | 包内变更 |
| `packages/runtime` | 新增 `ledger.ts`（`LedgerUsage implements UsageAccounting`）；`session-compose` 用它替换裸 `createUsageTracker()`；`statusline`/`status.ts` 增 cost 视图 | 新增实现 + 装配 |
| `packages/core` | **不改**（`Usage` 结构够用；价格不属于引擎语义） | — |
| `apps/studio` | 新端点 + `/api/status.cost` + `routes.ts` 计数 + boot 时构造 ledger 单例（**进程级共享一个文件**，与会话实例解耦） | 契约变更 |
| `contracts/` | `endpoints.json`（+1 端点、`get_status` 响应字段）、`data-files/pricing.schema.json`、`data-files/usage-ledger.schema.json`、`data-files/index.json` | 契约变更 |

### 3.7 实现状态（W728 P0 回填）

| 设计条目 | 状态 | 落点 / 说明 |
|---|---|---|
| ① step 级 append-only 账本 | **已实现（有偏离）** | `packages/runtime/src/ledger.ts`（`UsageLedgerFile` / `UsageLedger`）、`ledger-llm.ts` |
| ② turn 汇总行 | 已实现 | `kind:"turn_total"`，含 `steps`/`attempts`/`outcome`/`cost_complete`/`unpriced_models` |
| ③ `pricing.json` + `unpriced` | 已实现 | `packages/runtime/src/pricing.ts`；缺表/坏表 = 空表（全 `unpriced`），有 unparsable 文件时 stderr 告警 |
| ④ `(session,turn_id,step,attempt)` 幂等 | 已实现 | 键即 `ledgerKey()`；句柄二次 `close()` 与同键 `append()` 均不落第二行 |
| ⑤ 单测（C1–C7 单进程部分） | 已实现 | `ledger.test.ts`（C1/C2/C3/C6/C7/C8 + 并发/append-only/重启续账）、`pricing.test.ts`、`apps/studio/src/runtime/usage-ledger.test.ts`（C4 + 真实 app 装配） |
| 契约 | 已实现 | `contracts/data-files/{usage-ledger,pricing}.schema.json` + `index.json` 8→10；`API_ENDPOINT_COUNT` **保持 44**（P0 不加端点，C9 不变） |
| P1/P2（端点、`/api/status.cost`、sync-pricing、轮转、对账） | **未实现（有意）** | `GET /api/usage/ledger` 仍 404（有用例断言），`/api/status` 无 `cost` 块 |

**偏离与理由（逐条，便于评审）**：

1. **① 的"装饰既有 tracker"改为"在 `Llm` 接缝观测 step"**。`AgentLoopBindings.usage` 的静态类型是 `agent-loop` 的
   `UsageTracker`（含 private 字段 → nominal），结构型装饰对象无法赋给它；若要按设计装饰，必须改 `packages/agent-loop`
   的导出类型。更关键的是：本设计自己的记账规则表要求"流中途撕裂 = **1 行 `error`**（含已观测 usage）"，
   以及 W723 的 `httpStatus`/`retryable` —— 这两件事**只有 `Llm` 接缝看得见**（turn 级看不到状态码，usage 帧看不到流终止）。
   因此账本由 `createLedgerLlm()` 驱动：`beginStep` → 每个 usage 帧 `record` → 流终态 `close`。
   `UsageLedger` 仍实现 runtime 的结构型 `UsageAccounting`（`record`/`latest`/`total`），且 `latest`/`total` 由**文件**派生
   （重启不丢），`record()` 落在当前打开的 step 缓冲里。
2. **写入时机**：设计写"每收到一个 usage 帧即写一行"，实现为"**每个 step 收尾写一行**"。行数与设计一致
   （N 个有 usage 的 step = N 行 + 1 行 turn_total，C1 逐字成立），差别只在撕裂流那条规则要成立就必须能判定 step 收尾。
3. **turn 归属**：`turn`/`turn_id` 取"宿主会话日志里**未闭合**的 `turn_start`"（K4：日志是唯一真源），
   不新造计数器；turn 边界由 `TurnRunner` 经 `TurnLedgerHooks`（`beginTurn`/`endTurn`）告知，纯观测、写失败只告警。
4. **`attempt` 维度**：字段与语义已落地（`attempt=0` = 首次；错误行携带 `http_status`/`retryable`），
   P0 的所有行都是 `attempt=0`（重试/回退属能力 4 P1）。
5. **已知近似（诚实登记）**：worker 驱动的模型调用与主 turn 共用同一个 `Llm` 接缝，因此 worker 的花费记在**宿主会话**名下；
   compact 的 summarizer 走独立 `Llm`（`summarizer()`），P0 **不记账**。两者的归属细化留 P1。
6. **`mode` 字段未落**：设计 §3.2.1 的记录形状里没有 `mode`，且引擎代码目前没有会话 mode（双模式仍是设计文档），P0 无可记之物。

---

### 3.8 实现状态（W785 回填，P1）

| 设计条目 | 状态 | 落点 / 说明 |
|---|---|---|
| ① `GET /api/usage/ledger` 聚合端点 | **已实现** | `apps/studio/src/handlers/usage.ts` + `packages/runtime/src/ledger-query.ts`（`queryLedger`）；`session`/`since`/`until`/`group_by=session\|turn\|model\|day`；非法 query → 422。端点数 49 → **50**（`contracts/endpoints.json` + `API_ENDPOINT_COUNT` + `contracts/` 路由表快照的 `tsOnlyRoutes`/`tsApiEndpoints`/`tsMethodPathCombos` + `packages/core/src/contracts/index.ts` 的加载期断言） |
| ② `/api/status.cost` | **已实现** | `ledgerCostBlock()`（runtime）+ 适配器可选方法 `costBlock?()`；**纯增**可选字段，账本关闭/无适配器时不出现该键 |
| ③ `scripts/sync-pricing.ts`（只读同步 + version） | **未实现（有意）** | 依 R3-1/U1：newapi 侧 `PRICING-ARCHITECTURE.md` 读取被拒，同步脚本落地前须先确权；`pricing.json` 仍由运维提供，缺表即全 `unpriced`（不低报为 0） |
| ④ 轮转（> 16 MiB） | **已实现** | `UsageLedgerFile`：超 `USAGE_LEDGER_MAX_BYTES` 时 `close` → `rename` 为 `usage-ledger.jsonl.1` → 下次 append 重建；轮转失败只 stderr 告警、不抛（观测纪律） |
| ⑤ SSE `status.cost_delta` | **未实现（设计标注"可选"）** | 若要落地，按 K5 只增 optional payload 字段 |

**修正（P1 必需，P0 无感）**：`turn_total.attempts` 的口径由 `Σ(attempt+1)` 改为**计数**。P0 所有行 `attempt=0`，两式等价；P1 有了真实 attempt 维度后，`Σ(attempt+1)` 会把三次尝试报成 6（§3.4 D6 要求 3）。

**偏离**：`GET /api/usage/ledger` 的 `group_by=turn` 以 `"<session>|<turn_id>"` 为键（`turn_total` 行不参与聚合，避免与明细双计）。

---

