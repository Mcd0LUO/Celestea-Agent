# 迭代方向 E · 能力深水区（断点恢复 / 可恢复多 agent / 成本账本 / 模型降级）

> 状态：**设计（未实现）**。本文只描述目标契约、分期与验收标准，**不改任何代码、配置或服务**。
> **落地进度（回填）**：能力 4 P0（W723：`LlmError.httpStatus/retryable`，`packages/llm/src/errors.ts`）、
> 能力 3 P0（W728：append-only `usage-ledger.jsonl` + `pricing.json` + `unpriced` 显式标记，§3.7）与
> 能力 1 P0（W730：`checkpoint.json` sidecar + boot 幂等合成 `turn_end: interrupted` + `turnNo` 从日志恢复，§1.7）
> **已实现**；能力 2 与各自 P1/P2 仍为设计。
> 范围：`packages/session`、`packages/runtime`、`packages/workers`、`packages/llm`、`apps/studio/src/runtime`、
> `apps/studio/src/store`、`contracts/`；与仓库外 `celes-worker-spawn` 插件（`/src/dsh_plugins/celes-worker-spawn`）的协同边界。
> 前置：`docs/ARCHITECTURE.md`（分层与 seam 纪律）、`docs/archive/decisions/feature-session-independence.md`（W513，已实现）、
> `docs/archive/decisions/feature-session-grants.md`（W516，已实现）。
> 一句话目标：**进程重启不再是语义断点**——会话能从中断处继续、worker 能被重新认领、花掉的每一分钱有账可查、上游劣化时回退是显式且可计费的。
>
> **术语**：`<data dir>` = `dirname(workspacesFile)`（`apps/studio/src/config.ts:57`，默认 `<cwd>/workspaces.json` 所在目录），
> 口径与 `docs/archive/decisions/feature-session-grants.md` §4.3 第 3 条一致；`<session dir>` = `<workspace>/<session>/`。
>
> **本文的实现状态栏**：文中所有「现状」均标注 `文件:行号`，为本次实读结论；所有「目标/建议数值」均为设计取值，
> **不是实测数据**；未验证项集中在 §6。

---

## 0. 结论速览

| # | 能力 | 现状一句话 | P0（一句话） | P1 | P2 |
|---|---|---|---|---|---|
| 1 | 断点恢复 | 事件日志与 turn 计数器**已持久**（重放+截断 torn tail），但运行态全在内存，崩溃留下的悬空 `turn_start` 无人闭合 | 落 `checkpoint.json` sidecar + boot 时幂等合成 `turn_end: interrupted` + `turnNo` 从日志恢复 | inbox/回执排队持久化 + 恢复观测面（`/api/status.recovery`） | 真·续跑（step 级重放 + 工具副作用分类） |
| 2 | 可恢复多 agent | `WorkerRegistry` 有 TSV 原子写能力，但 studio 侧 worker 表默认落盘 `<data dir>/worker-registry.tsv`（`workerRegistryPath()` 可配；`null` 才是纯内存）；回执幂等键是内存序号 | worker 表落盘（含 `host=/attempt=/lease=` token）+ boot **只观测**的恢复器 | 回执 attempt 化 + 跨进程幂等键 + 报告文件名 attempt 化 | 自动收养/重派（默认关）+ 与 celes-worker-spawn 的单一事实源裁决 |
| 3 | 成本与用量账本 | `Usage` 只有 5 个计数器，活在内存 tracker，无价格、无轮次/模型归属、无失败记账 | append-only `usage-ledger.jsonl`（step 粒度）+ `pricing.json` + `unpriced` 显式标记 | `GET /api/usage/ledger` 聚合 + `/api/status.cost` | 三方对账器 + 预算与止损 + 轮转 |
| 4 | 模型降级回退 | 单 client 单模型、零重试；失败原因只有文案没有结构化 `httpStatus` | `LlmError.httpStatus/retryable`（纯可观测，零行为变更） | `FallbackLlm` 装饰器 + 触发规则表 + 账本/审计/SSE 显式可见 | 冷却持久化 + 上下文超长特例 + 与预算联动 |

