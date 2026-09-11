# `@celestea/workers` (L1 · worker 编排)

一句职责：**维护本进程所有 worker 的状态与通讯**——`registry.tsv` 表（解析/序列化/内存态/行归属）、
会话寻址、mailbox 事件循环（挂起→唤醒→投递）、三个编排工具（`spawn_worker` /
`session_send_message` / `worker_status`）、brief 轮结束后的**回执协议**（报告文件 + 一行回执），
以及 **worker 生命周期状态机**（W736：`RUNNING → DONE | FAILED` 真实落盘 + 独立看门狗插件）。
对应 Rust `crates/workers/src/{types,registry,tools,plugin,watchdog}.rs` + `celestea_session` 的
`SessionRegistry` / `SessionMailbox`。

```
core ← workers
```

依赖方向：**只依赖 core**。驱动 seam（`Llm` / `ToolRegistry` / `AgentLoop`）与 worker 会话日志
由装配层（`packages/runtime`）注入，本包不 import 任何同层实现（ARCHITECTURE.md §1.3 D2）。

## 公开 API（只从 `src/index.ts` 收口）

| 导出 | 作用 |
|---|---|
| `WorkerRegistry` | 表状态 + 会话/邮箱 + 驱动 seam；`upsert` / `status` / `setWorkerState` / `finalize`（**唯一终态写点**）/ `finalizeSession` / `respawn` / `isDriving` / `releaseSession` / `driveIfPossible` / `shutdown` / `release` |
| `WORKER_REGISTRY_SERVICE` | Context token（`celestea.workers.WorkerRegistry`） |
| `parseRegistryTsv` / `serializeRegistryTsv` / `getExtra` / `summarize` | 4 列 TSV 的解析/序列化/k=v token/汇总（坏行跳行不崩） |
| `SessionRegistry` | `session-<n>` 建会话、id→title→workspace 解析、歧义返回候选 |
| `SessionMailbox` | `send` / `poll` / `pending` / `recv`（可 abort）/ `purge` / `release` |
| `runDriverLoop` / `workerContext` / `WorkerDrivers` | mailbox 事件循环驱动（brief 轮 → 回执 → 挂起/唤醒/投递） |
| `executeReceipt` / `sanitizeFileStem` / `lastAssistantSummary` / `reportRelPath` | 回执协议（报告 + 一行回执） |
| `workerTools` / `workerToolSpec` / `contractError` / `deriveShort` / `tokenSafe` | 三个工具（spec 取自 `contracts/tools.json`） |
| `workersPlugin` / `createWorkerRegistry` | 插件：provide 注册表 + 把三个工具注册进已存在的 `ToolRegistry` |
| `Watchdog` / `watchdogPlugin` / `WATCHDOG_SERVICE` | **独立看门狗插件**（ARCHITECTURE.md §7.3 步骤 5）：存活判定 + 自动重派 + 终态裁决（`tick()` 同步一轮，`start()`/`stop()` 定周期） |
| `parseUtc` / `hasInProgressTurn` / `hasDeliverable` / `inGrace` / `watchdogConfig` | 看门狗纯函数（时间戳反解、进行中 turn、交付物、宽限期） |
| `terminalEntry` / `WorkerVerdict` | 终态行构造（status + `ended_at` + `fail`）与判定值类型 |
| `recordingSessionLog` / `SessionLogFactory` | 默认 worker 会话日志（只记录）与注入点 |

## registry.tsv 与行归属

4 列：`wid \t started_at \t status \t extra`，`extra` 是空格分隔的 `k=v` token
（`sess` / `title` / `driven` / `ws` / `provider` / `model` / `effort` / `report_to` / `brief` / `proc` / `state`
/ `retries` / `ended_at` / `fail`）。

- **行归属**：写行时打 `proc=<pid>`；`ownEntries()` 只认本进程行，其他进程（含无 `proc` 的旧残留行）
  不进 `worker_status` 视图，也不会被 wid 过滤命中（W234）。
- **写盘**：tmp + `rename` 原子替换；写失败只回报告警，不阻断 spawn（W180 B1(c)）。
- `tsvPath: null` → 纯内存表（测试 / 临时宿主）。

## mailbox 事件循环

```
driveIfPossible(sid, brief)
  ├─ prune → drivers 未齐 / 会话不存在 → false（仅登记不驱动）
  └─ 后台任务 runDriverLoop：
       state=in-turn → brief turn → 回执协议（写报告 + 投递回执，Ok/Err 都执行一次）
       loop: state=idle → mailbox.recv(sid, signal)  ← 挂起
             收到消息 → state=in-turn → 用 content 跑一轮（同一 worker 天然串行）
             会话被移除 / stopDriver / abortAllNow / release → 退出并释放挂起
```

`send` 若有 parked `recv` 就**直接投给它**（这就是唤醒语义），否则 FIFO 入队；
`recv(sid, signal)` 在 abort / release 时返回 `null`，因此 shutdown 永远不会被挂起的消费者卡住。

## 回执协议（W235/W241）

`spawn_worker(report_to=…)` 时：brief 尾部注入中性提示；brief 轮结束后由驱动**机械执行一次**：

1. 写 `<resultsDir>/<wid>-<short>.md`（`sanitizeFileStem` 防路径穿越；目录不存在则建；写失败只 warn）；
2. 往 `report_to` 的 mailbox 投一行 `WORKER_<wid>_DONE …` / `WORKER_<wid>_FAILED ERR …`，
   尾附 worker 会话最后一条 `assistant_message` 的 `答复: …`（截断 200 字符、换行折叠）。

