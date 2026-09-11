# 迭代方向 E · 能力深水区（断点恢复 / 可恢复多 agent / 成本账本 / 模型降级）

> 状态：**设计（未实现）**。本文只描述目标契约、分期与验收标准，**不改任何代码、配置或服务**。
> 范围：`packages/session`、`packages/runtime`、`packages/workers`、`packages/llm`、`apps/studio/src/runtime`、
> `apps/studio/src/store`、`contracts/`；与仓库外 `celes-worker-spawn` 插件（`/src/dsh_plugins/celes-worker-spawn`）的协同边界。
> 前置：`docs/ARCHITECTURE.md`（分层与 seam 纪律）、`docs/feature-session-independence.md`（W513，已实现）、
> `docs/feature-session-grants.md`（W516，已实现）。
> 一句话目标：**进程重启不再是语义断点**——会话能从中断处继续、worker 能被重新认领、花掉的每一分钱有账可查、上游劣化时回退是显式且可计费的。
>
> **术语**：`<data dir>` = `dirname(workspacesFile)`（`apps/studio/src/config.ts:57`，默认 `<cwd>/workspaces.json` 所在目录），
> 口径与 `docs/feature-session-grants.md` §4.3 第 3 条一致；`<session dir>` = `<workspace>/<session>/`。
>
> **本文的实现状态栏**：文中所有「现状」均标注 `文件:行号`，为本次实读结论；所有「目标/建议数值」均为设计取值，
> **不是实测数据**；未验证项集中在 §6。

---

## 0. 结论速览

| # | 能力 | 现状一句话 | P0（一句话） | P1 | P2 |
|---|---|---|---|---|---|
| 1 | 断点恢复 | 事件日志与 turn 计数器**已持久**（重放+截断 torn tail），但运行态全在内存，崩溃留下的悬空 `turn_start` 无人闭合 | 落 `checkpoint.json` sidecar + boot 时幂等合成 `turn_end: interrupted` + `turnNo` 从日志恢复 | inbox/回执排队持久化 + 恢复观测面（`/api/status.recovery`） | 真·续跑（step 级重放 + 工具副作用分类） |
| 2 | 可恢复多 agent | `WorkerRegistry` 有 TSV 原子写能力，但 studio 侧 `tsvPath: null`（纯内存）；回执幂等键是内存序号 | worker 表落盘（含 `host=/attempt=/lease=` token）+ boot **只观测**的恢复器 | 回执 attempt 化 + 跨进程幂等键 + 报告文件名 attempt 化 | 自动收养/重派（默认关）+ 与 celes-worker-spawn 的单一事实源裁决 |
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
| worker 表 | 有 TSV 解析/序列化/原子写 + `proc=` 归属；**studio 侧显式 `tsvPath: null`（纯内存）** | `packages/workers/src/registry.ts:89-100,118-121,289-300`；`apps/studio/src/runtime/session-compose.ts:173-184` |
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

## 1. 断点恢复（checkpoint / resume）

### 1.1 现状与缺口

**已经成立的（不要重做）**：

- 日志 append-only 且崩溃后重放 = 最长有效前缀，torn tail 被截断（`log/file.ts:1-16`）；
- turn id 单调不复用，重启后从磁盘最大值继续（`turn-id.ts:41-47`）；
- 悬空 `tool_call` 在投影层被合成为 cancelled 结果，历史对上游仍然合法（`derive.ts:105-119`）；
- 每会话一个实例、一个日志 fd、一个 busy 槽（W513），因此"恢复"天然是**按会话**的（`session-registry.ts:143-190`）。

**缺口（每条都可落成断言）**：

| ID | 缺口 | 可观察的后果 |
|---|---|---|
| G1-1 | 悬空 `turn_start` 不会被闭合 | 崩溃后该会话的历史里最后一轮永远没有终态；`analyzeReplay().danglingTurns > 0` 恒真 |
| G1-2 | 无「进程启动/停机」痕迹 | 无法区分「崩溃」与「正常退出」；恢复动作没有触发条件 |
| G1-3 | `turnNo` 重启归零 | `POST /api/turn` 返回的 `turn` 与日志里的 `turn-<n>` 不同源，前端跳帧过滤（按 turn 过滤）在重启后失配 |
| G1-4 | 两 lane 的排队消息不落盘 | 崩溃时"已接收未注入"的用户消息**静默消失**（无任何告警） |
| G1-5 | `lastOutcome` 不落盘 | 重启后无法回答"上一轮是不是被打断的"，也无法据此提示用户 |
| G1-6 | `writeErrorCount>0`（日志降级）无持久痕迹 | 磁盘与内存分叉在重启后变成永久分叉，且无人知道 |
| G1-7 | `syncEachAppend=false` 默认 | 掉电可丢尾部若干记录（含 `tool_result`）——工具可能已执行而结果丢失 |