**跨能力的主线**：三条新概念贯穿全部四条能力——**尝试（attempt）**、**跨进程幂等键**、**显式可见（不静默）**。
建议实现顺序：**4-P0 → 3-P0 → 1-P0 → 2-P0 → 4-P1 → 3-P1 → 1-P1 → 2-P1**（理由见 §5.1）。

---

## 0.1 共同约束（四条能力都必须遵守）

| # | 约束 | 依据 | 对本文设计的直接影响 |
|---|---|---|---|
| K1 | 依赖只能向下，L1 之间不横向依赖 | `ARCHITECTURE.md` §1.1/§1.3 | 新 seam 定义只能落 `packages/core`；实现落各自 L1 包；跨包协作走 `Context` 或 runtime 装配 |
| K2 | 公开面收口在 `src/index.ts`，跨包引用走别名 | §2.2 | 新模块（`checkpoint.ts`/`ledger.ts`/`fallback.ts`）必须经各包 `index.ts` 导出；改导出 = 契约变更 |
| K3 | 单文件 ≤400 / 单函数 ≤80 / 嵌套 ≤4 / 形参 ≤5 | §4.1 | 恢复器、规则表必须**数据表外提**（§4.2 范式 2），否则一落地就超线 |
| K4 | 事件日志是唯一真源，模型可见历史是派生物 | §3.1 `SessionLog` 行 | 恢复**只能追加**日志，不得重写既有行；`deriveMessages` 的修复（合成 tool 结果）已经存在，不要重复造 |
| K5 | 事件名与信封冻结（8 个事件名，`assertEventName`） | `apps/studio/src/sse.ts:180-184` | 回退/账本/恢复的可见性**只能加 envelope/payload 字段**，不得新增事件名 |
| K6 | 契约是硬断言（端点数、data-file schema） | `apps/studio/src/routes.ts:48`（`API_ENDPOINT_COUNT = 43`）、`app.ts:81-109` | 每新增一个端点必须同步 `contracts/endpoints.json` + 常量，否则启动即抛错（这是**好事**：天然机械检验） |
| K7 | `core` 零依赖、零实现 | §3.1 | `CheckpointStore` 这类 seam 只放接口 + 服务 token；`Usage` 结构已有，不为其加价格字段（价格属于账本实现，不是引擎语义） |

---

## 0.2 现状总览（实读，带行号）

