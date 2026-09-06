# Celestea-Agent 引擎后端优化评估报告（只读评估）

> 仓库：/src/celestea_harness（Rust workspace，7 crate）@ HEAD 5a19083
> （feat(engine): context reliability + v2 sandbox + memory-leak fixes）
> 评估方式：只读静态分析（read/grep/sed 片段，未跑 cargo，未跑压测，未改任何源码）。
> 产物：本文件（docs/ 为本次新建目录）。评估后 git status：仅新增 docs/，无其它改动。
> 行号基准：一律以 HEAD 5a19083 为准；涉及正在进行的 W232 的部分单独标注（见 §0.4）。
> 证据引用格式：`文件:行号`；「实码行数」= 总行数 − 测试行数（按 #[cfg(test)] 起止估算）。

---

## 0. 结论先行（Top 风险与建议，按优先级排序）

**P0（应立即处理）**

1. **会话日志读路径全量深拷贝**：`events()` 每次调用 `Vec<SessionEvent>` 整体 clone
   （`crates/session/src/persistent.rs:219-221`、`crates/session/src/log.rs:41-43`），而每 turn
   历史获取（`crates/agent-loop/src/loop.rs:233` derive_messages）、trim 前估算、摘要
   （`crates/runtime/src/run.rs:93-95`）各读一次 → 每 turn 2-3 次全历史字符串深拷贝。
   万级事件会话下每 turn 数 MB 级拷贝，是长会话场景最确定的主路径开销。
   **建议**：`Arc<[SessionEvent]>` 快照式 events()，或提供 read-lock 内投影
   `derive_messages_locked`；以 (len, 序号/rev) 做消息投影缓存失效。

2. **持久化 append 在 events 写锁内做磁盘写 + 默认 flush**：`PersistentOptions.flush_each_append`
   默认为 true（`crates/session/src/persistent.rs:40-57`），append 持写锁跨
   serde 序列化 + `write_all` + `flush()`（`:186-224`）→ 磁盘抖动时读事件/读历史全部被阻塞；
   多 worker 会话共写宿主进程日志时锁竞争放大。
   **建议**：锁内仅入内存队列，落盘交单写者任务异步追赶（保序），或至少把
   flush 移出锁外（先 clone 行、放锁、再写盘）。sync_each_append 保持 opt-in 且显式告警。

3. **SessionMailbox 无界 + HEAD 上 worker 会话无消费方**：队列懒创建、无上限、投递无消费者
   时消息永驻（`crates/session/src/mailbox.rs:44-47,55`）；HEAD 上仅宿主 `cli-main` 在每 turn
   开头 drain（`crates/runtime/src/run.rs:67-77`），worker 会话（spawn_worker 建的内部会话）
   在 HEAD 没有任何 recv 循环 → 消息积压直到看门狗释放会话时 `remove+purge`
   （`crates/workers/src/watchdog.rs:225-226`）。这正是 W232 修复中的闭环缺口
   （见 §0.4：W232 工作树已在 workers/registry.rs 加 recv 循环）。**建议**：与 W232 合并后补
   有界队列 + 消费者落后告警指标；评估文档按 HEAD 描述现状。

4. **sandbox.rs 单文件 ~1480 行实码**（2004 总行）：providers 检测 / bwrap / raw namespace /
   seccomp / config / error / exec / git 八段共居一文件，改动面与编译单元粒度失衡。
   **建议**：P0 机械拆分（蓝图见 §1.1），不改任何 pub 面。

**P1（近期处理）**

5. **EventBus 无 unsubscribe 且目前零生产接线**：on/bail/waterfall 均只 push
   （`crates/core/src/event_bus.rs:33-103`），监听器永久驻留；`run_waterfall` 末尾 expect
   可 panic（`:120`）。全仓 grep 显示 EventBus 除 `crates/core/src/lib.rs:26` 导出外**没有任何
   实例化/挂载点**——属「休眠 seam」。**建议**：要么补 unsubscribe + 异步监听支持并真正接线，
   要么在架构文档中明确冻结该组件，避免半成品语义被误用。

6. **SessionLog 事件无界驻留 + 重启整读**：内存事件向量只增不清（`persistent.rs:98`、
   `log.rs:21`），trim 只管「模型可见历史」（`agent-loop/src/context.rs:90-160`）不管日志本体；
   磁盘日志重开时 `replay()` 全文件载入（`persistent.rs:311`）→ 冷启动成本与日志大小线性。
   **建议**：明确日志保留策略（容量/条数上限 + 归档），replay 改流式。

