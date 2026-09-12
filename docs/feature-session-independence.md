# 特性设计 · 会话独立性（每会话独立 runtime + 会话标识 SSE）

> 状态：**已实现**（2026-09-11 核实）。本文是实现依据与契约记录；落地见 `packages/runtime/src/session-registry.ts`、`apps/studio/src/runtime/real-runtime-adapter.ts`。
> 范围：`packages/runtime`、`apps/studio`（宿主 HTTP 层）、共用前端 `/src/celestea_studio/frontend/src/**`。
> 参照实现：Rust 版 `/src/celestea_studio`（**已退役**，见其 `LEGACY-RUST-BACKEND.md`）。
> 一句话目标：**会话就是会话**——任意时刻可打开任意会话视图，后台会话继续跑，互不串台；不存在"全局主会话"。

---

## 0. 结论速览

| # | 设计决定 | 落点 |
|---|---|---|
| D1 | 用 **`SessionRuntimeRegistry`（session id → 独立 runtime/Gen 实例）** 取代"单活动会话 + 单 Gen" | `packages/runtime` 新增 `session-registry.ts`；`apps/studio` 的 `RealEngine` 改为注册表宿主 |
| D2 | **配置世代（profile epoch）与运行实例解耦**：`GenerationHub` 退化为"配置权威"，不再持有唯一 runtime；每会话实例按 epoch 惰性重建 | `packages/runtime/src/gen.ts:57-142` |
| D3 | **busy 槽下沉到会话**：409 只约束"该会话自身的并发" | `packages/runtime/src/turn-runner.ts:78,114-127`（已天然按实例）、`apps/studio/src/runtime/real-runtime-adapter.ts:248-269` |
| D4 | **SSE 信封加 `session` 字段**：`{v,session,turn,seq,payload}`；默认仍全量广播（单连接多路复用），新增 `?session=` 服务端可选分流 | `apps/studio/src/sse.ts:122-161` |
| D5 | **激活语义重定义**：`activate` = "打开该会话视图 + 确保其 runtime 存在"，不再切换全局引擎，不再因别的会话在跑而 409 | `apps/studio/src/handlers/sessions.ts:70-92` |
| D6 | **前端每会话一个视图容器 + 本地路由**：侧栏点击纯本地切换（0 往返），SSE 按 `session` 路由到对应视图 | `frontend/src/state.ts:8-31`、`sse.ts:41-99`、`chat.ts:83-126`、`ui/restore.ts:337-347` |
| D7 | **worker 编排随会话下沉**：每会话一个 `WorkerRegistry` + 独立收件箱（`hostSessionId = <session id>`） | `packages/runtime/src/worker-wiring.ts:68`、`tokens.ts:23` |
| D8 | **数据文件零变更**：`<ws>/<session>/cli-main.jsonl`、`session.json` 语义与格式不变；运行态全部内存派生 | — |
| D9 | **资源上限**：`MAX_LIVE_SESSIONS=4`、`MAX_CONCURRENT_TURNS=2`、`IDLE_TTL=15min`、LRU 只回收空闲实例；SSE **按会话分桶 + 合并 status 帧**，杜绝后台会话挤掉前台流 | 见 §6 |

---

## 1. 现状与差距

### 1.1 Rust 参考实现（当前生产）

| 维度 | Rust 现状 | 位置 |
|---|---|---|
| 活动会话 | **全局唯一**，持久化在 `workspaces.json.active_session`；compose 时读 `CELESTEA_SESSION_DIR` 环境变量决定重放哪个会话目录 | `src/main.rs:1222-1249`、`src/workspaces.rs:139,163` |
| 引擎世代 | **全局唯一** `AppState.gen: RwLock<Gen>`；`swap_gen` 全量替换 | `src/main.rs:475-497` |
| busy 槽 | **全局唯一** `AppState.busy: Arc<Mutex<Option<watch::Sender<bool>>>>` | `src/main.rs:480` |
| SSE | 全局 `broadcast::Sender<BusEvent>`（cap 512），信封 `{turn, seq, payload}`，**不带 session** | `src/main.rs:246-250,644-660,662-664` |
| 激活 | `post_session_activate`：**busy 即 409**，然后 `set_var(CELESTEA_SESSION_DIR)` → 重新 compose → swap → 持久化 | `src/workspaces.rs:1323-1372` |
| turn 计数 | 全局 `next_turn: AtomicU64` | `src/main.rs:481` |

后果：turn 进行中无法切会话（409）；SSE 无会话标识，前端无法分辨事件属于谁；`/api/cancel` 无法定向取消。

### 1.2 TS 现状（`/src/celestea_studio-ts`）

TS 已经把"单一活动会话"从环境变量改成了注入式绑定，但**仍是单实例**：

