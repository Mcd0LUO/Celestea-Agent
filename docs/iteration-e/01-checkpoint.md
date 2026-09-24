# 迭代方向 E · 断点恢复（§1）

> 状态：**设计（未实现）** ｜ 本册是 [`README.md`](./README.md) 的分册：checkpoint / resume 的目标契约、分期与验收。
> 章节编号沿用原文；总览与跨能力结论见索引。

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
**容错**：缺失 = 无 checkpoint（**不做任何修复**）；损坏/`version` 未知/`session` 不符 = **整份忽略 + 审计 + UI 告警**（与 `grants.json` 同纪律：`archive/decisions/feature-session-grants.md` §4.3，区别于 `session.json` 的"忽略错误"）。

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
3. `outcome: "interrupted"` 是 `TurnOutcome` 的**合法既有成员**（`packages/core/src/types.ts:19`），因此**不需要改 `session-event.schema.json`** —— 这是本设计能在 P0 落地且不破坏契约的关键；
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
| R1-1 | 「日志不可改写」原则被"合成 turn_end"破例 | 只**追加**、不改写；触发条件是 `open_turn` 与日志双签名；checkpoint `repaired[]` + 审计双写留痕（审计纪律沿用 `archive/decisions/feature-session-grants.md` §4.4） |
| R1-2 | 双后端/CLI 同时写同一 `cli-main.jsonl` | 既有已知限制（`archive/decisions/feature-session-independence.md` §3.2），P2 的 stale 写者检测是缓解而非根治 |
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

### 1.7 实现状态（W730 回填，P0）

**已实现（§1.3 P0 ①–⑥ 逐条）**：

| # | 设计项 | 落点 |
|---|---|---|
| ① | checkpoint 读写 + 原子落盘 + 容错 | `packages/session/src/checkpoint.ts`（`CheckpointStore`、`readCheckpointFile`、`writeCheckpointFile`：`tmp-<pid>` → `rename`，0600） |
| ② | 写盘时机接入 | `packages/session/src/checkpoint-log.ts`（`checkpointedLog`：**追加后**写 `turn_start`/`turn_end` 两处；`clear()` 清 `open_turn`）；lane 变更属 P1，未接 |
| ③ | boot 恢复器 + 幂等合成 | `packages/session/src/checkpoint-recovery.ts`（决策表，纯函数）+ `packages/runtime/src/recovery.ts`（按目录编排：不存在日志则**不创建**；torn tail 先截断）+ `apps/studio/src/runtime/boot-recovery.ts`（对 `workspaces.json.active_session` 跑一次） |
| ④ | `turnNo` 从日志恢复 | `packages/runtime/src/session-registry.ts` 的 `turnNumberFromLog()`（`ensure` 与 `rebuild` 同源） |
| ⑤ | `clean_shutdown` 置位 | `Runtime.doShutdown()` 调 `markCleanShutdown(log)`（优雅退出 = 唯一置 true 的路径；任何写盘动作都把它重置为 false） |
| ⑥ | schema + 单测 | `contracts/data-files/checkpoint.schema.json` + `index.json`（10 → 11）；A1–A3/A6/A9（`packages/session/src/checkpoint.test.ts`）、A4（`turn-id.test.ts`）、A5（`session-registry.test.ts`）、A7 sidecar 半边（`checkpoint-log.test.ts`）、目录编排（`packages/runtime/src/recovery.test.ts`）、宿主端到端（`apps/studio/src/runtime/checkpoint-recovery.test.ts`） |

**与设计的偏离（逐条，均为 P0 范围内的显式取舍）**：

1. **接入点从 `turn-runner.drive` 改为 SessionLog 装饰器**：`turn_start`/`turn_end` 两行由 **agent-loop** 追加（它从 Context 解出日志），
   `TurnRunner` 在调用 loop **之前**拿不到 turn id，事后写又错过崩溃窗口。装饰器是唯一能精确对齐「写盘时机 = 行落地」的接缝，且对
   `SessionLog` 契约零改动（Proxy 透传 `path`/`close`/`writeErrorCount`）。
2. **审计只落了「持久 + stderr」两条通道**：§1.2.3 的「审计」在 P0 落为 checkpoint 的 `repaired[]`（durable、可机械断言）+
   `[celestea-recovery]` stderr 行；平台侧 `POST /api/audit` 的 best-effort 双写**未接**——现有 `GrantsAuditWriter` 的事件名是
   grants 专属枚举，为恢复新增通道会引入第二份审计文件，属 §5.2③ 的 P1 议题（登记为偏离，不静默）。