| 维度 | 现状 | 位置 |
|---|---|---|
| 日志持久化 | `PersistentSessionLog.open` = `mkdir` → `replayFile` 取**最长有效前缀** → 截断 torn tail → 补尾换行 → `nextTurnNumber()` 恢复计数器 → `openSync(path,"a")` | `packages/session/src/log/persistent.ts:58-73` |
| 写入耐久性 | `fs.writeSync`（无缓冲，达 OS）；`flush()` 是 no-op；`sync()` 才 fsync；`syncEachAppend` 默认 **false** | `persistent.ts:75-90,117-125`；`defaultPersistentOptions` `:36-38` |
| 写失败模型 | 磁盘写失败**不抛**：事件仍在内存视图 + stderr 告警 + `writeErrorCount()`（**静默降级**，无 durable 标记） | `persistent.ts:75-90,127-130` |
| turn 计数 | 日志拥有计数器，`maxTurnNumber(events)+1`，从不复用 id | `packages/session/src/turn-id.ts:25-47` |
| 崩溃残留 | 悬空 `turn_start` 只被**统计**（`analyzeReplay().danglingTurns`），无任何代码闭合或标注 | `packages/session/src/replay.ts:14-15,88` |
| 历史修复 | 悬空 `tool_call` 在**投影层**补合成 cancelled 结果（插入到派生消息，**不改日志**） | `packages/session/src/log/derive.ts:105-146` |
| turn 终态 | 只对**当轮**解析：日志有 `turn_end` 则用它；否则 throw / `cancelled` / `interrupted` | `packages/runtime/src/turn-runner.ts:239-263` |
| 会话实例状态 | `turnNo/profileEpoch/lastOutcome/inFlight/lastActiveAt` 全在内存；`rebuild()` 把 `turnNo` 归零 | `packages/runtime/src/session-registry.ts:41-51,273-281` |
| 配置世代 | `RealEngine.baseEpoch` 从 0 起（进程级），实例 epoch 落后即重建 | `apps/studio/src/runtime/real-runtime-adapter.ts:126,384-387` |
| 注入排队 | 两 lane（`next-turn`/`next-step`）内存队列，同 id 去重；**不落盘** | `packages/runtime/src/inbox.ts:1-60` |
| worker 表 | 有 TSV 解析/序列化/原子写 + `proc=` 归属；**studio 侧默认落盘 `<data dir>/worker-registry.tsv`（`workerRegistryPath()`；`null` 才是纯内存）** | `packages/workers/src/registry.ts:89-100,118-121,289-300`；`apps/studio/src/runtime/session-compose.ts:173-184` |
| worker 驱动 | `brief turn` → 回执（每轮 loop 结束**执行一次**）→ mailbox 轮询；`driveIfPossible` 只在 spawn 时调用 | `packages/workers/src/driver.ts:69-102`；`registry.ts:223-242` |
| 回执协议 | 写 `results/<wid>-<short>.md`（同名覆盖）+ 投递一行 `WORKER_<wid>_DONE|FAILED`；**幂等键 = mailbox 内存序号** | `packages/workers/src/receipt.ts:70-89`；`mailbox.ts:26-27`；`packages/runtime/src/worker-wiring.ts:110-123` |
| 用量 | 5 计数器；每个 `usage` 帧 `record()` 累加；`total` 跨 turn 累计、`latest` = 最后一次响应 | `packages/llm/src/usage.ts:11-46`；`packages/agent-loop/src/loop.ts:229-230`；`packages/runtime/src/usage.ts:34-56` |
| 用量视图 | `Statusline.usage: UsageBlock & {total}`（按会话取） | `packages/core/src/types.ts:179-198`；`real-runtime-adapter.ts:362-374` |
| LLM 失败 | 单次尝试、零重试；非 2xx → `LlmError("stream request failed: <status>: …","generate")`，**状态码只在文案里** | `packages/llm/src/client.ts:132-146,169-176` |
| 超时 | 三档 connect 15s / response 60s / idle 90s；无总请求超时（有意） | `packages/llm/src/timeouts.ts:26-58` |
| provider 选择 | 宿主侧 `providers.json` + profile（`base_url`/`api_key_env`）；`LlmRegistry` last-wins 但 studio 只构造**一个** | `apps/studio/src/runtime/provider-target.ts`、`llm-assembly.ts:99-115`、`packages/core/src/llm.ts:21-39` |
| 外部协同方 | `celes-worker-spawn`（纯 JS，无 shell）：DSH 侧 registry.tsv + 30s 巡检 + 重派 + 硬删；`watch.enabled` 默认 **false** | `/src/dsh_plugins/celes-worker-spawn/README.md:169-205` |

**一句话现状**：**日志层面的恢复已经做完了（并且做得很好），缺的是「运行态 + 编排态 + 经济态 + 可用性态」这四层。**

---


## 分册导航

| 分册 | 章节 |
| --- | --- |
| 本文件 | §0 结论速览、§5 交叉影响与实施顺序、§6 未验证假设、§7 范围声明 |
| [`01-checkpoint.md`](./01-checkpoint.md) | §1 断点恢复（checkpoint / resume） |
| [`02-multi-agent.md`](./02-multi-agent.md) | §2 可恢复多 agent |
| [`03-cost-ledger.md`](./03-cost-ledger.md) | §3 成本与用量账本 |
| [`04-model-fallback.md`](./04-model-fallback.md) | §4 模型降级回退 |

> 章节编号沿用原文；每节末尾的「实现状态（回填）」随该节留在同一分册。拆分为满足 `docs` 单篇 ≤ 700 行的硬上限。