| 维度 | TS 现状 | 位置 |
|---|---|---|
| 会话绑定 | `RealEngine.bindingValue: SessionBinding`（单个）；`bind(sessionId)` 在 turn 开始前 `runtime.rebind()` | `apps/studio/src/runtime/real-runtime-adapter.ts:120,233-244` |
| 引擎世代 | `GenerationHub` 持单个 `gen: Gen \| null` | `packages/runtime/src/gen.ts:57-142` |
| busy 槽 | `RealEngine.inFlight: boolean` + 每个 `TurnRunner.busy`；`isBusy()` = 二者或 | `real-runtime-adapter.ts:123,248-250` |
| turn 计数 | `RealEngine.turnNo`（全局） | `real-runtime-adapter.ts:124,262-263` |
| SSE | `createStudioBus()` 全局总线，信封 `{turn, seq, payload}`；`assertEventName` 冻结 8 个事件名 | `apps/studio/src/sse.ts:122-161` |
| 激活 | `if (deps.runtime.isBusy()) return failJson(c, 409, "turn in progress; activate applies between turns")` | `apps/studio/src/handlers/sessions.ts:73` |
| turn 入口 | `deps.runtime.startTurn({input, session: activeSession(deps)})`——会话来自**全局 active_session**，请求体里没有 session | `apps/studio/src/handlers/dialog.ts:51`、`runtime-adapter.ts:78-82` |
| 前端状态 | `S` 全局单例（`turn/streaming/assistant/selSession`），消息区是唯一的 `#messages` | `frontend/src/state.ts:8-31` |
| 前端 SSE | 单一 `EventSource('/api/events')`，`withEnvelope` 只合并 `turn/seq` 到 payload | `frontend/src/sse.ts:41-49,62-99` |

**好消息**：TS 的分层（`core` seam / `runtime` 装配 / `apps/studio` 宿主）天然支持多实例——`compose()` 每次调用返回一个自洽的 `Runtime`（`packages/runtime/src/compose.ts:88-138`），`TurnRunner` 的 busy 槽本来就是**每实例**的（`turn-runner.ts:78,114-127`）。缺的只是"实例注册表 + 宿主改造 + 信封扩展 + 前端多视图"。

---

## 2. 目标架构

### 2.1 `SessionRuntimeRegistry`（session id → 独立实例）

新增 `packages/runtime/src/session-registry.ts`：

```ts
/** 一个会话的全部运行态：一个自洽的 Runtime + 该会话自己的槽位与计数。 */
export interface SessionRuntime {
  readonly sessionId: string;          // "<workspace>/<session>"
  readonly dir: string | null;         // 会话目录（null = 未落盘的临时会话）
  /** 构建本实例所用的 profile 快照 epoch（落后即需重建）。 */
  readonly profileEpoch: number;
  runtime: Runtime;                    // 现有 Runtime（含自己的 TurnRunner/status/usage/log）
  turnNo: number;                      // 每会话递增的 turn 序号
  controller: AbortController | null;  // 在飞 turn 的取消句柄
  inFlight: boolean;
  lastActiveAt: number;                // LRU 依据
}

export interface SessionRegistryDeps {
  /** 用当前 profile 组装一个新实例（宿主注入：内部调用 compose()）。 */
  build: (sessionId: string, dir: string | null, profileEpoch: number) => Runtime;
  /** 当前配置世代；实例 epoch 落后即需重建。 */
  currentEpoch: () => number;
  /** 回收前的收尾（shutdown + release + 关日志 fd）。 */
  dispose: (rt: SessionRuntime) => Promise<void>;
  maxLive?: number;      // 活实例上限（0 = 不限）
  idleTtlMs?: number;    // 闲置 TTL
  now?: () => number;
}

export class SessionRuntimeRegistry {
  /** 取该会话的实例；不存在则按需创建（惰性）。 */
  ensure(sessionId: string, dir: string | null): SessionRuntime;
  /** 幂等取用（不存在返回 null，不创建）。 */
  peek(sessionId: string): SessionRuntime | null;
  /** 所有活实例（诊断 / 聚合视图）。 */
  list(): readonly SessionRuntime[];
  /** 配置世代变更：标记全部实例待重建（不打断在飞 turn）。 */
  invalidateAll(): void;
  /** 在飞 turn 数 / 活实例数（资源治理用）。 */
  stats(): { live: number; inFlight: number; turns: number };
  /** LRU 回收：只回收 inFlight=false 且 lastActiveAt 超 TTL 的实例。 */
  evictIdle(): Promise<string[]>;
  /** 全部拆除（进程退出 / 测试）。 */
  shutdown(): Promise<void>;
}
```

要点：

1. **不再有"全局主会话"**。`workspaces.json.active_session` 降级为**"刷新后恢复哪个视图"的 UI 偏好**，不再是引擎路由依据（诊断页/CLI 仍可读，但它不再决定 `/api/turn` 打到谁）。
2. **每个实例一个 `TurnRunner`**（现有实现即如此），所以"每会话一个 busy 槽"是**零成本**获得的：`turn-runner.ts:78`。
3. **每实例自己的 status/usage/log**：`compose()` 已经为每个实例 `createUsageTracker()` + `createStatusTracker()`（`compose.ts:90-91`、`real-runtime-adapter.ts:193`），所以 `/api/status` 的按会话化只是"选对实例"。
4. **活动会话切换路径不再需要 `Runtime.rebind()`**：每实例绑定固定会话（`session-binding.ts:20-27` 的 `sessionId/dir` 在实例生命周期内不变）。`rebind` 保留，但只用于 **compact 后的同会话重开日志**（`real-runtime-adapter.ts:372-381`）——语义更窄、更安全。