### 1.2 目标契约

#### 1.2.1 状态分类（哪些必须持久、落在哪）

| 状态 | 分类 | 落点 | 理由 |
|---|---|---|---|
| 事件流（含 `turn_start/turn_end/tool_call/tool_result`） | **唯一真源，已持久** | `<session dir>/cli-main.jsonl` | 不改，只追加 |
| turn 计数器 | 派生 | 由日志 `maxTurnNumber+1` 推出 | 已有（`turn-id.ts:45-47`） |
| 「有一个 turn 开着」这个事实 | **必须持久** | `<session dir>/checkpoint.json` → `open_turn` | 日志本身可推（dangling），但**需要区分**「本次是崩溃」还是「另一进程正在跑」 |
| 进程身份 / 停机标记 | **必须持久** | `<session dir>/checkpoint.json` → `boot_id`/`pid`/`closed_at`/`clean_shutdown` | 崩溃判定 |
| 排队消息（两 lane） | **必须持久（P1）** | `<session dir>/checkpoint.json` → `lanes.next_turn[]`/`next_step[]`（带稳定 id） | 用户输入不能静默丢 |
| 已投递幂等台账（inbox id） | **必须持久（P1）** | 同上 → `delivered_ids[]`（有界环形，保留 N 条） | 与能力 2 共用跨进程幂等键 |
| `lastOutcome` / `turnNo` | 可从日志派生 | 不单独持久 | 避免第二真相 |
| 引擎内存 tracker（usage/status） | 不持久（由能力 3 账本承担） | — | 见 §3 |
| worker 表 / 回执队列 | 见能力 2 | — | 见 §2 |

**判据（写进代码注释）**：**能从 `cli-main.jsonl` 推出来的，一律不落盘**（K4）；只有"日志推不出来"的事实才进 checkpoint。

#### 1.2.2 checkpoint 形状（`contracts/data-files/checkpoint.schema.json`）

```jsonc
{
  "version": 1,
  "session": "ws1/cli-main",        // 自述；与目录不符 → 整份忽略（与 session.json 同款容错纪律）
  "pid": 41233,
  "boot_id": "b-9f3c1a2e",          // 每次进程启动生成一次（进程内常量）
  "updated_at": 1760000000,
  "clean_shutdown": false,           // 优雅退出时置 true；true 时 boot 不做任何修复
  "open_turn": { "id": "turn-7", "started_at": 1759999800 },   // null = 没有开着的 turn
  "last_outcome": "interrupted",     // 冗余但便于运维直读（以日志为准）
  "degraded": { "log_write_errors": 0 },
  "lanes": { "next_turn": [], "next_step": [] },
  "repaired": [ { "at": 1760000001, "action": "synthesize_turn_end", "turn_id": "turn-7" } ]
}
```

**写盘时机（只有三处，避免 IO 放大）**：`turn_start` 之后、`turn_end` 之后、lane 变更之后。
**写盘方式**：`<path>.tmp-<pid>` → `rename`（复用 `apps/studio/src/store/fs-json.ts` 的原子写纪律），模式 `0600`。
**容错**：缺失 = 无 checkpoint（**不做任何修复**）；损坏/`version` 未知/`session` 不符 = **整份忽略 + 审计 + UI 告警**（与 `grants.json` 同纪律：`feature-session-grants.md` §4.3，区别于 `session.json` 的"忽略错误"）。

#### 1.2.3 恢复语义（boot 决策表，机械可检验）

| checkpoint | 日志末态 | 判定 | 动作 |
|---|---|---|---|
| 缺失 | 悬空 `turn_start` | **不可判定**（可能是另一进程在跑） | **不改日志**，只记审计 `recovery_skipped` |
| `clean_shutdown: true` | 任意 | 正常退出 | 不动 |
| `open_turn` 非 null **且** 日志中该 id 无 `turn_end` | 悬空 | **崩溃打断** | 追加 `{type:"turn_end", id, outcome:"interrupted"}` + checkpoint 置 `open_turn:null` + 记 `repaired[]` + 审计 |
| `open_turn` 非 null 且日志中该 id **已有** `turn_end` | 闭合 | 幂等重入（上次已修） | 只清 `open_turn` |
| `open_turn` null | 悬空（他进程/历史遗留） | 不属于本次 | 不动 |