---

## 5. 交叉影响、实施顺序与契约清单

### 5.1 依赖关系与推荐顺序

```
能力4-P0 (httpStatus)  ──┬─→ 能力3-P0 (账本 attempt 维度) ──┬─→ 能力4-P1 (回退 + 账本可见)
                         │                                  └─→ 能力1-P0 (checkpoint 记 degraded/attempt)
能力1-P0 (checkpoint)  ──┴─→ 能力2-P0 (worker 表落盘 + boot 观测)
能力2-P1 (回执幂等键)  ←── 与能力1-P1 共用"跨进程幂等键"概念
能力1-P2 (真续跑) / 能力2-P2 (自动重派)  ←── 共同前置：工具副作用分类 + 预算止损(能力3-P2)
```

**推荐顺序**：`4-P0 → 3-P0 → 1-P0 → 2-P0 →（评估）4-P1 → 3-P1 → 1-P1 → 2-P1 → P2 段`。
理由：4-P0 是纯可观测且零行为变更（最低风险、解锁账本）；3-P0 提供 attempt 维度（后续三条都要用它说话）；1-P0/2-P0 是"落盘 + boot 观测"（只加不改）；两个 P2 段的自动恢复与自动重派**必须**等副作用分类与预算止损到位，否则会把"崩溃恢复"变成"副作用放大器"。

### 5.2 统一约定（三条贯穿能力）

| 约定 | 内容 |
|---|---|
| **attempt** | `attempt=0` 表示首次尝试；重试/回退/重派均 +1；账本与回执与 registry 行使用**同一编号语义** |
| **幂等键** | 统一形如 `<domain>:<id>[:<attempt>]`：`receipt:<wid>:<attempt>`、`mailbox:<…>`（保留）、`turn:<session>:<turn_id>:<step>:<attempt>`（账本行） |
| **显式可见** | 任何自动行为（修复/重派/回退/降级）都必须同时出现在：① 本地 append-only 日志；② 结构化字段（statusline 或 SSE payload）；③ 审计行（best-effort 平台）。三者缺一视为未实现 |

### 5.3 契约与文档同步清单（落地时逐条打勾）

| 文件 | 变更 | 阶段 |
|---|---|---|
| `contracts/endpoints.json` | `+GET /api/usage/ledger`（W785 已落：49→50）；`get_status` 响应增 `cost`/`effective_model`/`fallback`（W785 已落）+ `recovery`（**W787 已落**，纯增字段）；`get_worker_status` 响应增 `stale[]`/`orphans[]`（**W787 已落**，纯增字段） | 1-P1 / 2-P0 / 3-P1 / 4-P1 |
| `apps/studio/src/routes.ts:48` | `API_ENDPOINT_COUNT` 同步（漏改 → `app.ts:109` 启动抛错） | 同上 |
| `contracts/data-files/` | 新增 `checkpoint` / `pricing` / `usage-ledger` / `fallbacks`（W785 已落，index 11 → 12）/ `llm-cooldown`（P2 未落）schema + `index.json` 计数；**W787**：`checkpoint.schema.json` 增 `lanes`（消息形状）+ `delivered_ids`（必填），`index.json` 12 → **13**（`<data dir>/worker-registry.tsv` 作为 studio 自己的数据文件登记） | 各 P0/P1 |
| `contracts/sse-events.json` | 只增 payload **optional** 字段（`status.phase:"fallback"` + `effective_model`/`from`/`to`/`reason`/`attempt` —— W785 已落；`cost_delta`/`recovery` 未落），事件名集合不变（**W787 未动本文件**：能力 1-P1/2-P1 的可见性走 `/api/status` 与 `/api/worker/status` 的纯增字段，K5 的 9 个事件名与信封逐字不变） | 1-P1 / 3-P1 / 4-P1 |
| `contracts/data-files/registry-tsv.schema.json` | 新 token（`host`/`attempt`/`lease`/`receipt`）白名单 + round-trip 用例（**W787 已落**：`extraTokens` 段 + `path.studio`/`ownershipRule`/`format.writeRule`；round-trip 在 `packages/workers/src/registry.test.ts` 的 B7、契约侧在 `tests/contracts.test.ts`） | 2-P0/P1 |
| `contracts/tools.json` | P2：每工具增 `idempotent`（副作用分类，缺失 = 非幂等） | 1-P2 |
| `docs/ARCHITECTURE.md` | 若 `CheckpointStore` 上提 core：§3.1 seam 表 + §7.4 流程 + §5 例外表（如超线） | 1-P0/P2 |
| 本文 | 落地后逐条回填「已实现 / 偏离」（W787：§1.8 / §2.7 + 本节打勾） | 全程 |

