# 迭代方向 E · 可恢复多 agent（§2）

> 状态：**设计（未实现）** ｜ 本册是 [`README.md`](./README.md) 的分册：worker 表落盘、认领与重派的目标契约。
> 章节编号沿用原文；总览与跨能力结论见索引。

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
| G2-1 |（W787 已修）studio 侧 worker 表默认落盘 `<data dir>/worker-registry.tsv`（`workerRegistryPath()` 决定；`null` 才是内存） | 仅显式 `tsvPath: null` 时才是纯内存表 |
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
| `attempt=<n>` | 第几次尝试（**首次 = 0**，重派 +1；§5.2 贯通约定，与账本/回退同一编号语义） | 回执幂等键、报告文件名（补 G2-3） |
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
| B2 | 同一 wid 两次 attempt | `results/<wid>-<short>-a0.md` 与 `-a1.md` **同时存在**（`existsSync` 双断言） | `packages/workers/src/receipt.test.ts` 延伸 |
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

### 2.7 实现状态（W787 回填，P0 + P1）

| 设计条目 | 状态 | 落点 / 说明 |
|---|---|---|
| P0① 表落盘（可配路径 + 保留 `null`） | **已实现** | `apps/studio/src/runtime/worker-table.ts`（`workerTablePath()`：显式选项 > `CELESTEA_WORKER_REGISTRY` > `<data dir>/worker-registry.tsv`；**空值 = 纯内存**）+ `session-compose.ts`（`workerRegistryPath` 传给 `WorkerWiring.tsvPath`，不再是硬编码 `null`） |
| P0② 行内 `host=`/`attempt=`/`lease=` | **已实现** | `packages/workers/src/tools.ts`（spawn 落三 token）、`registry.ts`（`setWorkerState` 续期 `lease`、`respawn` 时 `attempt+1`）、`row.ts`（token 纯函数）、`registry-tsv.ts`（`workerHost/workerAttempt/workerLease/leaseToken`） |
| P0③ boot 只观测 | **已实现** | `packages/workers/src/recovery.ts`（纯判定：`observeWorkerTable`，§2.2.4 决策表的**判定**已算、**动作**不执行）+ `apps/studio/src/runtime/worker-recovery.ts`（boot：读表 → 判定 → 审计 + stderr）+ `watchdog-view.ts`/`worker-table.ts`（`GET /api/worker/status` 增 `stale[]`/`orphans[]`，**纯增字段**）；**不重派、不改行** |
| P1① 回执 attempt 化 + `receipt=` | **已实现** | `receipt.ts`（`reportStem()` → `results/<wid>-<short>-a<attempt>.md`，报告头与回执行都带 `attempt=`）、`registry.ts#closeLoop`（先查行内 `receipt=` token，已发即返回；发完把 key 写回**同一次原子行写**） |
| P1② `drainHost()` 幂等键 | **已实现** | `worker-wiring.ts`：`kind:"receipt"` 的消息用 `receipt:<wid>:<attempt>`（`registry.receiptKeyFor()`），其余消息保留 `mailbox:<seq>` —— **刻意如此**：把 relay 也按 `(wid,attempt)` 去重会吞掉第二条**有意**的消息 |
| P1③ `worker_status` 增 `attempt`/`host_session`/`last_receipt` | **已实现** | `row.ts#entryView()` + `contracts/endpoints.json` 的 `workers` 字段说明 |
| P1④ 与 DSH 插件表只读协同 | **未实现（设计标注"可选"）** | 见下"偏离"第 3 条 |

**与 §2.2.1「一张表」相关的两处必要更正（登记，不静默）**：

1. **归属判定细化**：一个进程现在**共用一张表**（`host=` 用来区分会话），单靠 `proc`（同 pid）会让两个会话互相看见并互相裁决对方的行。因此 `ownEntries()` = `proc` **且**（若注册表声明了 host 会话）`host=`；**没有 `host=` 的旧行**仍按 `proc` 认领（否则会丢掉本进程自己的行）。同时 `persist()` 改为**合并写**（`mergeTableRows`）：写自己的行之前先读回文件里其它会话已写的行，否则后写的会话会静默删掉先写的行。
2. **pin 语义跟着"活"走**：`pinned`（不回收、不占 maxLive）由「registry 里有行」改为「有**活的** worker 工作」（`hasLiveWorkersOf`）。表落盘后前者的含义变成"曾经 spawn 过就永久豁免会话上限"，跨重启会堆满 pin；settled 行留在盘上、随下一代实例回来（这正是 2-P0 要的）。

**其它偏离 / 已知边界（逐条）**：

1. **`attempt` 编号：已裁决，§5.2 胜，统一 0 基**（W787 归一，见下）。本文原 §2.2.2 的"首次 = 1"与 §5.2 的"`attempt=0` 表示首次"冲突；裁决依据是 §5.2 明写"账本与回执与 registry 行使用**同一编号语义**"，而账本侧（`packages/llm/src/fallback.ts` 的 `for (let attempt = 0; …)`、D6 断言 `attempt = 0/1/2`）已是**已交付且测试冻结**的 0 基。因此**改 worker 侧，不改账本侧**：`workerAttempt`（缺 token ⇒ 首试 ⇒ 0）、spawn 落 `attempt=0`、报告名首个 `-a0.md`、幂等键首个 `receipt:<wid>:0`；§2.2.2 表格已同步改写为"首次 = 0"。
2. **`lease` 无心跳续期**（P2 项）：只在 spawn / 重派 / driver 状态变化时续期。判定因此是"最后一次活动"，不是"现在还在跑"——对崩溃判定足够，对长静默的 RUNNING 行偏保守（宁可判活，不误重派，符合 R2-2）。
3. **未做 P1④（读 DSH 插件表做展示）**：插件表的路径（`workerBase`）不在 studio 的配置面内，硬编码外部服务的路径会引入 §2.2.1/R2-1 想要避免的耦合。留 P2 与"是否合并两表"（U4）一起裁决。
4. **wid 在表内是主键**：settled 行会**冻结** wid（§2.2.4 第 5 行），因此表落盘后**跨重启**用同一个 wid 再 spawn 会被 `spawn_worker` 拒绝（"wid already registered"）。P0 不改这条既有语义（B5 的冻结语义），补法是 P2 的"终态行 + 同 wid = 下一 attempt"，届时报告名/回执键都已就绪。
5. **审计落地为本地 append-only**：`<data dir>/recovery-audit.jsonl`（与 `grants-audit.jsonl`/`fallbacks-audit.jsonl` 同纪律；平台 `POST /api/audit` best-effort，失败只记本地）。

**证据**：B1/B1b/B4/B6/B7/B8 落 `packages/workers/src/registry.test.ts`、`packages/workers/src/receipt.test.ts`、`packages/runtime/src/worker-wiring.test.ts`、`apps/studio/src/runtime/worker-recovery.test.ts`；真机口径见 §2.4 逐条。

---