7. **Context 服务不可移除、不可枚举、静默替换**：`provide` 直接覆盖（`core/src/context.rs:21-23`），
   服务 Arc 常驻直至 Context 析构；装配顺序错误只能在运行时以 None 暴露
   （`agent-loop/src/loop.rs:196-197`）。**建议**：装配期校验（构建完成时断言必需服务齐备），
   保留 TypeId 容器作为插件模型核心（不动）。

8. **每 turn 重建 AgentLoop + 每 turn 全历史 token 估算**：`run_turn` 每轮 `make_loop` 建新
   `Arc<dyn AgentLoop>`（`crates/runtime/src/run.rs:36-47`，设计使然、可接受）；但 trim 判定
   `estimate_messages_tokens(&messages)` 每 turn 全历史字节扫描（`loop.rs:233` →
   `agent-loop/src/context.rs:101-104`）与 #1 的克隆叠加。**建议**：消息投影缓存化后附带
   token 估算缓存（增量维护）。

**P2（可延后）**

9. **工具面双挂载重复**：workers 三工具的注册逻辑存在两份——`WorkersPlugin::mount`
   （`workers/src/plugin.rs:65-72`）与 runtime `register_all_tools`
   （`runtime/src/tools.rs:19` + `compose.rs:118`），改工具面需同步两处。**建议**：收口到
   单一 `compose_worker_tools()`。

10. **SSE 逐 token 分配**：每 delta 一次 serde 解析出 `RawChunk`（`llm/src/client.rs:356-412`），
    文本/String 累积（`:242-321`）。每 token 1-3 次小分配，量级小，低优先。

11. **NamedRegistry 为 Vec + 逆序线性查找**（`core/src/registry.rs:1-22`）：insert 只增不删、
    get O(n)。当前规模小，仅提示不做改动。

---

### 0.1 与 W232 的边界（重要）

评估期间 W232 正在本仓库工作树改 worker 通讯闭环，未提交增量（评估结束时最终观测，
git status/diff 实测）：`Cargo.lock`、`crates/runtime/src/{compose,run}.rs`、
`crates/workers/Cargo.toml`、`crates/workers/src/{lib,registry,tools,types,watchdog}.rs`
共 9 文件修改 + 未跟踪新增 `crates/workers/src/bridge.rs`（W232 所有，本评估未触碰）。
本报告所有行号以 HEAD 5a19083 为准；两处与 W232 直接相关：
- §0-P0-3（mailbox 无消费方）在 W232 工作树中已开始修复（registry.rs 出现 recv 循环）；
- §1.7 watchdog.rs 拆分建议**等 W232 合并后再动**，避免同文件冲突。

---

## 1. 长代码文件清单与拆分细化方案

全仓 `.rs` 共 12283 行（wc -l 实测），>400 行文件 8 个（另 loop.rs 394 贴线）。`#[test]`/
`#[tokio::test]` 计数 245（与任务基线 247 基本一致，差异来自属性与用例绑定方式）。

| # | 文件 | 总行 | 实码 | 测试 | 优先级 | 拆法 |
|---|---|---|---|---|---|---|
| 1 | crates/tools/src/sandbox.rs | 2004 | ~1480 | ~520 | P0 | 机械搬移（6 子模块） |
| 2 | crates/llm/src/client.rs | 1291 | ~580 | ~710 | P0 | 机械（3 文件） |
| 3 | crates/runtime/src/config.rs | 981 | ~450 | ~530 | P1 | 机械（2 文件） |
| 4 | crates/agent-loop/src/lib.rs | 817 | **24** | ~793 | P2 | 非拆分对象，测试外移 |
| 5 | crates/workers/src/watchdog.rs | 690 | ~450 | ~240 | P1* | 机械（4 文件）；*等 W232 合并 |
| 6 | crates/session/src/persistent.rs | 681 | ~365 | ~315 | P1 | 机械（3 文件） |
| 7 | crates/session/src/registry.rs | 537 | ~190 | ~350 | P2 | 非拆分对象，测试外移 |
| 8 | crates/workers/src/lib.rs | 517 | ~38 | ~478 | P2 | 非拆分对象，测试外移 |
| 9 | crates/agent-loop/src/loop.rs | 394 | ~390 | 少量 | P2 | 机械（usage/cancel 抽出） |