### 2.2 配置世代与实例解耦

`GenerationHub`（`gen.ts`）当前语义是"唯一可变世代 + 热插拔"。改造为 **`ProfileAuthority`**：

- 持有 `{ profile, config: SanitizedConfig, epoch }`，`epoch` 每次 `POST /api/config` 成功即 `+1`；
- **不持有 runtime**（"唯一 runtime" 的概念被删除）；
- `SessionRuntimeRegistry.invalidateAll()` 在 epoch 变更后调用；
- 每个实例在自己的**下一个 turn 边界**检查 `profileEpoch < currentEpoch`，若落后则先 `dispose` 再 `build`（等价于 Rust 的"activate 时重新 compose"，但**按会话惰性**且**不打断在飞 turn**）。

保留原设计的不变量：**一个实例永远只由一个 profile 快照构建**，读者不可能看到混合态（`gen.ts:1-20` 的原始动机），只是"世代数 = 实例数"而不是 1。

热点配置（模型/推理档位）变更的语义随之变为：**已打开的会话在下一轮开始时生效**（后台在飞的轮次不被中断）；前端在状态栏标注"配置将在会话下一轮生效"。这比 Rust 的"立刻 global swap"更保守。

### 2.3 busy 槽与并发

| 层 | 现状 | 目标 |
|---|---|---|
| turn 槽 | `TurnRunner.busy`（每实例） + `RealEngine.inFlight`（全局） | 只保留每实例槽；**删除** `RealEngine.inFlight` 这个全局标志 |
| `POST /api/turn` 409 | 任一会话在跑即 409 | **该会话**在跑才 409；错误串不变（`a turn is already running`），仅作用域收窄 |
| `POST /api/cancel` | 全局取消 | 定向取消：`{session}` 指定；缺省 = `active_session`（向后兼容） |
| `POST /api/sessions/{id}/compact` 409 | 任一会话在跑即 409 | 仅 `{id}` 在跑才 409 |
| `POST /api/clear` 409 | `RealEngine.clear` 检查全局 busy | 仅目标会话忙才 409（并**新增**该守卫，见 §4.4） |
| `POST /api/config` 409 | 全局 busy | **不再 409**：只 bump epoch 并 `invalidateAll()`，返回 `pending_sessions: [...]` |

### 2.4 SSE 信封扩展

**信封**（向后兼容的**纯增字段**）：

```jsonc
// 现在
data: {"turn":3,"seq":812,"payload":{"delta":"…"}}
// 目标
data: {"v":1,"session":"ws1/cli-main","turn":3,"seq":812,"payload":{"delta":"…"}}
```

- `session`：**必填**（字符串）。属于哪个会话的流。进程级事件（如 `lagged`）用 `session: null`。
- `v`：信封版本，`1`。缺失视为 `0`（Rust 老信封）。前端据此选择路由策略（也可经 `/api/health.capabilities`，见 §4.10）。
- `turn`：**语义变更** —— 从"进程全局 turn 序号"变为"**该会话内**的 turn 序号"（每实例 `turnNo`）。这是本设计中最需要显式声明的契约变更。
- `seq`：**保持进程级单调**（单一原子计数器）。理由：跨会话全序对丢帧检测/诊断/看门狗有价值，且 `lagged` 逻辑（`sse.ts:127-138`）与订阅者队列语义都不用改。
- `payload` 内容**逐字不变**（8 个事件名与字段均不动）。

**分流策略**（两个都要，职责不同）：

1. **默认：全量广播 + 客户端本地路由**（推荐默认）。
   `GET /api/events` 不传参 = 订阅全部会话（与 Rust 现有行为完全一致）。前端**一个 tab 一条连接**，按 `session` 把帧路由到对应视图；后台会话的帧用于更新侧栏卡片状态（运行中/错误/完成），但**不渲染进聚焦视图**。
   优点：连接数不随会话数增长；后台状态天然可见（这是"会话卡片显示各自运行状态"的前提）。
2. **可选：`GET /api/events?session=<id>` = 服务端只推该会话（+ `session:null` 的进程级帧）**。
   为 headless/CLI/窄客户端准备。多会话订阅可重复 query：`?session=a&session=b`。

**背压与丢帧（必须改的一点）**：现有 `Queue` 是**每订阅者一个 512 帧的有界队列，溢出即清空整个 backlog 并推一个 `lagged`**（`sse.ts:63-113,127-138`）。多会话并发后会出现新故障：**后台会话的 text 洪流会把前台聚焦会话的增量一起冲掉**——用户看到"我正在看的会话莫名断流"。
对策（按会话分桶，而非简单加大容量）：

