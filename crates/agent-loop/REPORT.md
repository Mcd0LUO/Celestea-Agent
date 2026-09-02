# celestea-agent-loop (W104) — Implementation Report

## 变更

本次迭代实现 `AgentConfig.max_parallel_tool_calls` 的并行工具派发（此前为串行，REPORT 已自述缺口）。

- `crates/agent-loop/src/lib.rs`（唯一改动文件，均落在 crates/agent-loop/ 目录内）：
  - **并行派发**：`StreamEvent::Done` 含多个 `ToolCall` 时，将全部工具调用按
    `max_parallel_tool_calls` 分批，每批用 `futures_util::future::join_all` 并发派发。
  - **契约不变**：先 append 全部 `ToolCall` 事件，再按模型返回顺序 append 各自的
    `ToolResult` 事件；`join_all` 按输入顺序 resolve，结果落盘顺序确定、不随并发完成
    先后乱序。
  - **边界处理**：`max_parallel_tool_calls == 0` 时 clamp 到 1（退化为串行）；
    工具数 > 上限时分批并发，批内并发、批间顺序衔接。
  - **单测**（`#[cfg(test)] mod tests`，共 3 个，全部通过）：
    1. `dispatches_all_tool_calls_with_deterministic_result_order` — 多工具调用全部被
       派发、`ToolCall`/`ToolResult` 顺序均与模型返回一致，且全部 `ToolCall` 先于任何
       `ToolResult`。
    2. `batches_dispatch_concurrently_up_to_limit` — 5 个调用、上限 2：分批并发、并发度
       不超过上限（用记录派发顺序 + 同时在飞计数器的 fake `ToolRegistry` 验证），结果
       顺序确定。
    3. `zero_max_parallel_clamps_to_serial` — 上限 0 clamp 到 1，串行派发且顺序正确。
  - 依赖零变更：复用已 pin 的 async-trait / tokio / futures-util / serde_json /
    celestea-core，未执行 `cargo add/remove`。

## 验证

命令（工具链在 /opt）：
```
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
cd /src/celestea_harness && cargo build -p celestea-agent-loop && cargo test -p celestea-agent-loop
```

结果（本次实测）：
- `cargo build -p celestea-agent-loop`：**PASSED**（exit 0，无警告无错误）。
- `cargo test -p celestea-agent-loop`：**PASSED**，3 passed / 0 failed
  （+ doc-tests 0）。基线为 18/18 全仓通过；本次只改本 crate，未触碰 crates/core 与其它
  crate 代码。
- 负载核查：构建时 1 分钟 load 约 0.25~0.43，远低于 >20 阈值，且只 build 本 crate，与
  W176 错峰。

## 回滚

变更集中在 `crates/agent-loop/`（含本 REPORT.md），回滚命令：

```
git -C /src/celestea_harness checkout -- crates/agent-loop/
```

即可恢复本轮全部改动。未做任何 git 写操作（commit/add 等），未改 root Cargo.toml /
ARCHITECTURE.md / crates/core / 其它 crate。

## 遗留

- 并行派发按批串行衔接（批内并发、批间等待）：`max_parallel_tool_calls` 很小而调用很多时，
  尾部批次的完成会受最慢调用拖累，尚未做跨批滑动窗口调度。当前语义满足契约，后续可按需优化。
- 工具调用结果的错误（`ToolOutput.error`）会原样落盘，并行下错误顺序仍按模型返回顺序确定；
  尚无跨调用结果合并/聚合逻辑。
- 并发度上限目前仅由本 crate 的 `AgentConfig.max_parallel_tool_calls` 控制，未接全局
  资源配额/信号量；多 agent 并发时若需全局约束，建议在调度层另做。




## W191: 协作式取消 + Thinking 消费

