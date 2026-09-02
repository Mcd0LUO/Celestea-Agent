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