- `status` 帧（含 `status:start` / 进度 tick）**每会话只保留最新一帧**（coalesce），队列里同会话的旧 status 直接替换；
- 非 status 帧（text/thinking/tool/tool_result/done/compact）**按会话分桶**，每桶容量 `cap / max(1, liveSessions)`（下限 64），溢出只丢**同一会话**的 backlog；
- `lagged` 帧携带 `{phase:"lagged", session, hint, dropped:<n>}`，前端在**该会话视图**里提示，而不是全局提示。
- 总容量可配：`CELESTEA_SSE_BUS_CAPACITY`（默认 512，多会话建议 ≤2048）。

### 2.5 激活语义

**新定义**：`POST /api/sessions/{id}/activate` = **"打开这个会话的视图 + 确保它有一个可用的 runtime 实例"**。

1. 解析 `id` → `(workspace, name, dir)`（沿用现有 `session_dir_for` 语义：400/404 不变）。
2. `registry.ensure(id, dir)`——不存在则创建实例（重放 `cli-main.jsonl`）。
3. 更新 `workspaces.json.active_session = id`（**只作为"刷新后恢复哪个视图"的偏好**；持久化失败仍 500，语义不变）。
4. 返回 `200 {ok:true, active_session:id, runtime:"created"|"existing", busy:boolean, rebuilt:boolean}`。
5. **不再返回 409**。目标会话自己在跑完全没问题——activate 只"确保存在"，从不打断、也从不被别的会话的忙阻塞。

**前端配合（关键）**：侧栏点击**先本地切换视图，再 fire-and-forget 调 activate**。"打开视图"根本不需要服务端往返；activate 只是**预热**（建实例/重放日志/按需重建世代）。因此即使 activate 失败（网络抖动/旧后端 409），用户依然能看历史（`GET /api/sessions/{id}/messages` 独立于 runtime）——只有发消息时才真正需要 runtime，届时 `POST /api/turn` 会自动 `ensure` 一次。

### 2.6 前端多视图

**状态层**：`S`（`state.ts:8-31`）从"全局单会话态"改为"**焦点 + 每会话视图态**"：

```ts
export interface SessionViewState {
  sid: string;                       // "<ws>/<sess>"
  root: HTMLElement;                 // 本会话的消息容器（<div class="sess-view">），非焦点时 hidden
  streaming: boolean;
  turn: number | null;               // 该会话当前 turn（来自路由后的 status:start）
  assistant: AssistantView | null;   // 流式气泡句柄
  t0: number;                        // 该会话本轮起始时刻（每会话独立计时）
  toolStep: number;                  // 该会话本轮工具步数
  lastPhase: string | null;          // 会话卡片徽标依据
  err: string | null;
  restored: boolean;                 // 是否已拉过历史（懒加载）
  scrollTop: number;                 // 离开焦点时记录
  tail: HistoryMsg | null;           // 现有的"衔接去重"尾部（从模块级搬到会话级）
  guard: { active: boolean; buf: string; all: boolean };
}

export interface AppState {
  conn: ConnState;
  focus: string | null;                 // 当前聚焦会话
  views: Map<string, SessionViewState>;  // 已打开的会话视图
  sessions: SessionInfo[];             // 侧栏树数据
  msgTimer: number | null;             // 只给焦点会话走表
}
```

**DOM 策略**：每个打开过的会话有一个 `<div class="sess-view" data-sid>` 兄弟节点，非焦点加 `hidden`。切换 = 切 `hidden` + 恢复该节点 `scrollTop`，**零重渲染**——天然保住"正在跑的流、工具卡、折叠状态、滚动位置"。（被 LRU 摘除的视图才需要走 `restoreSessionHistory` 重建。）

**SSE 路由**（改 `chat.ts` 的 `connectSse`，`chat.ts:184-255`）：

```ts
sse.onFrame((env, name, payload) => {
  const sid = env.session ?? S.focus;                        // 老信封（无 session）→ 归给焦点会话
  const view = sid === null ? null : S.views.get(sid);
  if (view !== undefined) applyToView(view, name, payload);   // 渲染进该会话
  if (sid !== null) updateSessionBadge(sid, name, payload);    // 侧栏卡片状态（无论是否聚焦）
  // sid === null：进程级帧（lagged / 配置变更）→ 全局或焦点提示
});
```

难点与对策：