**幂等边界（明确写出）**：
1. 修复动作**只追加一行**，且只在 `open_turn` 与日志共同签名时触发；
2. 同一 `(session, turn_id)` 的修复**至多一次**：判据是"日志中该 id 已存在 `turn_end`"（第二个 boot 看到的是已闭合的日志 → no-op）；
3. `outcome: "interrupted"` 是 `TurnOutcome` 的**合法既有成员**（`packages/core/src/types.ts:17-22`），因此**不需要改 `session-event.schema.json`** —— 这是本设计能在 P0 落地且不破坏契约的关键；
4. 「这行是引擎写的还是恢复器写的」不写进日志（避免契约变更），只写进 checkpoint 的 `repaired[]` 与审计。**诚实标注**：代价是单看 jsonl 无法区分，属可接受取舍。

**`turnNo` 恢复**：`SessionRuntimeRegistry.ensure()` 建立实例时，若 runtime 的 session log 非空，则 `entry.turnNo = maxTurnNumber(events)+1`（现在是 `0`：`session-registry.ts:161`）。这是"重启后 turn 号不回头"的唯一改动点，且与日志 id 同源。

### 1.3 分期

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | ① `checkpoint.ts`（读写 + 原子落盘 + 容错）；② 三个写盘时机接入（`turn-runner.drive` 与 `inbox` 变更）；③ boot 恢复器 `recoverSession()`（决策表）+ 幂等合成 `turn_end`；④ `turnNo` 从日志恢复；⑤ `clean_shutdown` 在 `Runtime.shutdown()`/`registry.shutdown()` 处置位；⑥ schema + 单测 | `packages/session/src/checkpoint.ts`、`packages/runtime/src/recovery.ts`、`contracts/data-files/checkpoint.schema.json` |
| **P1** | ① lane 消息与 `delivered_ids` 持久化；② `GET /api/status` 增 `recovery` 块（`{session, recovered_turns:[], dangling_turns, degraded, last_outcome}`，纯增字段）；③ 日志降级（`writeErrorCount>0`）落 checkpoint + 审计 | `apps/studio/src/handlers/*`（无新端点）、`contracts/endpoints.json` 的 `get_status.response` 增字段 |
| **P2** | 真·续跑：在被打断的 step 处继续。需要**工具副作用分类表**（`idempotent: true/false`，落 `contracts/tools.json` 的每个 tool）：幂等工具 → 重放；非幂等工具 → 合成 cancelled 结果并**不**重放。另加 stale 单写者检测（checkpoint 的 `pid` 存活探测）、compact 后 checkpoint 的 turn 映射失效处理 | `packages/tools/src/guard/side-effects.ts`（分类）+ `packages/session/src/resume.ts` |

### 1.4 验收标准（机械可检验）

| # | 场景 | 断言 | 落点 |
|---|---|---|---|
| A1 | 给定 jsonl 末行为 `turn_start turn-4`（无 `turn_end`）+ checkpoint `open_turn=turn-4` | 恢复后 `events()` 末元素 `=={type:"turn_end",id:"turn-4",outcome:"interrupted"}`；`analyzeReplay().danglingTurns === 0` | `packages/session/src/checkpoint.test.ts` |
| A2 | 连续恢复两次 | 第二次**文件字节数不变**（断言行数 delta = 0）；`repaired[]` 长度仍为 1 | 同上 |
| A3 | 无 checkpoint 且日志悬空 | 恢复前后文件 `sha256` **相等**（保护历史日志） | 同上 |
| A4 | 恢复后再开一轮 | `nextTurnId() === "turn-5"`；`auditTurnIds().duplicates===[] && nonMonotonic===[]` | `packages/session/src/turn-id.test.ts` 延伸 |
| A5 | 新 registry 实例接管已有日志 | `entry.turnNo === maxTurnNumber(events)+1`（≠0） | `packages/runtime/src/session-registry.test.ts` 延伸 |
| A6 | 末行是半截 JSON 且此前有悬空 `turn_start` | torn tail 被截断；恢复只追加 1 行；`parsedEvents === 完整前缀长度 + 1` | `packages/session/src/log/persistent.test.ts` 延伸 |
| A7 | 注入必然失败的日志写（mock） | `writeErrorCount()>0`；`checkpoint.degraded.log_write_errors>0`；`GET /api/status` 的 `recovery.degraded===true` | `apps/studio/src/app-domains.test.ts` 延伸 |
| A8 | 契约 | `contracts/data-files/index.json` 计数 +1 且 schema 校验用例通过；`GET /api/status` 新字段在 `contracts/endpoints.json` 里登记 | `tests/contracts.test.ts` |
| A9 | `clean_shutdown: true` | 悬空 turn 也**不**被闭合（断言文件不变） | `checkpoint.test.ts` |