宿主 `Runtime.runTurn` 在每轮开始 drain 自己的 mailbox，因此回执会作为 `[from <wid>] …` 注入宿主日志。

## worker 生命周期状态机（W736）

`RUNNING → DONE | FAILED`，**恰好落一次**，只由 `WorkerRegistry.finalize` 写（原子 tmp+rename，
同其余行写路径）。终态行冻结：第二次判定、以及任何针对**他进程行**（`proc` 不匹配）的判定都被忽略。

| 触发 | 判定 |
|---|---|
| 回执协议（brief 轮结束，`closeLoop`） | 轮成功 → `DONE`；轮抛错 → `FAILED fail=<错误>`；报告写不出 → `FAILED fail=receipt-not-written:…`（严格于 Rust 的只 warn） |
| 驱动退出（会话被移除 / stopDriver / abort） | 仍 `RUNNING` → `FAILED fail=driver-exited:-session-gone\|stopped` |
| 宿主停机（`shutdown` / `release`） | 仍 `RUNNING` 的行 → `FAILED fail=registry-shutdown`（不留残行在表里恒 RUNNING） |
| 看门狗（独立插件，`watchdog.ts`） | 会话仍活（驱动任务在跑 / 有进行中 turn）→ keep-running；已结束且有 `results/<wid>*.md` → `DONE`；宽限期内 → deferred；`retries < maxRetries` 且有**内存态可读 brief** → 重派（新会话 + `retries+1` + `started_at` 刷新）；否则 → `FAILED` |

`worker_status` 因此返回真实 `by_status`（`RUNNING` / `DONE` / `FAILED` 计数）+ `by_state`（仅 RUNNING 行的
`idle` / `in-turn` / `running` 细分），按 `wid` 过滤的单条视图另带 `ended_at` / `fail`。

看门狗是**独立插件**（`watchdogPlugin`），不塞进驱动/注册表实现里 —— 由装配层决定是否挂载与巡检周期。

## 注入点（为什么没有强引用环）

| 注入 | 默认 | 说明 |
|---|---|---|
| `logFactory` | `recordingSessionLog`（只记录） | 真实投影（`deriveMessages`）在 `packages/session`，由装配层注入 `InMemorySessionLog` |
| `attachDrivers({llm, tools, agentLoop})` | 无 → 只登记不驱动 | 由装配层从 Context 解析后交给注册表 |
| 三个工具对注册表持 **`WeakRef`** | — | registry 释放后工具 fail-closed（`{ok:false,step:"registry",error:"registry released"}`），不复活旧代 |

## 已知迁移差异（与 Rust 的显式分歧）

- Rust 把多词 `title` / `brief` 直接塞进空格分隔的 `extra`，读回时只剩第一个词（`title=Do the thing`
  只解析出 `Do`）。TS 侧：`title` token 折空白为 `-` 保持单 token（回执文件名因此稳定），
  而报告用的**可读** brief/title 存在注册表的**内存态**（`rememberSpawn`），token 仅作诊断/跨进程兜底。
- W736 状态机：`fail=<原因>` 同样折空白为单 token；Rust 的 `fail` 只在状态里，不落 token。
- W736 看门狗只看**本进程行**（`ownEntries`，与 `worker_status` 视图同口径），Rust 会裁决整张 tsv。
- W736 存活判定在 Rust「有进行中 turn」之外**追加**「驱动任务在跑」（TS 驱动会挂在 mailbox 上等消息，
  挂起但仍然可寻址的 worker 是活的）。Rust W224 F3 的结论（未消费邮件不判活）保留。
- W736 交付物探测：`results` 目录不存在视为「暂无交付物」，IO 错误（ENOTDIR/EACCES）才跳过本轮；Rust 两者都跳过。
- W736 日志（`watcher.log` / `alerts.log`）**可选**（默认 null，不写盘）；Rust 默认硬编码部署路径。
- W736 回执路径落终态后**不释放会话**（worker 仍可收 relay 后续消息）；看门狗裁决终态时才 `releaseSession`
  （对齐 Rust F2：会话 + mailbox 队列 + 驱动一并释放）。

## 测试

`packages/workers/src/*.test.ts`（89 例）：

- `registry.test.ts`：tsv upsert/落盘/round-trip、行归属、汇总与过滤、state 标注、内存模式、驱动生命周期；
- `mailbox.test.ts`：FIFO、挂起→唤醒→投递、多消费者顺序、signal abort、purge、release；
- `sessions.test.ts`：`session-<n>`、解析优先级、歧义候选、主机会话登记；
- `tools.test.ts`：三工具 spec 来自契约、spawn 校验/去重/命名/token、send 投递与歧义、status 汇总、WeakRef fail-closed；
- `receipt.test.ts`：报告文件与 DONE/FAILED 回执、`答复` 摘要、消毒、坏路径只 warn、驱动 brief→回执→挂起→唤醒→串行投递；
- `watchdog.test.ts`：时间戳反解/进行中 turn/交付物/宽限期纯函数、keep-running（进行中 turn 与挂起驱动两种）、
  `DONE`（有交付物）、`FAILED`（会话消失 + retries 耗尽 / 无可读 brief）、宽限 deferred、自动重派与新会话再驱动、
  探测 IO 错误跳过、终态行不被触碰、日志落盘、`watchdogPlugin` 挂载/自启开关；
- `plugin.test.ts`：provide token、三工具注册进 ToolRegistry、后挂载覆盖。