| 难点 | 现状 | 对策 |
|---|---|---|
| `S.turn` 被用来"过滤不属于本轮的帧"（`chat.ts:104-111,130,143,150,160,168`） | 全局单值 | 换成 `view.turn`（每会话），过滤逻辑不变 |
| 思考段归属（`endTurn()` 及模块级句柄） | 全局 | 迁到 `view`（`ui/messages.ts` 的 thinkSeg 句柄按会话持有） |
| 衔接去重（`restore.ts:28-40` 模块级 `tail/guardActive/guardBuf/guardAll`） | 全局单份 | 移入 `view.guard`——**这是必须改的**：多会话并发时模块级会互相污染 |
| 计时器（`ui/statusbar.ts:33-55`） | 全局单一 interval | 每会话 `t0`，只给焦点会话渲染；离开焦点不跑表 |
| `resolveActiveSession()`（`restore.ts:279-300`） | 每次 3 个 GET 猜活动会话 | 直接读 `S.focus`；`/compact` 用 `S.focus` |
| 工具卡 id 映射（`restore.ts:95` `toolCardsById`） | 全局 Map | 移入 `view` |

**侧栏**（`ui/sessions.ts`）：

- 点击会话叶子 = `switchView(id)`（本地） + `void api.activateSession(id).catch(noop)`（预热，容忍任何错误）。
- 会话叶子新增**状态徽标**：`运行中`（该会话 inFlight）/ `出错`（lastPhase==='error'）/ `完成`（本轮结束 3s 内）/ 无（空闲）。数据来自路由后的 SSE。
- 叶子上的"当前活跃"语义改为"当前聚焦"；`S.selSession` 改名 `S.focus`。
- 已打开视图的会话叶子加一个弱化的"已打开"标记（可选）。

### 2.7 worker 编排随会话下沉

现状：`hostSessionId` 默认 `"cli-main"`（`tokens.ts:23`、`worker-wiring.ts:68`），worker 收件箱是**进程级单队列**；`workerSessionsOf` / `workerMessages` 从"当前世代"的唯一 registry 取（`real-runtime-adapter.ts:385-391`）。

目标：**每会话实例一个 `WorkerRegistry`，`hostSessionId = <session id>`**。理由与影响：

- worker receipt 必须回到**派发它的会话**（现在会串到全局主会话）；
- `spawn_worker` 的 `reportTo` 语义更自然（同会话即"当前会话"）；
- 影响端点：
  - `GET /api/worker/status`：跨活实例**聚合**，响应新增 `by_session: {sid: {...}}`（纯增字段）；
  - `GET /api/sessions` 的 `kind:"worker"` 行：合并所有活实例的 worker 行，`workspace` 字段由 `"engine"` 改为**实际工作区**（**行为变更**，已在 §4.7 声明）；
  - `GET /api/sessions/worker:<sid>/messages`：先按 `sid` 在所有活实例里找，找不到 404（不变）；
  - `POST /api/worker/spawn|send`：请求体新增可选 `session`（缺省 = `active_session`，向后兼容）。
- `resultsDir` 保持**进程级共享**（worker 是跨会话的外部进程），文件命名已含 `wid`，无需改。
- `registry.tsv` 仍**不写**（`real-runtime-adapter.ts:171-179` 的 `tsvPath: null` 是有意为之，避免动共享 fleet 表）——本设计不改这一点。

---

## 3. 数据兼容与迁移

### 3.1 磁盘格式：**零变更**

| 文件 | 变化 |
|---|---|
| `<ws>/<session>/cli-main.jsonl` | **不变**（会话日志的唯一真源；每实例只打开自己那一个 fd） |
| `<ws>/<session>/session.json` | **不变**（`{"model": …}` 会话级模型覆盖仍在 turn 前生效，见 §4.2） |
| `workspaces.json` | `active_session` 语义降级为"刷新后恢复的视图偏好"；**字段与格式不变**，不加字段 |
| `providers.json` / `prompts.json` | 不变 |
| **新增** `<session>/grants.json` | 见 `feature-session-grants.md`（提权通道设计） |

**不做的事**（有意）：不把"打开过哪些会话"持久化到服务端。那是纯客户端 UI 状态（`localStorage` 足够），落到服务端只会让 `workspaces.json` 承担两个互相纠缠的语义。

### 3.2 并发写同一会话的保护

两个机制保证"一个会话同一时刻只有一个写者"：

1. 注册表保证 `ensure(id)` 返回**同一实例**（不会因两次并发请求建出两个实例）；
2. 该实例的 `TurnRunner.busy` 保证同一实例只有一个 turn（`turn-runner.ts:114-127`）。

外部进程（Rust 后端 / CLI）同时写同一 `cli-main.jsonl` 仍是**未防护**的（现状也如此），记为已知限制：**切换期间不要让两个后端同时写同一工作区**。

### 3.3 从"单活动会话"平滑迁移

| 步骤 | 动作 | 可回滚 |
|---|---|---|
| M1 | 上注册表 + 信封加 `session`（新前端能按 `session` 路由，**缺字段时回退到焦点**）→ 老前端行为完全不变 | 恢复单实例 |
| M2 | `/api/turn`、`/api/cancel` 接受可选 `session` 字段（缺省 = `active_session`） | 同上 |
| M3 | `activate` 去掉 409，改返回 `busy` 字段 | 老前端不读该字段，无感 |
| M4 | 前端多视图 + 本地路由上线 | 前端可独立回滚（后端仍兼容缺 `session` 的请求） |
| M5 | `/api/config` 去 409，改 epoch 失效 | 需配套前端提示"下一轮生效" |