### 1.5 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1-1 | 「日志不可改写」原则被"合成 turn_end"破例 | 只**追加**、不改写；触发条件是 `open_turn` 与日志双签名；checkpoint `repaired[]` + 审计双写留痕（审计纪律沿用 `feature-session-grants.md` §4.4） |
| R1-2 | 双后端/CLI 同时写同一 `cli-main.jsonl` | 既有已知限制（`feature-session-independence.md` §3.2），P2 的 stale 写者检测是缓解而非根治 |
| R1-3 | checkpoint 与日志不同步（写 checkpoint 失败） | 恢复器**以日志为判据**，checkpoint 只提供"是否崩溃过"；checkpoint 缺失 = 不修复（fail-safe） |
| R1-4 | P2 重放非幂等工具 | 默认**不重放**，必须显式分类为幂等才重放；分类表进 `contracts/tools.json`，缺失 = 视为非幂等 |
| R1-5 | `sync()` 成本 | P0 **不**改 `syncEachAppend` 默认值；仅记录 `degraded` 并暴露，把"要不要 fsync"留给运维（`CELESTEA_SESSION_SYNC_EACH_APPEND`） |

### 1.6 与现有模块的接缝

| 模块 | 改动 | 类型 |
|---|---|---|
| `packages/session` | 新增 `checkpoint.ts`、`resume.ts`(P2)；`log/persistent.ts` 暴露 `writeErrorCount()`（已有）+ `path`（已有） | 新增实现 |
| `packages/core` | 新增 seam `CheckpointStore` + `CHECKPOINT_SERVICE` token（§7.4 流程：接口 + 服务 newtype + 文档登记） | 新增 seam（P0 可先在 runtime 内定义，P2 再上提 core；上提时机见 §5.3 的 `ARCHITECTURE.md` 行） |
| `packages/runtime` | `session-registry.ensure()` 恢复 `turnNo`；新增 `recovery.ts`（boot 恢复器）；`turn-runner.drive()` 三个时机写 checkpoint；`runtime.shutdown()` 置 `clean_shutdown` | 行为变更（可测） |
| `apps/studio` | `SessionComposer.compose()` 传入 checkpoint 路径；boot 时对"上次活跃会话"跑一次恢复；`/api/status` 增 `recovery` | 装配 + 契约增字段 |
| `contracts/` | `data-files/checkpoint.schema.json`（新）、`data-files/index.json`（计数）、`endpoints.json`（`get_status` 响应字段） | 契约变更 |

---

## 2. 可恢复多 agent（recoverable multi-agent）

### 2.1 现状与缺口

**已经成立的**：

- `WorkerRegistry` 有完整的 TSV 解析/序列化/原子写（tmp+rename）与 `proc=<pid>` 归属判定（`registry.ts:89-100,289-300,349-352`）；
- 冻结语义清晰：`DONE/FAILED` 行不被 `setWorkerState` 改写（`registry.ts:123-130`）；
- 回执协议是**机械收口**（不依赖模型配合）：报告文件 + 一行回执（`receipt.ts:70-89`）；
- `release()` 后一切工具调用 fail-closed（`registry.ts:280-284`）；
- DSH 侧插件已承担"拉起 + 巡检 + 重派 + 硬删"（`celes-worker-spawn` README §4）。

**缺口**：