> 关键结论：4、7、8 三个「长文件」实码只有 24-190 行，是**测试巨婴**而非实现巨婴——拆分
> 动作应是「测试外移」而不是「代码切分」，与任务直觉相反。

### 1.1 sandbox.rs（P0）拆分蓝图

现有逻辑段（行号实测）：

| 段落 | 行号 | 职责 |
|---|---|---|
| 配置旋钮 env+in-code | 72-101 | SandboxConfig 常量/环境开关 |
| v2 扩展点/能力 | 102-167 | 文档注释 + v2 能力探测入口 |
| provider 检测 | 168-300 | env_flag / detect_bwrap / bwrap_runs / raw_namespaces_supported / detect_provider |
| bwrap provider | 588-662 | bubblewrap 命令构造（含 open_seccomp_fd 663-678） |
| raw namespace provider | 679-831 | raw_root_dir / raw_child_path / raw_setup / write_map（libc 裸 fd） |
| seccomp | 832-962 | seccomp_v2（x86_64-linux 与回退两版 cfg 实现，837/950） |
| config 结构 | 963-1074 | SandboxConfig + env_u64 |
| errors | 1075-1158 | SandboxError + Display |
| 文本 helpers | 1159-1191 | quoted / preview / command_preview |
| execution | 1192-1524 | execute_sandboxed（1217）+ resolve_workdir（1366）+ read_capped（1429）+ kill_process（1455）+ sanitized_env（1467）+ shell_command（1491/1498 双 cfg） |
| git helpers | 1525-1545 | find_git_toplevel / git_toplevel_or |
| 测试 | 943（内联）+1547-2004 | ~520 行 |

拆分蓝图（crates/tools/src/sandbox/ 目录）：

| 子模块 | 吸收行号 | 职责 | 预计行数 |
|---|---|---|---|
| sandbox/config.rs | 963-1074 + 72-101 | 配置/环境旋钮 | ~130 |
| sandbox/error.rs | 1075-1191 | 错误类型 + 文本 helpers | ~130 |
| sandbox/providers.rs | 168-300 + 588-662 + 663-678 | provider 检测 + bwrap 构造 | ~300 |
| sandbox/raw.rs | 679-831 | raw namespace（libc） | ~150 |
| sandbox/seccomp.rs | 832-962 | seccomp_v2 双 cfg | ~130 |
| sandbox/exec.rs | 1192-1524 | execute_sandboxed + 泵/回收/env/shell | ~330 |
| sandbox/git.rs | 1525-1545 | git 探测 | ~20 |

- **拆法判定：机械搬移**。全部 helper 均为文件私有 fn，唯一 pub(crate) 出口是
  `execute_sandboxed`（sandbox.rs:1217）——各子模块 `use super::*` 即可，无需接口改造。
- **风险**：(a) seccomp 两个 cfg 变体（837/950）必须随 cfg 属性整体移动，错位即编译期错误
  （可接受）；(b) 内联测试 943 行附近的 fn 需确认归属；(c) 测试 1547-2004 建议移
  `crates/tools/tests/sandbox.rs`（若依赖 crate 私有项则留子模块 `#[cfg(test)]`）。
- **不改行为**：无逻辑重排，仅文件组织变化，可逐段提交以二分回滚。

### 1.2 llm/client.rs（P0）拆分蓝图

实码 ~580 行（测试 581-1291，~710 行）：

| 子模块 | 吸收行号 | 职责 | 预计行数 |
|---|---|---|---|
| client.rs（保留） | 49-200 | DeepSeekLlm + 构造/from_env/validate + Llm::generate | ~150 |
| stream.rs | 201-492 | raw_chunk_stream（201-240）、stream_events（242-321）、Raw*/ToolCallAcc 结构（322-355,493-499）、parse_raw_chunk（356-412）、thinking_event（413-434）、extract_reasoning/usage（435-492） | ~290 |
| mapping.rs | 500-580 | map_message / map_tool / collect_text / parse_arguments | ~80 |

机械搬移；stream.rs 内部互引（stream_events↔parse_raw_chunk↔Raw*）保持同模块即无接口变化。
测试 ~710 行外移 `crates/llm/tests/`（当前测试直接构造私有流函数，若不可外移则保留内嵌）。

### 1.3 runtime/config.rs（P1）拆分蓝图

实码 ~450 行（测试 452-981）：