每一步都**前后端可独立回滚**，这是选择"纯增字段 + 缺省回退"而非"改字段语义"的原因。

### 3.4 与 Rust 后端同跑时的行为差异（前端必须同时容忍）

| 场景 | Rust 后端 | TS 后端（目标） | 前端策略 |
|---|---|---|---|
| 切会话 | `POST activate`，turn 中 **409** | 本地切换 + 预热；**不 409** | 本地切换**先行**；activate 失败只记诊断，不弹错、不回滚视图 |
| 切会话代价 | 重新 compose（全局，可能数百 ms） | 首次 `ensure` 重放日志；已打开则 ~0 | 首次切换显示轻量进度条（现有 `.switch-progress`），之后瞬时 |
| SSE 信封 | `{turn,seq,payload}` | `{v,session,turn,seq,payload}` | 缺 `session` → 归给焦点会话；`turn` 只与该会话视图内的 `turn` 比较 |
| turn 序号 | 进程全局递增 | **每会话**递增 | 不跨会话比较；卡片不显示绝对 turn |
| `/api/cancel` | 取消唯一在跑 turn | 取消指定会话的 turn | 传 `{session: focus}` |
| `/api/status` | 单一 `session` 字段 | `session` = 请求指定会话；缺省 `active_session` | 焦点会话状态栏轮询带 `?session=` |
| `/api/worker/status` | 单 registry | 跨会话聚合 + `by_session` | 只用 `total/by_status/workers`（两版都有） |

> **待确认项 ①**：`POST /api/cancel` 传多余 body 字段、`GET /api/status` 传未知 query，在 axum 侧需确认是"忽略"而非 400/422。若 Rust 严格拒绝，则前端必须在 `/api/health` 能力探测（§4.10）通过之后才附带这些参数——**M2/M3 的落地前提**。用 `capabilities` 兜底即可消除该风险。

---

## 4. 契约影响（逐条）

约定：**兼容** = 老前端/老客户端不受影响；**变更** = 需要同步前端或声明破坏。

### 4.1 `GET /api/events`（SSE）

| 项 | 内容 |
|---|---|
| 请求 | 新增**可选** query：`session=<id>`（可重复）。缺省 = 全部会话（与现状一致）。 |
| 响应信封 | **兼容增字段**：`{v:1, session:<id\|null>, turn, seq, payload}`。老客户端忽略未知键。 |
| `turn` 语义 | **变更**：进程全局 → 会话内序号。老前端把它与本地 `S.turn` 比较，只要它始终"单会话聚焦"，比较仍然正确。 |
| `seq` | 不变（进程级单调）。 |
| `lagged` 帧 | **兼容增字段**：payload 增 `session`、`dropped`；`hint` 文本不变（`"slow client, skipped events"`）。 |
| 背压 | **变更（内部）**：由"整队列清空"改为"按会话分桶 + status 合并"（§2.4）。对老客户端表现为**丢帧更少**，不是破坏。 |
| 事件名 | 不变（仍 8 个，`assertEventName` 不改）。 |

### 4.2 `POST /api/turn`

| 项 | 内容 |
|---|---|
| 请求 | **兼容增字段**：`{"input": string, "session"?: string}`。缺省 = `active_session`（现状）。 |
| 响应 | 不变：`202 {turn, status:"started"}`。`turn` 现在是**该会话内**的序号。 |
| 409 | **作用域收窄**：由"任一会话在跑"→"该会话在跑"。错误串逐字不变（`"a turn is already running"`）。 |
| 404 | **新增**：`session` 指向未知会话 → `404 {ok:false,error:"unknown session '<id>'"}`（与 `GET /messages` 同款）。缺省路径不产生新 404。 |
| 会话级模型覆盖 | 不变：`session.json.model` 在 `ensure`/重建时作为 profile 覆盖（等价 Rust `post_session_activate` 的 `pj["model"]`，`workspaces.rs:1352-1358`）；模型名非法时 `400 invalid session model: {e}`。**注意**：Rust 在 activate 时报这个 400，TS 可能在 `turn` 时报——前端两种都要能显示。 |
| 自动 `ensure` | `session` 指向的会话尚无实例时，`turn` **自动创建实例**（不要求先 activate）。 |

### 4.3 `POST /api/cancel`

| 项 | 内容 |
|---|---|
| 请求 | **兼容增字段**：`{"session"?: string}`。缺省 = `active_session`。 |
| 响应 | 不变：`200 {ok:true, cancelled:boolean}`。`cancelled` 现在只反映**目标会话**是否在跑。 |
| 语义 | 不变：协作式取消，只发信号；终态仍由 SSE `status:cancelled` 决定。 |

### 4.4 `POST /api/clear`

