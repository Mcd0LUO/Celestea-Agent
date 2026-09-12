# `@celestea/runtime` (L2 · 装配层)

一句职责：**把插件按显式顺序挂进一个 `Context`，交回一个「已装配、可驱动、可换代」的引擎代（Gen）**。
对应 Rust `crates/runtime/{compose.rs,run.rs}` + `celestea_studio/src/main.rs` 的 statusline / 换代部分。

```
core ← runtime → session / llm / tools / agent-loop / workers
```

依赖方向：**只向下**。runtime 位于 L2，可以依赖全部 L1，但**不 import 任何一个 L1 实现**——
具体 agent loop 走 `ComposeConfig.loopFactory`，事件映射走 `frameMapper`，会话日志走
`sessionBinding`/插件，worker 日志工厂走 `workers.logFactory`。这样 P3 期间可以在
`packages/agent-loop` / `packages/tools` 并行开发的同时用 fake 验证装配层。

## 公开 API（只从 `src/index.ts` 收口）

| 导出 | 作用 |
|---|---|
| `compose(config)` → `Runtime` | 组装一代引擎（见下方顺序） |
| `ComposeConfig` | profile + 插件列表 + loopFactory/frameMapper/usage/status/workers/shutdownHooks/now |
| `Runtime` | 句柄 + 生命周期：`runTurn` / `cancelTurn` / `statusline` / `rebind` / `shutdown` / `release` |
| `GenerationHub` / `Gen` / `createGen` / `migrateReceipts` | 热换代：原子翻转 + 回执迁移 + 旧代拆解 |
| `SessionBinding` / `createSessionBinding` / `bindSession` | 会话绑定与重绑（同一目录重建绑定） |
| `TurnRunner` / `LoopFactory` / `LoopBindings` / `TurnOptions` / `resolveOutcome` | 单轮驱动语义（单并发槽、取消、终态） |
| `StatusTracker` / `createStatusTracker` / `statuslineOf` / `estimatedContextChars` | steps / tokens_per_sec / context usage |
| `UsageTracker` / `createUsageTracker` / `usageStatus` / `cacheHitRatioRounded` | latest / total / cache_hit_ratio |
| `loopEventToFrame` / `TurnFrame` / `loopEventToSse` 等价物 | LoopEvent → SSE 帧（契约映射） |
| `agentConfigFromProfile` / `MIN_STEPS` | profile → `AgentConfig`（步数下限 4096） |
| `sanitizeProfile` / `sanitizeConfigJson` | 面向 `/api/config` 的消毒投影（白名单 + 出口脱敏） |
| `TURN_ABORT_SERVICE` / `TURN_SINK_SERVICE` / `USAGE_TRACKER_SERVICE` / `STATUS_TRACKER_SERVICE` / `HOST_SESSION_ID` | 运行时服务 token 与宿主会话 id |
| `TurnBusyError` / `RuntimeReleasedError` / `ComposeError` | 机器可读错误（409 / 410 / 装配失败） |

## compose 顺序（顺序即语义，测试锁定）

1. 运行时服务：`EVENT_BUS_SERVICE` / `USAGE_TRACKER_SERVICE` / `STATUS_TRACKER_SERVICE`；
2. `sessionBinding`（若给）：打开宿主日志并提供 `SESSION_LOG_SERVICE`；
3. `config.plugins` 按序 mount（**后注册覆盖先注册**，测试可挂 fake 顶掉真实现）；
4. worker 接线：宿主没提供注册表时，**最后**挂默认 workers 插件（三个工具要落进已解析的 `ToolRegistry`）；
5. 解析 seam：`SessionLog`（必需）+ `LlmRegistry`/`ToolRegistry`/`AgentLoop`（可选，缺则 `null`）；
6. 驱动接线：把 Llm/ToolRegistry/AgentLoop 交给 worker 注册表（`spawn_worker` 才会被后台驱动），
   并把宿主会话登记进会话注册表（回执可寻址）；
7. 组装 `TurnRunner`（loopFactory + frameMapper + usage + 回执 drain）。

## 生命周期语义

- **热换代**：`hub.swap(gen)` = ① 同步翻转 `this.gen = next`（读者要么拿到旧代、要么拿到新代，
  永远看不到混合状态）② 把旧代 mailbox 里 pending 的宿主回执迁到新代 ③ 再 shutdown + release 旧代。
- **会话重绑**：`runtime.rebind(binding)` 重新 `binding.open()`（**同一 session id + 同一目录**），
  重新 provide `SESSION_LOG_SERVICE`，并同步 runtime 的 session 句柄；turn 进行中重绑 → `TurnBusyError`。