| ID | 缺口 | 后果 |
|---|---|---|
| G2-1 | studio 侧 `tsvPath: null`（`session-compose.ts:176`） | 重启后 worker 表**全空**：`GET /api/worker/status`、`GET /api/sessions` 的 worker 行消失；进行中的 worker 失去宿主登记 |
| G2-2 | 回执幂等键是**内存** mailbox 序号（`mailbox.ts:26-27` → `worker-wiring.ts:119` 的 `mailbox:<id>`） | 重启后序号归零：同一回执二次注入（重复）或 key 冲突（错配） |
| G2-3 | 回执文本不含 attempt（`receipt.ts:85-87` 只有 wid/status/路径/答复），报告文件名 `results/<wid>-<short>.md` **同名覆盖** | 重派后新旧 attempt 的回执**无法区分**：丢回执（被覆盖）与重复回执（两条同文本）两种故障都不设防 |
| G2-4 | 重启后 driver 不恢复（`driveIfPossible` 只在 spawn 时调用一次） | 落盘的 `RUNNING` 行成为"registered but not driven"的僵尸行 |
| G2-5 | 无 lease/heartbeat | 无法区分"worker 活着且空闲"与"宿主进程已死"；`state=` 是唯一活性证据，而它随表一起丢（G2-1） |
| G2-6 | registry 行没有宿主会话列（只有 `report_to`） | `report_to` 为空时 `closeLoop` 直接 return（`registry.ts:316-317`）：回执**无处可去**且不留痕 |

### 2.2 目标契约

#### 2.2.1 单一事实源与归属（分工裁决）

**决策（推荐，标为待裁决项 U4）**：**两套表并存，各自为权威，绝不双写**。

| 表 | 拥有者 | 职责 |
|---|---|---|
| `/server-center/runtime/worker-exec/registry.tsv` | `celes-worker-spawn`（DSH 侧） | DSH 拉起的外部 worker（外部 fleet） |
| `<data dir>/worker-registry.tsv`（studio-ts，默认路径可配） | studio-ts | studio 自己 spawn 的 worker（引擎内会话） |

理由：DSH 插件的巡检/重派/硬删已服务于"外部 worker 是独立 DSH 会话"这一事实，而 studio-ts 的 worker 是**引擎内会话**（`worker:<sid>`，`worker-bridge.ts:29-49`），生命周期完全不同。强行合并会得到一张两套语义纠缠的表。
**禁止双写**落成断言（B6）。

#### 2.2.2 行内新 token（不改 TSV 列数，向后兼容）

`extra` 是空格分隔的 token 列表（`registry.ts:364-368`），追加 token 对旧解析器无影响（`registry-tsv.ts` 只解析已知列 + 原样保留 `extra`）：

| token | 语义 | 用于 |
|---|---|---|
| `host=<sid>` | **派发它的宿主会话**（W513 的 `hostSessionId`） | 重启后把 worker 归还给正确的宿主会话（补 G2-6） |
| `attempt=<n>` | 第几次尝试（首次 = 1，重派 +1） | 回执幂等键、报告文件名（补 G2-3） |
| `lease=<pid>@<unix>` | 拥有者进程与续期时刻 | 崩溃判定与僵尸行识别（补 G2-5） |
| `receipt=<key>` | 已发回执的幂等键 `wid:attempt` | 防重复回执（补 G2-2） |

#### 2.2.3 回执幂等（关键契约）

- **幂等键**：`receipt:<wid>:<attempt>`（跨进程稳定，不含内存序号）；
- **投递路径**：`registry.closeLoop()` 先查 `receipt=` token，已存在则**不再投递**（幂等）；否则投递并把 key 写回行；
- **宿主注入**：`worker-wiring.drainHost()` 把 `mailbox:<seq>` 换成 `receipt:<wid>:<attempt>`，注入 `inbox` 时**复用已有去重语义**（`inbox.ts:16-18` 的 `duplicate` 字段）——**这是零新增机制的关键复用点**；
- **报告文件**：`results/<wid>-<short>-a<attempt>.md`（不再覆盖）；同时保留读取旧名 `results/<wid>-<short>.md` 的兼容路径（交付物判定需同时认两种，见 R2-4）。

#### 2.2.4 boot 恢复决策表（studio 侧，机械可检验）

| 行状态 | lease | 交付物 | attempts | 动作（P2 自动；P0 只观测并记审计） |
|---|---|---|---|---|
| `RUNNING` | 本机 pid 已死 | 存在 | 任意 | 收口 `DONE` + 补发**一次**幂等回执 |
| `RUNNING` | 本机 pid 已死 | 无 | `< maxRetries` | 重派：新 `attempt=+1`、新会话 id、`lease` 续期 |
| `RUNNING` | 本机 pid 已死 | 无 | `>= maxRetries` | 收口 `FAILED` + 回执（FAILED 文本） |
| `RUNNING` | 本机 pid 存活 | 任意 | 任意 | **不动**（另一进程正在驱动） |
| `DONE`/`FAILED` | 任意 | 任意 | 任意 | 冻结（保持既有语义） |
| `RUNNING` | `host=` 指向不存在的会话 | 任意 | 任意 | 标 `orphan`（审计 + `GET /api/worker/status.orphans[]`），不自动重派 |