| 项 | 内容 |
|---|---|
| 请求 | **兼容增字段**：`{"session"?: string}`。缺省 = `active_session`。 |
| 响应 | 不变：`{ok:true, cleared:true, session}`。 |
| 409 | **新增**（作用域收窄的对称结果）：目标会话正在跑 → `409`。现状是无 409 守卫且危险（会截断正在写的日志）。这是一次**兼容性收紧**，需在 `contracts/endpoints.json` 的 `post_clear.errors` 补一条。 |

### 4.5 `POST /api/sessions/{id}/compact`

| 项 | 内容 |
|---|---|
| 请求 | 不变（会话在 path）。 |
| 响应 | 不变：`{ok, compacted, kept_turns?, note, session, rebound}`。`rebound` 语义更清晰：**true = 该会话实例的日志已重开**（不再依赖"是否全局活跃"，`real-runtime-adapter.ts:372-381` 里的 `activeSession()` 判断可删）。 |
| 409 | **作用域收窄**：仅 `{id}` 在跑才 409。错误串不变（`"turn 进行中，无法压缩"`）。 |
| SSE | 成功广播 `compact`（`turn=0`）——**信封补 `session = {id}`**，前端可只对该会话 reload（现在靠 `p.session` 比对，`chat.ts:270-280`，逻辑不变但更可靠）。 |

### 4.6 `POST /api/sessions/{id}/activate`

| 项 | 内容 |
|---|---|
| 请求 | 不变（会话在 path）。 |
| 响应 | **兼容增字段**：`{ok:true, active_session, runtime:"created"\|"existing", busy:boolean, rebuilt:boolean}`。 |
| 409 | **移除**（本设计的核心变更）。语义：activate 不再修改全局引擎。 |
| 400/404/500 | 不变（`invalid session model` / 未知会话 / `cannot persist active session`）。`compose failed: {e}` 现在只发生在**该会话实例**创建失败时。 |
| 副作用 | **减弱**：不再重写进程环境（Rust 的 `set_var(CELESTEA_SESSION_DIR)` 不再存在），因此 Rust 的"compose 失败但 env 已改且不回滚"（pitfalls P12）在 TS 里**结构性消失**。 |

### 4.7 `GET /api/sessions`

| 项 | 内容 |
|---|---|
| 请求 | **兼容增 query**：`?live=1` 时只返回有活实例的会话（可选）。 |
| 响应 | **兼容增字段**：每行新增 `busy:boolean`（该会话是否有在飞 turn）、`open:boolean`（是否有 runtime 实例）；顶层 `active_session` 语义改为"聚焦偏好"。 |
| worker 行 | `workspace` 由 `"engine"` 改为**实际工作区**（聚合自各会话实例）——**声明为变更**；`kind:"worker"` 保留。 |

### 4.8 `GET /api/status`

| 项 | 内容 |
|---|---|
| 请求 | **兼容增 query**：`?session=<id>`（缺省 = `active_session`）。 |
| 响应 | **兼容增字段**：`live_sessions: string[]`、`busy_sessions: string[]`、`turn_scope: "session"`（能力位，§4.10）。现有 7 个字段（含 `session`）逐字不变。 |
| 语义 | `session` 字段 = 被查询的会话；`steps/tokens_per_sec/usage/context_usage` = **该会话实例**的 tracker。`tokens_per_sec` 是该实例本轮「有流时段」的均值（W754 + W763：> 1s 的间断不计入分母；窗口空了回落到本轮活动区间均值，只有本轮还没流过才是 0），按会话各自独立、`beginTurn()` 时重置。 |

### 4.9 `GET|POST /api/config`

| 项 | 内容 |
|---|---|
| `GET` | 不变（模型/基址/档位/上下文窗口/系统提示词等）。 |
| `POST` | **兼容增字段**：响应增 `epoch:number`、`pending_sessions:string[]`（有在飞轮次、将在下一轮生效的会话）。 |
| 409 | **移除**（不再需要"全局空闲"才能改配置）。若要保守，可加一个运维开关选择 strict 模式（默认关）。 |
| 语义 | 从"立刻全量热插拔"变为"bump epoch + 标记失效 + 各会话下一轮生效"。前端提示文案相应改为"已保存 · 将在会话下一轮生效"。 |

### 4.10 `GET /api/health`

**兼容增字段**（能力探测，供前端同时兼容两版后端）：

```jsonc
{
  "ok": true, "name": "celestea-studio", "model": "…",
  "capabilities": {
    "per_session_runtime": true,   // 支持每会话独立实例
    "sse_session_field": true,     // SSE 信封带 session
    "turn_session_field": true,    // /api/turn 接受 session
    "activate_no_409": true,       // activate 不再因忙碌 409
    "grants": true                 // 见 feature-session-grants.md
  }
}
```

前端**必须**在启动时读一次：无 `capabilities`（= Rust 后端）时退回"单会话模式"（点击会话仍走 activate 并容忍 409、SSE 不路由、取消不带 `session`）。这是 §3.4 里所有"待确认"项的统一解法，也让迁移期不需要人为配置。