- **shutdown**：**幂等 + 可重入**。停驱动（abort + join）→ 跑宿主 teardown hooks（杀进程）→
  purge mailbox → clear 会话注册表。重复调用是 no-op，并发调用共享同一个 promise（hook 只跑一次）。
- **release**：显式断开强引用（`parts = null`），配合 workers 工具持 `WeakRef`，
  解开 `Runtime → ctx → ToolRegistry → worker tool → registry` 环，让被换代的代可被回收（W248）。
- **取消**：`runTurn(input, {signal})` 把调用方 signal 链进本轮 signal，注入 loop bindings
  与 turn scope（`TURN_ABORT_SERVICE`）；`cancelTurn()` 取消进行中的轮次。

## runTurn 语义

- **单并发 busy 槽**：进行中再发起 → `TurnBusyError`（409，`kind: "turn_busy"`），不排队。
- **回执注入**：轮次开始前先把宿主 mailbox 的 pending 消息按 FIFO 注入 session log
  （`[from W1] …`），因此 worker 回执在宿主**下一轮真实可见**（W232）。
- **事件流**：loop 的每个 `LoopEvent` → 喂 `StatusTracker`（tool_call 记一步；text/thinking 记字符）
  → 映射成一个 `TurnFrame`（SSE 名 + payload）→ 交给 `sink`。
- **终态**：以 session log 的 `turn_end` 为准（唯一真源）；本轮没写 `turn_end` 时：
  抛错则向上抛（装配失败不是终态）、已取消则 `cancelled`、静默停止则 `interrupted`——
  撕裂的一轮**绝不**报成 `completed`。

## StatusTracker / UsageTracker

- steps：一次 tool **call** 记一步（tool_result 不重复计，W263 口径）；
- tokens_per_sec：text/thinking delta 字符的速率（近似 token 速率，~1:1），**只在本轮有流时段的区间上平均**
  （相邻 delta 间隔 > `GAP_MS` = 1s 视为无流间断，不计入分母；每个区间下限 `MIN_ACTIVE_MS` = 1s）；
  窗口有样本时给响应式的 5s 滑窗速率（W754），窗口空时（停顿 > 5s 或轮次结束）回落到**本轮活动区间均值**（W763，
  `turnRate` / `turnSpanMs` / `pushTurnDelta`，区间按停顿压缩，内存 O(停顿次数) 而非 O(delta 数)）；
  只有本轮还没有任何 delta（TTFT）才是 0，`beginTurn()` 重置；时钟可注入（`now`）；
- context usage：优先真实 usage（`latest().prompt_tokens > 0` → `estimated:false` /
  `usage_prompt_tokens`），否则回退 session log 字符估算（`estimated:true` / `session_event_chars`）；
- usage：`latest` + `total`，`cache_hit_ratio = cache_read / prompt_tokens`（clamp [0,1]、4 位小数、分母 0 时为 0）。

## 接入真实实现（apps/studio 侧）

```ts
const usage = new UsageTracker();                       // 或 agent-loop 的同名 tracker（结构等价）
const runtime = compose({
  profile,
  plugins: [sessionPlugin, llmPlugin, toolsPlugin, agentLoopPlugin, /* … */],
  loopFactory: ({ config, signal, sink, usage }) => new DefaultAgentLoop(config, { signal, sink, usage }),
  frameMapper: loopEventToSse,                          // 可选：用 agent-loop 的映射
  usage,
  workers: { resultsDir: "results" },
  shutdownHooks: [() => processRegistry.killAll()],
});
```

## 测试

`packages/runtime/src/*.test.ts`（61 例，全部用 fake：内存 SessionLog / 脚本化 AgentLoop /
记录型 ToolRegistry / 队列型 Llm）：

- `compose.test.ts`：挂载顺序与覆盖语义、worker 插件最后挂载并注册三工具、缺 session 报错、
  agentConfig 推导、消毒 config 无密钥；
- `turn.test.ts`：事件→帧顺序、终态取自日志、单并发 409、取消传播（含 turn scope token）、
  宿主回执 FIFO 注入；
- `lifecycle.test.ts`：shutdown 幂等/可重入/hook 只跑一次、release 断引用、会话重绑（同目录）、
  换代无混合态（并发读者）、回执迁移、buildAndSwap；
- `status.test.ts`：steps 口径、速率（窗口 + 本轮活动区间均值，注入时钟）、context usage 真实/估算回退、cache_hit_ratio。