`maxRetries` / `graceMs` 取值与 DSH 侧插件**对齐**（`maxRetries: 2`、`graceMs: 600000`，README §4），避免两套阈值互相打架。

### 2.3 分期

| 阶段 | 内容 |
|---|---|
| **P0** | ① `SessionComposer` 的 `tsvPath` 从 `null` 改为可配路径（默认 `<data dir>/worker-registry.tsv`，env `CELESTEA_WORKER_REGISTRY`），**保留** `tsvPath: null` 作为测试/嵌入式选项；② `host=`/`attempt=`/`lease=` token 落行；③ boot 恢复器**只观测**：读表 → 判定 → 写审计 + `GET /api/worker/status` 增 `stale[]`/`orphans[]`（纯增字段），**不重派** |
| **P1** | ① 回执 attempt 化 + `receipt=` 幂等 token + 报告文件名 attempt 化；② `drainHost()` 幂等键换 `receipt:<wid>:<attempt>`；③ `worker_status` 增 `attempt`/`host_session`/`last_receipt`；④ 与 DSH 侧的**只读**协同（可选读插件表做展示，绝不写） |
| **P2** | ① 自动收养/重派（配置开关，**默认关**：`CELESTEA_WORKER_RECOVER=1` 才启用）；② lease 续期（driver 心跳，间隔 = `watch.intervalMs`）；③ 与 `autoDelete`/归档的交互（重派前确认归档可逆性，避免"归档会话被复活"） |

### 2.4 验收标准（机械可检验）

| # | 场景 | 断言 | 落点 |
|---|---|---|---|
| B1 | 进程 A spawn 后，进程 B（新 `WorkerRegistry` 实例）读同一 TSV | B 的 `ownEntries()` 为空（`proc` 不同）但 `entries()` 含该行；`recoverCandidates()` 返回 1 条 `orphan`（pid 不存在） | `packages/workers/src/registry.test.ts` 延伸 |
| B2 | 同一 wid 两次 attempt | `results/<wid>-<short>-a1.md` 与 `-a2.md` **同时存在**（`existsSync` 双断言） | `packages/workers/src/receipt.test.ts` 延伸 |
| B3 | 同一 `(wid,attempt)` 回执投递两次 | 宿主 `inbox.pending()` 只 +1；第二次 `injected.duplicate === true` | `packages/runtime/src/inbox.test.ts` 延伸 + `worker-wiring` 契约 |
| B4 | boot 恢复（RUNNING + pid 不存在 + 交付物存在） | 行状态 `DONE`；`mailbox.pending(host)` delta 恰为 1；审计恰 1 行 | `packages/workers/src/registry.test.ts` |
| B5 | `DONE` 行 + `setWorkerState("in-turn")` | 行状态仍 `DONE`（既有冻结语义不回退） | 现有用例延伸 |
| B6 | 默认配置下 studio 运行 | `<workerBase>/registry.tsv` 的 `mtime` **不变**；写入目标 == 配置路径 | `apps/studio/src/runtime/real-runtime.test.ts` |
| B7 | 契约 | `contracts/data-files/registry-tsv.schema.json` 的 round-trip 用例通过（新 token 不破坏序列化） | `tests/contracts.test.ts` |
| B8 | 幂等重放（P2） | 对同一 wid 跑两次 `recoverOnBoot()` → 第二次零动作（无新行、无新回执、审计 0 行） | `packages/workers/src/registry.test.ts` |

### 2.5 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R2-1 | 与 DSH 插件双写同一 TSV | 默认不同路径 + B6 断言 + 代码注释写明"禁止双写" |
| R2-2 | 重派导致同一 wid 双活（我们的 lease 与插件的 graceMs 判定不一致） | lease(pid)+交付物为唯一权威；冲突时记 `anomaly` 并**不**静默重派；阈值与插件对齐 |
| R2-3 | 自动重派与 `autoDelete`/归档交互 | P2 前置检查：目标会话已归档 → 不重派，记 `skipped_archived` |
| R2-4 | 交付物判定"文件存在"过弱（可被抢占/覆盖） | attempt 化命名后判定改为"存在**任一** attempt 文件"，且把文件名写进审计 |
| R2-5 | TSV 并发写在多进程下不是真原子 | 沿用既有 tmp+rename（同目录）；`proc=` + **P2 soft lock**（`worker-registry.tsv.lock`，O_EXCL，超时即放弃并告警） |