### 变更
- `DefaultAgentLoop` 增加可注入协作式取消信号 `cancel: Option<tokio::sync::watch::Receiver<bool>>`：
  - 现有 `DefaultAgentLoop::new(config)` 保持无信号（back-compat，行为不变）。
  - 新增构造点 `DefaultAgentLoop::with_cancel(config, watch::Receiver<bool>)`——watch 值为 true 时，
    run_turn 在下一 await 检查点（tokio::select!）停止并优雅收尾（追加 TurnEnd 后返回 Ok）。
    AgentLoop trait 与 run_turn 签名零改动，向后兼容。
- run_turn 三处 `tokio::select!` 检查取消：① 步骤起点（cancel_set 同步检查）；② generate 请求与
  流消费逐事件（select! 与 wait_cancel 竞速）；③ 工具派发 join_all 批次（select!）。
  取消语义：中途取消不落不完整的 AssistantMessage；ToolCall 已追加的结果保持协议有序，
  TurnEnd 总是追加，返回 Ok（优雅）。wait_cancel 对已置位/后续置位都即时返回，可多检查点复用。
- 消费 `StreamEvent::Thinking`：以纯文本可辨识形态输出（`[thinking] ` 前缀 + flush），
  富渲染留给 P1（未引 crossterm）。
- cli 暂不接 ctrl_c（P1 接），with_cancel 已暴露干净构造点供组合层接线。

### 验证
- cargo test -p celestea-agent-loop: 8 passed（+5：consumes_thinking_stream_events /
  cancelled_before_turn_returns_gracefully / cancelled_during_stream_returns_gracefully /
  no_cancel_signal_preserves_backward_compat / cancel_set_reflects_watch_value）。
- 全仓 build/test: 通过。

### 回滚
- git -C /src/celestea_harness checkout -- crates/agent-loop/

### 遗留
- 取消在工具派发批次中途生效时，已入队的剩余调用会随批次丢弃（未执行），日志保持有序一致；
  若需“已启动调用必须跑完”可后续改为 per-call select 或 canceller 语义。
- cli ctrl_c 接线留待 P1；当前暴露 with_cancel 构造点。


## W194: 输出 sink 解耦（富渲染前置）

### 变更
- 新增 `LoopEvent`（Text/Thinking/Done/ToolCall/ToolResult）与 `EventSink =
  Arc<dyn Fn(LoopEvent) + Send + Sync>`：core 冻结（P1 禁改 core），故在 agent-loop
  定义自己的事件视图，含工具生命周期（ToolCall + 完整 ToolOutput），富 UI 无需再刮
  session 日志即可画工具卡片。
- `DefaultAgentLoop` 新增 `sink: Option<EventSink>` 字段 + 两个新构造点：
  `with_sink(config, sink)`、`with_cancel_sink(config, cancel, sink)`；
  `new` / `with_cancel` 保持原语义（sink = None），向后兼容。
- run_turn 的流消费改为 `self.emit(LoopEvent::…)`：sink 存在则回调（不再直接 print），
  sink = None 时走 `print_legacy`（Text/Thinking 原样写 stdout + flush，与改造前逐字节
  一致）。工具事件（ToolCall/ToolResult）也经 sink 分发；ToolResult 携带 render/decision
  供状态卡片。
- AgentLoop trait 与 run_turn 签名零改动。

### 验证
- cargo test -p celestea-agent-loop：12 passed / 0 failed（新增 4：
  sink_receives_stream_events_in_order / sink_receives_tool_lifecycle_in_order /
  sink_none_preserves_legacy_print_formatting / sink_combined_with_cancel_cancels_gracefully）。
- 全仓 build/test：通过。

### 回滚
- git -C /src/celestea_harness checkout -- crates/agent-loop/

### 遗留
- sink 回调为同步 Fn（在 tokio 执行体内直接调用），未做背压/异步 sink；当前量级无碍。
- 富渲染（markdown/syntect/工具卡片）落在 cli 侧（W194 P1），agent-loop 只负责分发事件。