| 子模块 | 吸收行号 | 职责 | 预计行数 |
|---|---|---|---|
| config/profile.rs | 15-247 | Profile 结构 + Default + merge_profile(_strict/_mode) | ~230 |
| config/load.rs | 248-451 | json_kind / toml_to_json / load_profile_file / load_profile / home_config_dir / resolve_profile / resolve_base_url / validate_model / dotenv / resolve_api_key | ~200 |

机械搬移；merge_profile 系列同族函数必须同模块。

### 1.4 watchdog.rs（P1，等 W232 合并）拆分蓝图

实码 ~450 行（测试 450-690）：

| 子模块 | 吸收行号 | 职责 | 预计行数 |
|---|---|---|---|
| watchdog/judge.rs | 27-171 | parse_utc / session_alive / has_deliverable / in_grace | ~145 |
| watchdog/mod.rs（保留） | 173-383 | Watchdog 结构 + tick/重派/释放 | ~210 |
| watchdog/config.rs | 63-91 + 428-449 | WatchdogConfig + Default | ~65 |
| watchdog/entry.rs | 384-427 | WorkerEntry 扩展 impl + mutate_extra | ~45 |

机械搬移；**与 W232 同文件并发改动，必须排在其合并之后**。

### 1.5 persistent.rs（P1）拆分蓝图

实码 ~365 行（测试 366-681）：

| 子模块 | 吸收行号 | 职责 | 预计行数 |
|---|---|---|---|
| persistent/options.rs | 40-95 | PersistentOptions + PersistError | ~55 |
| persistent/log.rs | 97-268 | PersistentSessionLog + SessionLog impl + Drop | ~170 |
| persistent/files.rs | 270-365 | file_name_for / file_path / file_lacks_final_newline / replay / trim_line_end | ~95 |

机械搬移；Drop（254-268）与 append/clear 锁序注释必须整体保留在 log.rs。

### 1.6 测试外移（P2，三个「测试巨婴」）

- `agent-loop/src/lib.rs`：实码仅 24 行 re-export（1-24），793 行测试 → 按被测对象拆到
  `crates/agent-loop/tests/`（或 loop/context 各自的 `#[cfg(test)]` 子模块）。
- `workers/src/lib.rs`：实码 ~38 行，478 行测试 → 同上。
- `session/src/registry.rs`：实码 ~190 行，~350 行测试 → 外移 `crates/session/tests/`。
- 通用风险：测试内建了 FakeLlm/EmptyRegistry 等 mock，外移时抽 `tests/common/mod.rs`。

---

## 2. 解耦分析

### 2.1 依赖图（Cargo.toml 实测，无环）

```
core        （无内部依赖；叶子，无 tokio 依赖 —— 分层良好）
llm        → core
session    → core
tools      → core（+ libc, cfg(unix)）
agent-loop → core
workers    → core + session + tools + agent-loop   （编排聚合层）
runtime    → 以上全部 6 crate                        （装配根/组合根）
```

- 方向判定：单向无环，core 为叶枢纽，runtime 为组合根——**分层本身健康**。
- workers 是唯一「聚合 4 crate」的中层：它既是会话/队列的持有者又是工具编排者，
  与 runtime 职责部分重叠（见 §2.3-e）。

### 2.2 耦合热点

a) **Context TypeId 服务容器**（core/src/context.rs:9-36）：全部跨 crate 接线都是隐式的
   `provide<T>/get<T>`。装配顺序敏感（runtime compose.rs:150-158 必须在 attach_drivers 前
   provide 三 seam；plugin.rs:65-72 靠「后 provide 替换先 provide」的 patch 语义挂工具面）。
   错误只在运行时暴露为 None（loop.rs:196-197 → AgentError）。

b) **Arc 服务共享面**：LlmService/ToolRegistryService/SessionService/AgentLoopService/
   WorkerRegistryService 五个 newtype 把 Arc 塞进 Context 共享。workers.attach_drivers
   （workers/src/registry.rs:82-97）保存宿主三 seam 的 Arc 副本——经查**无 Arc 所有权环**
   （workers 不持有 Context 反向引用；每次驱动建全新 Context，registry.rs:203-207）。

c) **Plugin/EventBus seam**：Plugin 仅 mount(&mut Context)（core/src/plugin.rs:7-11），无
   unmount/优先级/依赖；EventBus 三模式全无 unsubscribe（event_bus.rs:33-103）且当前零接线
   （见 §0-P1-5）。

