# celestea-core · M5a EventBus 调度语义（bail / waterfall）

## 变更
- crates/core/src/lib.rs EventBus 新增两种调度模式，on/emit 观察型广播原样保留（向后兼容）：
  - bail / run_bail：按注册顺序执行拦截链，第一个返回 Some(R) 的 listener 短路并返回；全 None 返回 None。
  - waterfall / run_waterfall：按注册顺序执行变换链，每层 Fn(&E, R) -> R 将当前值传给下一层，返回最终值。
- 类型安全：泛型 R（Any + Send + 'static）；三种模式独立存储（subs / bailers / waterfalls 三个 TypeId-keyed map），互不污染。
- 内部实现：bailer 类型擦除为 Fn(&dyn Any) -> Option<Box<dyn Any + Send>>，waterfall 为
  Fn(&dyn Any, Box<dyn Any + Send>) -> Box<dyn Any + Send>，在 run_* 入口按 R 反擦除。
- 同步实现（core 目前为同步 crate）。parallel/serial 为异步 fan-out 语义，暂未加（见遗留）。
- 新增 5 个单测；更新了 crate 级与 EventBus 文档注释。

## 验证
- cargo build -p celestea-core：通过。
- cargo test -p celestea-core：11 passed（含 5 个新 EventBus 用例）：
  event_bus_bail_short_circuits_in_order / event_bus_bail_all_none_returns_none /
  event_bus_waterfall_transforms_in_order / event_bus_modes_coexist_without_interference /
  event_bus_modes_are_send_sync。
- 文件属主：celestea:celesdev。

## 回滚
- 变更集中在 crates/core/：
  git -C /src/celestea_harness checkout -- crates/core/ 即恢复。

## 遗留
- parallel（并行执行全部 listener）与 serial（异步串行）未实现：core 当前是同步 EventBus，
  parallel/serial 属于异步 fan-out 语义，等 core 引入 async event bus 时一并加。
- run_bail 中若同一事件类型注册了不同 R 的 bailer，类型不匹配的返回按“无应答”继续扫描
  （调用方应保证单事件单 R）。
- run_waterfall 在类型不匹配时透传当前值（防御性），最终按 R 反擦除。


## M5b guard chain monotonic

### Change
- ToolOutput gains pub decision Option ToolDecision (after value, error).
- Some Allow: guard chain passed (execution path) incl success and permitted-but-failed
- Some Deny(s) / Some Ask(q): first non-Allow guard short-circuits
- None: reserved; current dispatch always yields Some
- Rationale: Deny/Ask first-class facts; error string kept for back-compat

### Verify
- cargo build -p celestea-core: OK
- cargo test -p celestea-core: 11 passed (additive field)

### Rollback
- git checkout crates/core (falls back to HEAD)

### Leftover
- agent-loop ToolResult consumes value/error only; decision not yet surfaced

## W189 seam: ToolOutput.render + LlmRegistry (multi-provider)

### Change
- ToolOutput gains pub render: Option<String> (render = human-readable
  presentation, decoupled from the canonical value). None when the value is
  already the human-readable form (read_file's plain text); Some(_) when a
  condensed view is better (run_shell's stdout+stderr summary).
- New pub struct LlmRegistry (NamedRegistry style): register(name, Arc<dyn Llm>) /
  resolve(name) / list(). A later registration of a name shadows the earlier one
  (patch semantics); list() reports distinct names in first-registration order.
- New pub struct LlmRegistryService(Arc<LlmRegistry>) newtype so the registry can
  live in the Context TypeId map, alongside the existing LlmService (back-compat).

### Verify
- cargo build -p celestea-core: OK
- cargo test -p celestea-core: passed (additive fields; new ToolOutput.render +
  LlmRegistry tests)

### Rollback
- git checkout crates/core (falls back to HEAD)

### Leftover
- agent-loop still resolves the single-adapter LlmService; LlmRegistryService is
  the extension seam for name-routed multi-provider consumers.