### 4.11 错误码汇总

| 码 | 变化 |
|---|---|
| 409 | **作用域收窄**（per-session）+ **activate/config 移除** + **clear 新增**。错误串全部保持逐字 |
| 404 | `POST /api/turn` 新增"未知 session"分支 |
| 400 | 不变（`invalid session model: {e}` 可能从 activate 时机移到 turn 时机出现） |
| 415/422 | 不变（body 解析规则不动） |

---

## 5. 测试与验收（实现阶段）

沿用现有落点，不新造测试框架：

1. `packages/runtime/src/lifecycle.test.ts` 风格：注册表——`ensure` 幂等、两会话并发 turn 各自独立、409 只在同会话、`invalidateAll` 不打断在飞 turn、`evictIdle` 不回收在飞实例。
2. 信封：`apps/studio/src/sse.test.ts` —— 每帧带 `session`；`?session=` 过滤；**后台会话洪流不丢聚焦会话帧**（背压回归测试，本设计的核心风险点）。
3. 契约：`apps/studio/src/app-domains.test.ts` —— `activate` 在别会话忙时返回 200；`turn` 带 `session` 打到正确会话；`clear` 的 409。
4. 前端（手工验收清单，本仓库无前端测试基建）：
   - A 会话发消息 → 立刻点 B 会话 → A 的流**继续**，B 显示自己的历史与滚动位置；
   - 切回 A → 正文/思考/工具卡/折叠态/滚动位置**逐字还原**，且无重复气泡（衔接去重按会话隔离）；
   - A 在跑时再给 A 发消息 → 只 A 报"轮次进行中"；给 B 发消息 → 正常；
   - 两条流同时跑 → 无串台（文字不混进对方视图）；
   - 后台会话完成后侧栏卡片状态回到空闲。

---

## 6. 性能与资源上限（建议默认值）

| 旋钮 | 建议默认 | 说明 |
|---|---|---|
| `CELESTEA_MAX_LIVE_SESSIONS` | **4** | 活实例上限。超限时 LRU 回收**空闲**实例；若全在飞，第 5 个 `ensure` 返回 503 + `Retry-After`（显式优于静默排队） |
| `CELESTEA_MAX_CONCURRENT_TURNS` | **2** | 真正同时在跑的 turn 上限（与活实例数分开）。本机每轮 = 1 条 LLM 流 + 至多 `max_parallel_tool_calls` 个子进程；2 是保守起点 |
| `CELESTEA_SESSION_IDLE_TTL_MS` | **900000**（15 min） | 空闲实例回收 TTL；只回收 `inFlight=false` 的实例 |
| `CELESTEA_SSE_BUS_CAPACITY` | **512**（单会话）→ **2048**（多会话） | 每订阅者总容量，按会话分桶后生效（§2.4） |
| 每桶下限 | **64** 帧 | 保证聚焦会话在极端并发下仍有可用缓冲 |
| SSE 连接数 | **1 / 浏览器 tab** | 不随会话数增长（默认全量广播 + 本地路由） |
| 日志 fd | **每实例 1 个**（`cli-main.jsonl`） | 回收实例必须 `closeLog()`（`real-runtime-adapter.ts:226-228` 已有此纪律，注册表复用） |
| 实例内存 | 每实例 ≈ 一个 `Context` + plugin 图 + `WorkerRegistry` + `ProcessRegistry` | 估算几十 MB 级；因此上限 4 而非不限。`release()`（`runtime.ts:225-235`）必须调用以断开 `Runtime → ctx → ToolRegistry → worker tool → registry` 环，否则实例**不可回收** |

**关键风险（实现时必须验证）**：断环依赖 worker 工具对 registry 的 `WeakRef`（`runtime.ts:15-18`）。按 §2.7 让每会话一个 `WorkerRegistry` 后，必须确认该弱引用链在"注册表 → 实例 → registry"路径下仍然成立；否则改为注册表持有强引用 + 显式 `release()`（更简单可靠，推荐）。

---

## 7. 开放问题

1. §3.4 的 axum 宽容度确认（多余 body 字段 / 未知 query 是否被拒）→ 由 `capabilities` 兜底，但仍建议实测 Rust 侧行为。
2. `turn` 从全局改为每会话，是否破坏任何**外部**消费者（监控/看门狗读 SSE 的 `turn`）？建议先 grep 平台侧消费者；若需要，可加 `turn_global`（纯增字段）。
3. `/api/config` 去 409 后，"改了模型但会话正在跑"的用户体验需要前端明示（状态栏 + 会话卡片角标）。
4. 是否需要"会话模板/克隆"（新会话继承另一个会话的 grants/模型）——不在本设计范围，但 §2.2 的 epoch 机制已为其留好接口。
5. 无人值守场景（headless worker 会话）：`MAX_LIVE_SESSIONS` 的 503 是否会让 worker 派发失败？建议 worker 会话不计入该上限（单独配额）。