### 2.6 与现有模块的接缝

| 模块 | 改动 | 类型 |
|---|---|---|
| `packages/workers` | `registry.ts`（token 读写、`receipt=` 幂等、`recoverCandidates()`/`recoverOnBoot()`）；`receipt.ts`（attempt 化命名与幂等键）；`mailbox.ts`（不变但语义外移） | 行为变更 + 新增 |
| `packages/runtime` | `worker-wiring.drainHost()` 幂等键替换；`WorkerHost` 增 `recover()` 钩子 | 行为变更 |
| `apps/studio` | `session-compose.workerWiring()` 的 `tsvPath`；boot 调一次恢复器；`worker-bridge.aggregateWorkerStatus()` 增字段 | 装配 |
| `celes-worker-spawn`（仓外） | **不改**（P1 起可选只读读取其表做展示；禁止写） | 边界声明 |
| `contracts/` | `data-files/registry-tsv.schema.json`（token 白名单，若需要）；`endpoints.json` 的 `worker_status` 响应字段 | 契约变更 |

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
  "cost": { "in": 0.008123, "out": 0.000822, "cache": 0.000410, "total": 0.009355 },
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

**诚实取舍**：也可以把回退链放进 `Profile`，但 `Profile` 是**冻结的 12 键契约**（`profile.ts:1-6`），扩它要向 `contracts/` 与 Rust 侧同步；本条能力选择"侧车配置 + 装饰器"，使回退对引擎其余部分**零侵入**（`SessionComposer.llmFactory()` 一行替换）。

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
| `contracts/endpoints.json` | `+GET /api/usage/ledger`（43→44）；`get_status` 响应增 `recovery`/`cost`/`effective_model`/`fallback` | 1-P1 / 3-P1 / 4-P1 |
| `apps/studio/src/routes.ts:48` | `API_ENDPOINT_COUNT` 同步（漏改 → `app.ts:109` 启动抛错） | 同上 |
| `contracts/data-files/` | 新增 `checkpoint` / `pricing` / `usage-ledger` / `fallbacks` / `llm-cooldown` schema + `index.json` 计数 | 各 P0/P1 |
| `contracts/sse-events.json` | 只增 payload **optional** 字段（`status.phase:"fallback"`、`cost_delta`、`recovery`），事件名集合不变 | 1-P1 / 3-P1 / 4-P1 |
| `contracts/data-files/registry-tsv.schema.json` | 新 token（`host`/`attempt`/`lease`/`receipt`）白名单 + round-trip 用例 | 2-P0/P1 |
| `contracts/tools.json` | P2：每工具增 `idempotent`（副作用分类，缺失 = 非幂等） | 1-P2 |
| `docs/ARCHITECTURE.md` | 若 `CheckpointStore` 上提 core：§3.1 seam 表 + §7.4 流程 + §5 例外表（如超线） | 1-P0/P2 |
| 本文 | 落地后逐条回填「已实现 / 偏离」 | 全程 |

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
| U8 | 平台审计通道 `POST /api/audit` 的可达性与鉴权 | 未验证（`feature-session-grants.md` §8 已登记同一开放问题） | 审计的本地通道是权威，平台通道 best-effort（失败如实记） |
| U9 | `turnNo` 语义变更（从 0 起步 → 从日志恢复）对前端的影响 | **有依据**：前端按 `view.turn` 过滤本会话帧（`feature-session-independence.md` §2.6），恢复后 turn 只是"变大"，比较仍正确；但**未做前端实测** | 需一次前端联调确认（P0 验收的人工项） |

---

## 7. 附：本文未做的事（范围声明）

- **不改任何代码/配置/服务**，不 commit、不 push；
- 不新增 SSE 事件名（K5），不重写既有日志行（K4），不扩冻结的 `Profile` 12 键（§4.2.4）；
- 不做质量型模型降级（不可机械判定，§4.1 G4-7）；
- 不在本地复刻平台计费算法（R3-2）；
- 不动 DSH 侧 `celes-worker-spawn` 的表与巡检（§2.2.1）。