---

## 6. 未验证假设与不确定项（诚实清单）

| ID | 项 | 状态 | 影响 |
|---|---|---|---|
| U1 | newapi 定价公式与字段结构 | **未验证**：`/src/CelesteaTeamAPI/newapi-ops/PRICING-ARCHITECTURE.md` 本次读取被拒（`Permission denied`），仅有 LTS `biz/newapi.md:15` 的指针与 I1–I3 不变量 | 能力 3 的 P0 **不依赖**它（`pricing.json` 可运维提供 + `unpriced` 兜底）；P1 同步脚本落地前需确权 |
| U2 | 性能数字（fsync 延迟、账本写放大、checkpoint 写频率、SSE 帧增量） | **未实测**：本文所有开销判断均为定性 | 若 step 级记账不可接受，退化为 turn 级批量写（代价：崩溃丢一轮成本） |
| U3 | 真实崩溃时序（kill -9 + 部分写 + OS 缓冲丢弃） | **未实测**：torn tail 行为只有单测覆盖（`log/file.ts`、`jsonl.ts`） | `syncEachAppend` 默认值是否要改，需实测后裁决（P1 议题） |
| U4 | 两套 registry（studio vs `celes-worker-spawn`）是否最终应合并 | **待裁决**：本文取"并存 + 禁止双写"；未读生产 `workerBase/registry.tsv` 现状（避免误判在线 fleet） | 若裁决为合并，能力 2 的 P0 路径与 B6 断言需重写 |
| U5 | 失败响应中 provider 是否回 usage 帧 | **未验证** | 决定 `billed_unknown` 的占比；账本已能如实表达"未知"而非 0 |
| U6 | `session-event.schema.json` 是否必须随 checkpoint 变更 | **已规避**：设计只追加合法 `turn_end`（`interrupted` 是既有成员），因此**不改**该 schema | 若评审要求"恢复写入必须可区分"，则需 schema 版本变更（成本上升） |
| U7 | 回退链所需凭据是否都在环境中（`BACKUP_API_KEY` 等 env 名） | **未核实** | P1 前需盘点；缺凭据时 `enabled:true` 必须显式报"target 不可用"而不是静默跳过 |
| U8 | 平台审计通道 `POST /api/audit` 的可达性与鉴权 | 未验证（`archive/decisions/feature-session-grants.md` §8 已登记同一开放问题） | 审计的本地通道是权威，平台通道 best-effort（失败如实记） |
| U9 | `turnNo` 语义变更（从 0 起步 → 从日志恢复）对前端的影响 | **有依据**：前端按 `view.turn` 过滤本会话帧（`archive/decisions/feature-session-independence.md` §2.6），恢复后 turn 只是"变大"，比较仍正确；但**未做前端实测** | 需一次前端联调确认（P0 验收的人工项） |

---

## 7. 附：本文未做的事（范围声明）

- **不改任何代码/配置/服务**，不 commit、不 push；
- 不新增 SSE 事件名（K5），不重写既有日志行（K4），不扩冻结的 `Profile` 12 键（§4.2.4）；
- 不做质量型模型降级（不可机械判定，§4.1 G4-7）；
- 不在本地复刻平台计费算法（R3-2）；
- 不动 DSH 侧 `celes-worker-spawn` 的表与巡检（§2.2.1）。