d) **workers↔session↔runtime 三角**：runtime 建 registry 并注册工具（compose.rs:115-118），
   workers 内部持有 SessionRegistry+SessionMailbox（workers/src/registry.rs:20-21），
   runtime/run.rs 直接伸进 workers 的 mailbox 为宿主 drain（run.rs:67-77），watchdog 又对
   session registry 做释放（watchdog.rs:225-226）。三角每边都是具体类型直达（非 trait），
   换实现（如 DSH 会话桥）需动多处。

e) **工具面双挂载**：WorkersPlugin::mount（plugin.rs:65-72）与 runtime register_all_tools
   （runtime/tools.rs:19）各自组合 builtin+workers 工具面——同一职责两处实现。

### 2.3 解耦建议（方向/接口/代价）

| # | 建议 | 方向 | 代价 |
|---|---|---|---|
| 1 | 装配校验：Runtime 构建末尾断言必需服务齐备（一次性 get 全检，启动即败） | core 加 `Context::contains<T>` 或 runtime 自查 | 极小 |
| 2 | 会话日志读接口去拷贝（§0-P0-1）：投影缓存化 | session crate 内 | 小；行为不变 |
| 3 | mailbox 消费策略收口：宿主 drain（run.rs:67）与未来 worker 消费共用「投递→turn 注入」单函数 | workers 或 agent-loop 提供 helper，run.rs 调用 | 小；W232 正在此区域，需协调 |
| 4 | 工具面单挂载：`compose_worker_tools()` 单点 | workers 导出、runtime/plugin 复用 | 小 |
| 5 | 桥接外部会话（DSH）时走 trait（SessionTransport），避免 registry 直连再扩 | workers 内新 trait | 中；等需求落地 |
| 6 | EventBus 补 unsubscribe（Weak 监听）或冻结声明 | core | 小-中 |

### 2.4 必要 seam（不应动）

- **Context 容器**：插件模型（一切皆插件，core/plugin.rs）的核心机制，换成编译期 DI 会推翻
  插件挂载语义。只做校验增强。
- **Llm trait（core/src/llm.rs）**：provider 抽象 + 流式接口是引擎边界，维持。
- **SessionLog 单一事实源**（「模型历史永远从日志派生」，log.rs:17-22 + derive_messages_from
  共享投影 W210）：维持，只改实现复杂度。
- **ToolRegistry/ToolGuard 链**：Deny/Ask 一等判定（core/src/tool.rs:39-46）是安全面，维持。
- **AgentLoop per-turn 隔离 + 协作取消**（loop.rs:168-186 watch 通道）：维持。

---

## 3. 已有架构评述（seam 体系逐项，证据行号）

| seam | 强项（行号） | 隐患（行号） |
|---|---|---|
| Context | 极小实现、patch 语义（context.rs:21-23）、父链 scoped（34-36） | 服务不可移除/枚举；缺服务运行时才失败（loop.rs:196-197）；静默替换无告警 |
| Plugin | 统一 mount 面，一切皆插件（plugin.rs:7-11） | 无 unmount/顺序/依赖声明；热重载不可干净实现 |
| EventBus | 三模式类型化互不干扰（event_bus.rs:19-21, 224-227 测试佐证）、注册序保证 | 无 unsubscribe（33-103 只 push）；bail/waterfall 每次调用 Box<dyn Any> 装箱分配（57-59, 91-101）；run_waterfall expect panic（120）；**零生产接线**（全仓仅 core/lib.rs:26 导出） |
| NamedRegistry | 命名+替换 patch 原语（core/registry.rs:1-6） | Vec 逆序线性查找 O(n)、只增不删（:9-22） |
| Llm trait | 统一流式抽象，Usage 一等字段（core/llm.rs; llm/client.rs:461-492） | Box<dyn LlmStream> 擦除类型；LlmError 字符串化，结构化错误弱 |
| SessionLog | 单一事实源；内存/磁盘双实现共享投影（log.rs:60+; persistent.rs:181-225） | events() 全量深拷贝（persistent.rs:219-221、log.rs:41-43）；append 写锁跨磁盘 I/O（persistent.rs:186-224）；无界增长 |
| Tool/ToolGuard/ToolRegistry | ToolOutput 的 value/render 分离（W189，tool.rs:21-36）+ Deny/Ask 判定一等化（39-46） | 每次 dispatch 经 Box<dyn Tool> 虚调用 + 串行 guard 链；无批量/并行 guard |
| AgentLoop | per-turn 隔离、协作取消（loop.rs:168-186）、EventSink 流式（run.rs:6-8） | 单文件 394 行内聚 run_turn；每 turn 全历史克隆+估算（233-244） |
| Runtime facade | 组合根清晰（compose.rs:100-158）；每 turn 重建 loop 换取 cancel/sink 灵活性（run.rs:36-47） | 工具面与 WorkersPlugin 重复接线（plugin.rs:65-72 vs runtime/tools.rs:19）；每 turn Arc<dyn AgentLoop> 重建（设计使然） |