3. **恢复范围 = 「上次活跃会话」**（§1.6 原文）：boot 只处理 `workspaces.json.active_session`；其余会话在各自实例首次 compose 时按同一
   决策表语义被「读到」——但**不会**被自动闭合（没有第二个进程知道它是否属于本次崩溃），保持 fail-safe。
4. **缺 checkpoint + 悬空 turn 不闭合**（§1.2.3 行 1）会留下 `danglingTurns > 0`：这是设计选择而非缺陷（无法与「另一进程正在跑」区分），
   stderr 会明确报告「left untouched — no checkpoint」。
5. **`CheckpointStore` seam 未上提 `packages/core`**（§1.2.3 允许 P0 留在实现层）：P0 落在 `@celestea/session` 并由包 `index.ts` 导出，
   `core` 零改动（K7/K1）。上提时机仍按 §5.3。
6. **A7 只覆盖 sidecar 半边**：`checkpoint.degraded.log_write_errors>0` 有断言（`checkpoint-log.test.ts` 用带 `writeErrorCount()` 的假日志），
   `/api/status.recovery.degraded` 属 P1（P0 不加端点、不改响应字段）。**A8** 同样只落了 data-files 半边（schema + index 计数），
   `endpoints.json` 的 `get_status` 增字段属 P1。
7. **`pid` 仅记录、不判定**：stale 单写者探测（`pid` 存活）是 §1.3 P2 项，P0 不据它做任何决策（`open_turn` + 日志双签名是唯一判据）。

**未改变的正常路径**：无崩溃时只多一个 sidecar 文件；`cli-main.jsonl` 的字节、事件名、SSE 信封、端点集合（44）与 `pnpm check` 基线逐条不变。

### 1.8 实现状态（W787 回填，P1）

| 设计条目 | 状态 | 落点 / 说明 |
|---|---|---|
| ① lane 消息与 `delivered_ids` 持久化 | **已实现** | `packages/runtime/src/inbox.ts`（`InboxSink`/`snapshot()`/`bindPersistence()`）+ `inbox-checkpoint.ts`（sidecar sink）+ `packages/runtime/src/compose.ts`（**绑定日志后**注入 sink，所以宿主自带的 inbox 也被接上）+ `packages/session/src/checkpoint.ts`（`lanesChanged()`/`persistedQueues()`）。写盘时机 = push / drain（§1.2.2 的第三处），恢复**静默**（不重发 placement 帧） |
| ② `GET /api/status.recovery` | **已实现** | `apps/studio/src/runtime/recovery-view.ts` + `handlers/health.ts`；`{session,recovered_turns,dangling_turns,degraded,last_outcome}`，**纯增字段、无新端点**（`API_ENDPOINT_COUNT` 仍 50） |
| ③ 日志降级落 checkpoint + 审计 | **已实现** | `checkpoint.ts` 的 `onDegraded`（**每 store 至多一次**，不刷屏）+ `checkpoint-log.ts` 在每次 append 后采样 `writeErrorCount()` + `apps/studio/src/runtime/recovery-audit.ts`（`<data dir>/recovery-audit.jsonl`，0600/16 MiB 轮转/平台通道 best-effort） |

**补齐的 P0 偏离**：§1.7 偏离 2 登记的「审计只有两条通道」在 P1 关闭 —— 崩溃修复（`session_repaired`）、日志降级（`log_degraded`）与 worker 观测现在都进 `recovery-audit.jsonl`（§5.2③ 的三处可见性齐了）。

**口径（写进代码注释，避免第二真相）**：`dangling_turns` 由**日志**推出（`turn_start - turn_end`，与 `analyzeReplay().danglingTurns` 同规则）；`recovered_turns` 来自 sidecar 的 `repaired[]`（日志无法区分「引擎写的」与「恢复器写的」，§1.2.3 幂等边界 4）；`last_outcome` 取日志最后一条 `turn_end` 的 phase；`degraded` = 日志实时 `writeErrorCount()>0` **或** sidecar 的 sticky `degraded.log_write_errors>0`（旧分叉在健康重启后仍可见）。

**偏离/边界**：`recovery` 只回答**当前有实例**的会话（`peek`，绝不为了轮询去 compose）；无实例的会话返回**空块**（零值）而非报错 —— 客户端因此可以依赖该键恒存在。

---