---

## 4. 性能瓶颈分析（静态+推理，未压测）

### Top N 排序与预期量级

| # | 瓶颈 | 证据 | 触发频率 | 预期量级 |
|---|---|---|---|---|
| 1 | 会话历史全量克隆 | loop.rs:233 → persistent.rs:219-221 / log.rs:41-43；run.rs:93-95 再次克隆 | 每 turn 2-3 次 | 万事件×~100B ≈ 1MB+/次深拷贝；长会话主导成本 |
| 2 | append 写锁内 flush（默认开） | persistent.rs:40-57 默认 true；186-224 锁内 write_all+flush | 每事件 | 0.1-5ms/事件且锁内放大；多会话共写时串行化 |
| 3 | sandbox 工具调用固定成本 | spawn 1286-1304、双泵 join! 1336-1337、超时 kill+5s grace 1319-1332；启动探测 bwrap_runs 同步 spawn+wait 334-341 | 每 tool 调用/启动一次 | 每调用 2-20ms（进程级）；启动一次 ~ms |
| 4 | mailbox 全局写锁粒度 | mailbox.rs:93/117/124/133 全 map 写锁 | 每消息 | μs 级/条，洪泛时锁排队 |
| 5 | trim 判定每 turn 全历史 token 扫描 | loop.rs:233-244 + context.rs:101-104（bytes/4 估算 22 行） | 每 turn | 万消息 ~1MB 扫描 ≈ 0.1-1ms/turn，可缓存 |
| 6 | SSE 逐 token 分配 | client.rs:356-412 解析 + 242-321 累积 | 每 token | 1-3 次小分配/token，亚 μs 级，累计可观 |
| 7 | 重启 replay 整读 | persistent.rs:311 | 会话冷启动 | 与日志大小线性 |

补充（Studio 侧）：broadcast 512 槽属宿主 Web 侧，不在本仓库范围内，仅提示引擎侧 EventSink
为同步回调（emit 链阻塞 producer），慢 sink 会反向拖慢 turn。

---

## 5. 内存泄漏风险复查

### 5.1 W224 修复点复核（是否仍闭合）

| 修复点 | 现状（HEAD） | 判定 |
|---|---|---|
| JoinSet 后台驱动任务收割 | drive_if_possible 前置 prune_completed（registry.rs:187-188）；prune_completed/abort_all 齐备（233-244）；stress 测试存在（workers/lib.rs:434-516） | **闭合**（残余：若永不 spawn，最后一次任务留槽到 shutdown；有 abort_all 兜底） |
| session 释放 remove+purge | watchdog 释放路径成对调用（watchdog.rs:225-226）；mailbox.purge 存在（mailbox.rs:132-135） | **闭合**（前提：看门狗运行中；watchdog 停摆则会话/队列残留） |
| WatchdogPlugin mount 幂等 | started AtomicBool + spawned_loops 计数（plugin.rs:92-96, 151-153）；测试覆盖（plugin.rs:192-222） | **闭合** |

### 5.2 未覆盖面风险等级表

| 风险点 | 位置 | 机制 | 触发条件 | 等级 |
|---|---|---|---|---|
| mailbox 无界积压（worker 会话无消费方） | mailbox.rs:44-47,55；run.rs:67 仅宿主 drain | VecDeque 无上限 + 无消费者 | worker 被投递消息且长期不被释放 | **高**（W232 修复中） |
| SessionLog 内存事件无界 | persistent.rs:98 / log.rs:21 | 事件全量驻留（trim 只剪模型历史） | 长会话/高频 tool | 中（设计使然，需保留策略） |
| 磁盘日志增长 + replay 整读 | persistent.rs:311 | 冷启动全文件载入 | 重启/超长会话 | 中 |
| EventBus 监听器不可退订 | event_bus.rs:33-103 | push-only；闭包捕获 Arc 可成环 | 重复 mount/热重载（当前未接线） | 中（理论） |
| Context 服务常驻 | context.rs:21-23 | Arc 常驻至 Context 析构 | per-session 挂大对象 | 低-中 |
| SSE 流取消路径 | client.rs:201-240；loop 取消 loop.rs:168-186 | drop 链断连、per-turn 流无 JoinSet | 取消风暴 | 低（未发现泄漏点，需压测确认） |
| UsageTracker/内部 Mutex | loop.rs:60-93 | 计数累加不释放 | 无 | 低 |
| NamedRegistry 只增不删 | core/registry.rs:9-22 | push-only | 热重载场景 | 低（当前无热重载） |

---

## 6. 压力测试方案设计（只设计，不执行）

前置：release 构建；观测用 tokio-console / tracing span / `tokio::runtime::Handle::metrics()`；
RSS 用 /proc/self/status（VmRSS/RssAnon）；孤儿进程用 `pgrep -P` 树核查。

| # | 场景 | 驱动方式 | 观测指标 | 判定阈值 | 验收 |
|---|---|---|---|---|---|
| 1 | 并发多 turn | cargo test --release 集成：16 并发 task × 共享 Runtime（或独立 Runtime 对照），FakeLlm 恒定 10ms 延迟 | turn p50/p95；append 锁等待（span）；alive task 数 | p95 < 2s；锁等待 < turn 时长 10%；task 数回落 | 全绿无 panic |
| 2 | 长上下文到 trim | 程序化注入 5k/50k 事件后跑 turn；记录 TrimOutcome | trim 耗时、removed_tokens、RSS 曲线 | 单次 trim < 50ms；RSS 增长 < 事件字节×3 | 修剪后对话协议完整（safe_cut 不拆 tool 组） |
| 3 | 高频 tool 调用 | 每 turn 20-50 次真实 sandbox 调用（bwrap） | spawn 耗时分布；进程泄漏（每 10 轮 pgrep）；stdout 截断正确性 | p50 往返 < 50ms；无孤儿 bwrap；截断标记正确 | 与 §4-3 量级吻合 |
| 4 | 取消风暴 | 每 10ms 触发 cancel watch × 1000 次 | TurnOutcome::Cancelled 占比；TurnStart/TurnEnd 成对；task 数 | 全 Cancelled；事件成对；metrics.num_alive_tasks 回落 | 无流/任务残留 |
| 5 | SSE 慢客户端 | sink 每事件 sleep 100ms + LLM 高速出 token | 背压下 turn 时长、内存峰值 | 无 OOM；turn 结束内存回落 | 生产者不被无限缓冲 |
| 6 | 多 worker spawn + 消息洪泛 | 50-200 spawn + 每 worker 100 条消息 | pending_total、JoinSet 长度收敛、watchdog 重派计数 | 消息 FIFO 无丢失；background_len 收敛 0 | 与 W232 合并后执行 |
| 7 | 长时运行内存曲线 | 8h 脚本（或加速时间轮），每 10min 采样 | RSS/Anon/task/事件数 | RSS 斜率 < 50MB/h 且无锯齿驻留 | 无持续增长段 |

执行步骤：build release → 场景 1/4/5（纯内存，无副作用）→ 场景 2/3（临时目录）→ 场景 6（等
W232 合并）→ 场景 7（后台长跑，先短跑 30min 验证采样管道）→ 结果入
`docs/benchmarks/`（对照本报告阈值）。

---

## 附：本报告引用/读过的源码文件

全文精读：crates/core/src/{context,event_bus,tool,plugin,registry}.rs；
crates/session/src/{mailbox,persistent,log}.rs；
crates/workers/src/{tools,registry,lib,plugin}.rs（HEAD 版）；
crates/agent-loop/src/{lib,context}.rs；crates/runtime/src/{run,compose}.rs（部分）。

结构扫描（grep/sed 片段 + 行号取证）：crates/tools/src/sandbox.rs；
crates/llm/src/client.rs；crates/runtime/src/{config,summary,tools}.rs；
crates/agent-loop/src/loop.rs；crates/workers/src/watchdog.rs（含 git show HEAD 校对）；
crates/session/src/registry.rs；全部 7 个 Cargo.toml。

未读部分（报告不涉及）：core/message.rs 细节、core/agent.rs、core/session_log.rs、
llm/config.rs、session/lib.rs、runtime/lib.rs 全文。
