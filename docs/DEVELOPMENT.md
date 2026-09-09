# Celestea 引擎开发文档（DEVELOPMENT）

> 本文是 **celestea_harness 引擎的开发者权威入口**。全部内容以仓库实际代码为准（逐文件核对），
> 标注 `TODO` 的地方表示当前代码无法给出确定结论。代码标识符、契约字段、环境变量名保留英文原样。
>
> - 核对基线：`main` 分支 `ac937e6`（reasoning_effort free-form passthrough）
> - 工具链：`rustc 1.98.0` / `cargo 1.98.0`
> - 测试基线：`cargo test --workspace` → **347 passed; 0 failed; 1 ignored**（2026-09-09 实测）
> - 只写文档，不改 `src/`、`crates/`、`Cargo.toml`

---

## 0. 文档地图（先读这一节）

本文是**索引 + 权威入口**，不重复既有评估类文档的结论。评估/路线类文档继续由它们自己维护：

| 文档 | 定位 | 与本文的关系 |
| --- | --- | --- |
| [`agent-iteration-roadmap.md`](./agent-iteration-roadmap.md) | Agent 核心评估与 6–12 个月路线图（P0/P1/P2、决策清单） | §1/§4 的架构判断引用它；不重复其排期结论 |
| [`agent-iteration-roadmap-w245-supplement.md`](./agent-iteration-roadmap-w245-supplement.md) | 上述路线图的 W245 独立验证补充 | 同上 |
| [`dsh-ptc-mode-eval.md`](./dsh-ptc-mode-eval.md) | DSH PTC（code agent preset）模式评估 | §3 run_code 的动机背景 |
| [`run-code-mode-eval.md`](./run-code-mode-eval.md) | run_code 折叠机制评估（方案 A/B、语言选择、安全分析、事件映射设计） | §3 的**设计依据**；本文只写**已落地实现** |
| [`backend-optimization-eval.md`](./backend-optimization-eval.md) | 后端优化评估（长文件拆分、解耦、性能、泄漏复查、压测设计） | §1/§8 的演进参考 |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | 早期设计文档（部分内容已过时，见 §10） | 本文以代码为准覆盖它 |

**按角色阅读路径**

- 新加入引擎开发：§1 → §2 → §5 → §8
- 要改工具/加工具：§2 → §3（run_code 模式）→ §4（沙箱）
- 要改 LLM/用量：§6 → §7
- 要把引擎接进前端：§1.5 → §9

---

## 1. 架构总览

### 1.1 仓库布局与 7 个 crate

虚拟 workspace（根 `Cargo.toml`：`members = ["crates/*"]`），**共 7 个 crate**：

| crate（包名） | 目录 | 职责 | 关键入口 |
| --- | --- | --- | --- |
| `celestea-core` | `crates/core` | **seam 定义层**（契约冻结）：Context / Plugin / EventBus / Llm / SessionLog / Tool / AgentLoop 及共享数据模型 | `crates/core/src/lib.rs`（只做 `pub use`） |
| `celestea-llm` | `crates/llm` | DeepSeek / OpenAI 兼容 provider：请求构造、原始 SSE 流、`reasoning_content` 解码、usage 提取 | `crates/llm/src/client.rs`、`config.rs`、`registry.rs` |
| `celestea-session` | `crates/session` | 会话日志（内存 / JSONL 持久化）、多会话注册表、mailbox | `log.rs`、`persistent.rs`、`registry.rs`、`mailbox.rs` |
| `celestea-tools` | `crates/tools` | 工具注册表 + guard 链 + 内置工具 + 沙箱 + 后台进程 + http + run_code | `registry.rs`、`guard.rs`、`builtin.rs`、`sandbox.rs`、`process.rs`、`http.rs`、`run_code.rs` |
| `celestea-agent-loop` | `crates/agent-loop` | 默认 turn/step 驱动器、上下文裁剪、`UsageTracker`、`LoopEvent` | `loop.rs`、`context.rs`、`events.rs` |
| `celestea-workers` | `crates/workers` | worker 编排：registry.tsv、会话/mailbox 引用、驱动 seam、看门狗、3 个编排工具、插件挂载 | `registry.rs`、`tools.rs`、`watchdog.rs`、`plugin.rs`、`types.rs` |
| `celestea-runtime` | `crates/runtime` | **装配层**：profile 解析、`Runtime::compose`、可取消的 streaming turn、turn 摘要 | `config.rs`、`compose.rs`、`run.rs`、`summary.rs`、`tools.rs` |

> 注意：仓库里**没有 `crates/cli`**。终端前端在 W214 被删除，引擎能力全部下沉到 `celestea-runtime`；
> 现存的 `README.md` / `ARCHITECTURE.md` 里仍残留 CLI 段落，属于过时文档（见 §10）。

### 1.2 依赖方向（无环）

以各 crate 的 `Cargo.toml` 为准：

```
celestea-core            （叶子，无内部依赖）
   ↑  ↑  ↑  ↑
   │  │  │  └── celestea-llm        (llm → core)
   │  │  └───── celestea-session    (session → core)
   │  └──────── celestea-tools      (tools → core)
   └─────────── celestea-agent-loop (agent-loop → core)

celestea-workers  → core, session, tools, agent-loop
celestea-runtime  → core, llm, session, tools, agent-loop, workers
```

规则：

- **core 只定义契约，不依赖任何兄弟 crate**；新增能力放实现 crate，通过 Context 装配，不得让 core 反向依赖。
- `workers` 是最“重”的中间层（编排需要工具、会话、循环）；`runtime` 是唯一知道全部 crate 的装配者。
- 没有任何环；`runtime` 依赖 `workers`，`workers` 不依赖 `runtime`。

### 1.3 core 的 seam 契约

core 的每个 seam 单独一个模块，crate 根只 re-export（`crates/core/src/lib.rs:13-31`）：

| seam | 定义位置 | 类型 / trait | 实现者（代码位置） |
| --- | --- | --- | --- |
| **Context** | `crates/core/src/context.rs:9` | `Context`（`TypeId` 键的服务容器 + `parent` 链，`provide`/`get`/`scoped`） | 装配者使用：`crates/runtime/src/compose.rs:192-209`；worker 每会话独立 scope：`crates/workers/src/registry.rs:286-291` |
| **Plugin** | `crates/core/src/plugin.rs:6` | `trait Plugin { fn name(); fn mount(&self, &mut Context) }` | `WorkersPlugin`、`WatchdogPlugin`（`crates/workers/src/plugin.rs:41`、`:81`） |
| **EventBus** | `crates/core/src/event_bus.rs:23` | 三种派发模式：`on/emit`（广播）、`bail/run_bail`（拦截，首个 `Some` 短路）、`waterfall/run_waterfall`（变换链） | 目前是通用能力，核心装配路径尚未挂监听器（`TODO`：如需 hook 点在此扩展） |
| **Llm trait** | `crates/core/src/llm.rs:6` | `trait Llm { async fn generate(ModelRequest) -> Result<LlmStream, LlmError> }`；另有 `LlmService`、`LlmRegistry`（同名后者覆盖前者）、`LlmRegistryService` | `DeepSeekLlm`（`crates/llm/src/client.rs`），注册名 `"deepseek"`（`crates/llm/src/registry.rs`） |
| **SessionLog** | `crates/core/src/session_log.rs:87` | `append/events/derive_messages/clear/next_turn_id`；事件与终态类型同文件 | `InMemorySessionLog`（`crates/session/src/log.rs:23`）、`PersistentSessionLog`（`crates/session/src/persistent.rs:97`） |
| **ToolGuard** | `crates/core/src/tool.rs:73` | `trait ToolGuard { async fn check(&ToolInput) -> ToolDecision }`（`Allow/Deny/Ask`，首个非 `Allow` 短路） | `PathGuard`（`crates/tools/src/guard.rs:189`），由 `mount_production_guards` 挂载 |
| （配套）**Tool** | `crates/core/src/tool.rs:54` | `spec()` + `execute(Value)` + 可覆写 `execute_with(ToolInput)` | 全部内置/编排工具；`run_code` 覆写 `execute_with` 以拿到 `call_id` |
| （配套）**ToolRegistry** | `crates/core/src/tool.rs:78` | `register/add_guard/get/schemas/dispatch` | `ToolRegistryImpl`（`crates/tools/src/registry.rs:15`） |
| （配套）**AgentLoop** | `crates/core/src/agent.rs:52` | `async fn run_turn(&Context, &str) -> Result<(), AgentError>` | `DefaultAgentLoop`（`crates/agent-loop/src/loop.rs:39`） |

服务注入 Context 时都用 **newtype 包装**（`LlmService` / `LlmRegistryService` / `SessionService` /
`ToolRegistryService` / `AgentLoopService` / `WorkerRegistryService` / `ProcessRegistryService`），
原因是 `Context` 以 `TypeId` 为键，裸 `Arc<dyn Trait>` 无法直接当具体类型取回。

`Context::provide` 的语义是**后写覆盖先写**（`context.rs:21`），`get` 会沿 `parent` 链回退；
`scoped()` 给每个 agent 一个子作用域（子作用域可遮蔽父作用域同类型服务）。

### 1.4 `Runtime::compose` 组装顺序

`crates/runtime/src/compose.rs:70-211`，严格按序（顺序有依赖，勿随意调整）：

1. **模型校验**：`validate_model(&profile.model)`——只要求非空（`crates/runtime/src/config.rs:399`）。
2. **API key 解析**：`resolve_api_key(profile)`——env[`api_key_env`] 优先，其次 `api_key_file`（trim 后），
   都没有则硬错误。key 值不进入 profile、不落任何日志。
3. **base_url 解析**：`profile.base_url` → env `DEEPSEEK_BASE_URL` → 默认 `https://api.deepseek.com`
   （`resolve_base_url`，`config.rs:387`）。
4. **LLM 适配器**：构造 `DeepSeekConfig` → `deepseek_registry(DeepSeekLlm::new(config))` →
   `resolve("deepseek")`。registry 名固定 `"deepseek"`；`LlmService` 仍单独提供以兼容只读单适配器的消费者。
5. **会话日志**：读 env `CELESTEA_SESSION_DIR`；非空 → `PersistentSessionLog::open(dir, "cli-main")`
   （失败则打印告警并回退内存日志），否则 `InMemorySessionLog::new()`。
6. **WorkerRegistry**：`WorkerRegistry::with_default_path()`，落盘路径 `/tmp/celestea-workers-registry.tsv`。
7. **ProcessRegistry + 完成回传 sink**：`ProcessRegistry::new()`，随后 `set_completion_sink(...)`：
   后台进程**自然退出**时把一行 `"[process] <handle> exited code=<n> (<ms>ms)\nstdout: ...\nstderr: ..."`
   推入宿主会话 mailbox（`HOST_SID = "cli-main"`，`from_label = "process-<handle>"`）。
8. **宿主会话登记**：把 `cli-main` 注册进共享 `SessionRegistry`（`SessionMeta`，日志为空影子日志），
   使 worker 侧 `session_send_message(target="cli-main")` 能解析并投递回执。
9. **工具面**：`build_registry(workers, processes, session)` → 10 个工具 + 生产 guard 链 + `run_code` 的 Weak 回引。
10. **用量**：`UsageTracker::new()`（`Arc`）。
11. **AgentConfig**：从 profile 的 `model/system_prompt/max_steps/max_parallel_tool_calls/context_*` 构造。
12. **默认 loop**：`DefaultAgentLoop::with_bindings(config, None, None, Some(usage))`——无 sink/无取消，
    但**共享** usage tracker，使 worker 驱动的会话也记账。
13. **Context::provide**：`LlmService` → `LlmRegistryService` → `SessionService` → `ToolRegistryService` → `AgentLoopService`。
14. **`workers.attach_drivers(...)`**：必须在第 13 步之后，从 ctx 取回 `LlmService` / `ToolRegistryService` /
    `AgentLoopService` 注入驱动 seam；三个 seam 齐备后 `spawn_worker` 才会 `driven:true`（否则只登记不驱动）。
15. **`provide(WorkerRegistryService)`、`provide(ProcessRegistryService)`**。

### 1.5 Gen / Runtime 生命周期

**Gen** 是 Studio 侧概念（`/src/celestea_studio/src/main.rs`）：一代引擎 = 一个 `Arc<Runtime>` + 元数据。
引擎侧只有 `Runtime`：

```
Runtime::compose(profile)            // 建服务图
   │
   ├── run_turn(input, cancel, sink) // 每轮：drain cli-main mailbox → make_loop → agent.run_turn
   │      └── make_loop 重建 per-turn DefaultAgentLoop(config, cancel, sink, Some(usage))
   │          （cancel 是 tokio::sync::watch::Receiver<bool>，sink 是 EventSink）
   │
   ├── shutdown().await               // 显式、幂等
   └── Drop                           // 自动兜底（同步部分）
```

- `run_turn`（`crates/runtime/src/run.rs:55`）：先把 `cli-main` mailbox 中 pending 消息按 FIFO drain 进宿主日志
  （`[from <label>] <content>`），再跑一轮；返回值从日志里最后一条 `TurnEnd.outcome` 读出（日志是唯一真源）。
  另有 `latest_usage()` / `total_usage()` / `summarize_turn()`。
- `shutdown`（`compose.rs:226`）是**幂等**的，可重复调用（Drop 已跑过也安全）。顺序：
  1. `workers.abort_all_now()`——notify 全部 stop 信号（让阻塞在 `mailbox.recv` 的驱动循环退出）+ abort 全部驱动任务；
  2. `ProcessRegistryService.kill_all()`——杀掉全部后台进程（进程组 SIGKILL），与 Drop 同路径；
  3. `mailbox.purge_all()`——丢弃所有未消费消息（含旧代回执）；
  4. `sessions().clear()`——清空 SessionRegistry（`cli-main` 由下次 compose 重新登记）；
  5. 之后 `join_drivers().await` 收割被 abort 的驱动任务（仅 async 路径；Drop 不能 await）。
- `Drop for Runtime`（`compose.rs:254`）只跑同步部分（1-4），不 join；被 abort 的任务由 tokio 在取消时释放捕获的 `Arc`。
- **换代调用序**（Studio 必须遵守）：旧 gen `shutdown()` → 新 gen `compose()`。

### 1.6 为什么 `WorkerRegistry` 用 `Weak`

worker 三工具（`spawn_worker` / `session_send_message` / `worker_status`）只持有
`Weak<WorkerRegistry>`（`crates/workers/src/tools.rs:115`）。原因：装配路径会把工具注册表以
`ToolRegistryService` 存回 `WorkerRegistry`（`attach_drivers`）。若工具持 `Arc`，就形成

```
WorkerRegistry → ToolRegistryService → WorkerTool(Arc) → WorkerRegistry
```

的**强引用环**，换代后旧 `Runtime` 永远无法释放（`Weak::upgrade()` 一直 `Some`），旧代资源泄漏。

验收断言在 `crates/runtime/src/compose.rs:404-422`：compose 后 `weak.strong_count() == 2`
（只有 `Runtime.workers` 字段 + ctx 里的 `WorkerRegistryService`），`drop(rt)` 后 `upgrade()` 必须为 `None`。
工具执行时 `upgrade()` 失败则 fail-closed 返回 `{ok:false, step:"registry", error:"registry released"}`，不 panic
（`crates/workers/src/lib.rs:102-125`）。

同一思路也用在 `run_code`：`RegistryHandle` 只持 `Weak<dyn ToolRegistry>`（`crates/tools/src/run_code.rs:568`），
先注册工具、再绑定 Weak，避免 `Arc::get_mut` 失败。

### 1.7 工具注册的两条路径（9 / 10 的差别）

| 函数 | 位置 | 注册内容 | 工具数 |
| --- | --- | --- | --- |
| `register_all_tools` | `crates/runtime/src/tools.rs:19` | 6 个 builtin（`builtin_tools_with`）+ 3 个 worker 工具（`worker_tools_with`）+ `mount_production_guards` | **9** |
| `build_registry` | `crates/runtime/src/tools.rs:45` | 先 `register_all_tools`，再注册 `run_code`（`run_code_tool_with_handle`）并绑定 Weak 回引 | **10** |

`Runtime::compose` 走 `build_registry`，所以**真实 agent 工具面是 10 个**（测试
`compose_tool_surface_has_ten_tools`，`compose.rs:314`）。`WorkersPlugin::mount`
（`crates/workers/src/plugin.rs:67-89`）另建一个组合注册表（6 builtin + 3 worker = 9，同样挂 guard），
供不经 runtime 的插件路径使用。

---

## 2. 工具清单与契约

### 2.1 十个工具总表

顺序为 `schemas()` 的字母序（注册表按名字排序返回）。入参 schema 均 `additionalProperties: false`。

| # | 工具 | 关键入参 | 返回值（canonical `value`） | 主要限制 / 闸门 |
| --- | --- | --- | --- | --- |
| 1 | `read_file` | `path` | 文件文本（string） | `PathGuard` 读白名单：workspace + `CELESTEA_TOOL_ROOTS` |
| 2 | `write_file` | `path`, `content` | `"ok"` | `PathGuard` 写仅限 workspace（`CELESTEA_TOOL_WORKDIR`，默认进程 cwd） |
| 3 | `list_dir` | `path` | 文件名数组 | 同 `read_file` 读白名单 |
| 4 | `run_shell` | `command`, `workdir?`, `timeout_ms?`, `background?`, `notify?` | `{stdout, stderr, exit_code, stdout_truncated, stderr_truncated, sandbox}`；`background:true` → `{background, handle, pid, sandbox}` | 沙箱三层；默认 30s，上限 `CELESTEA_SHELL_MAX_TIMEOUT_MS`（默认 300000ms）；每流 64KiB |
| 5 | `process_control` | `handle`, `action`(`poll`/`kill`/`stdin`), `content?` | `{ok:true, ...}`；契约错误 `{ok:false, error}` | 只操作会话进程 registry 中的 handle |
| 6 | `http_request` | `url`, `method?`, `headers?`, `body?`, `timeout_ms?` | `{status, headers, body, truncated}` | 仅 http/https；5 跳重定向；body 1MiB；默认 15s / 上限 60s；SSRF 策略失败即拒 |
| 7 | `run_code` | `code`, `description?`, `timeout_ms?` | `main()` 返回值的 JSON | ≤20 子调用 / ≤120s / 子调用输出 ≤256KiB / stdout 日志 ≤64KiB；SDK 四工具白名单 |
| 8 | `spawn_worker` | `wid`, `brief`, `title?`, `workspace?`, `provider?`, `model?`, `reasoning_effort?`, `report_to?` | `{ok, sessionId, title, wid, driven, ...}` | wid 去重；写 registry.tsv |
| 9 | `session_send_message` | `target`, `content` | `{ok, delivered, queued, target, sourceSession, message_id}` | 目标解析：id 直取 / 命名唯一；多命中返回候选 |
| 10 | `worker_status` | `wid?` | 无 `wid`：`{ok, total, by_status:{RUNNING,DONE,FAILED}, by_state:{in-turn,idle,running}, workers:[...]}`；带 `wid`：`{ok, wid, worker:{...}}` | 读 registry.tsv；只认本进程行 |

### 2.2 逐个契约

#### read_file / write_file / list_dir（`crates/tools/src/builtin.rs:29-63`）

- `read_file {path: string}` → `tokio::fs::read_to_string` 的文本（`Value::String`）。IO 错误 → `error` 字符串。
- `write_file {path: string, content: string}` → 写文件后返回 `"ok"`。
- `list_dir {path: string}` → 目录项**文件名**数组（不含路径、不排序）。
- 三者都**没有**内容大小上限（`TODO`：超大文件读取没有截断保护）。
- `read_file` / `list_dir` 的 guard 是 `check_read`：目标路径 canonicalize 后必须落在
  `workspace` 或 `CELESTEA_TOOL_ROOTS` 任一读根内；`write_file` 是 `check_write`：仅 workspace 可写，
  白名单根只读。**不存在**的路径在 guard 层放行（由工具自身报 IO 错误）；
  `write_file` 对“尚不存在的文件”会 canonicalize 最近的已存在祖先再拼回后缀来裁决。

#### run_shell（`crates/tools/src/builtin.rs:138-182`、`sandbox.rs`）

- 前台：返回 `{stdout, stderr, exit_code, stdout_truncated, stderr_truncated, sandbox}`。
  `sandbox` 是 `{provider: "bwrap"|"raw"|"userspace", net_isolated, tmp_private, seccomp}`——
  实际隔离级别**可见、不靠推断**（W249 决议：禁止静默降级到宿主网络）。
- `workdir` 覆写必须已存在、是目录、且 canonical 后仍在 `SandboxConfig.root` 内（默认 root = 含 workdir 的
  git top-level，否则 workdir 本身；`CELAESTEA_RUN_SHELL_ROOT` 可放宽）。
- `timeout_ms`：缺省 `SandboxConfig.timeout`（默认 30s）；显式值必须 ≥1 且 ≤ `max_timeout`
  （默认 300s，`CELESTEA_SHELL_MAX_TIMEOUT_MS` 调整）。超限是结构化错误 `code=arg`，不是截断。
- 每流输出上限默认 64KiB（`CELAESTEA_RUN_SHELL_MAX_OUTPUT_BYTES`）；超出**继续 drain 但不缓冲**，
  避免子进程写满管道阻塞，并置 `*_truncated: true`。
- 环境变量白名单：`PATH`、`LANG`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES`、`TERM`（Windows 另加
  `SystemRoot`/`ComSpec`/`PATHEXT`/`TEMP`/`TMP`）；`TMPDIR` 固定为沙箱内 `/tmp`。
  `HOME` 与一切 `*_API_KEY` 之类**不进子进程**。
- 后台：`background:true` → 脱离调用级超时（rlimit 仍生效），立即返回 `{background:true, handle, pid, sandbox}`，
  进程进入会话级 `ProcessRegistry`，跨 turn 存活，用 `process_control` 管理。
- `notify`（默认 `true`）：后台进程**自然退出**时向宿主 mailbox 推一条完成消息（见 §2.5）；
  `kill`/shutdown 路径被内部抑制，不会重复推送；`notify:false` 关闭。

#### process_control（`crates/tools/src/process.rs:462-502`）

- `action:"poll"` → `{ok:true, handle, pid, running, stdout_tail, stderr_tail, stdout_truncated, stderr_truncated, exit_code}`
  （tail 上限 4KiB；进程退出后条目会被 reaper 自动移除，再 poll 得到 `unknown handle`）。
- `action:"kill"` → 关闭 stdin → SIGTERM 进程组 → 1s 宽限 → SIGKILL → `{ok:true, killed:true, handle}`。
- `action:"stdin"` → 写 `content + "\n"`（5s 写超时）→ `{ok:true, handle, written}`。
- **契约错误是值不是工具错误**：未知 handle / 未知 action / 缺 `content` / 进程已退出都返回
  `{ok:false, error:"..."}`，`ToolOutput.error` 仍为 `None`。
- 每个后台进程有一个 reaper 任务，把 stdout/stderr 排入 512KiB 环形缓冲（每流），进程退出后从 registry 移除；
  `ProcessRegistry` 的 `Drop` / `kill_all()` 杀掉所有残留子进程（幂等）。

#### http_request（`crates/tools/src/http.rs`）

- 入参：`url`（必填）、`method`（GET/POST/PUT/DELETE/PATCH/HEAD，默认 GET）、`headers`（string→string）、
  `body`、`timeout_ms`（默认 15000，上限 60000，越界是 `code=invalid_arg`）。
- 返回 `{status, headers, body, truncated}`；`headers` 只回传固定子集（content-type/content-length/
  content-encoding/cache-control/etag/last-modified/location/server/www-authenticate/retry-after/date）。
  **HTTP 错误状态不是工具错误**（404 也返回 `value`）；传输失败才分类为
  `invalid_url | invalid_arg | timeout | dns | connect | redirect | target_forbidden`。
- 仅 `http`/`https`；`file://` 等立即 `code=invalid_url`。重定向上限 5 跳，第 6 跳 `code=redirect`。
- body 截断到 1 MiB（`truncated:true`）。请求**不走环境代理**（`no_proxy()`）。
- **SSRF 策略**：`CELESTEA_HTTP_ALLOW` / `CELESTEA_HTTP_DENY`（逗号分隔 IP/CIDR）。未设置 = 放行全部
  （进程内只打印一次 `SSRF guard off`）。设置后：解析主机名的**每个** IP 都必须过策略（fail-closed），
  且禁用 reqwest 自动跳转、改为逐跳重新检查目标——重定向无法跳出策略。**配置写错时 fail-closed**：
  全部目标拒绝并打印错误，绝不静默放开。

#### spawn_worker / session_send_message / worker_status（`crates/workers/src/tools.rs`）

- `spawn_worker`：`wid` + `brief` 必填；先校验（空/重复 wid 报 `{ok:false, step:"validate"}`），
  再 `SessionRegistry::create` → 标题 `<wid>·<短名>`（短名取 brief 首个非空行去 `#`、截 20 字）→
  写 registry.tsv（`sess=`/`ws=`/`title=`/`driven=`/`proc=` 等 extra token）→ 若驱动 seam 齐备则后台驱动。
- `session_send_message`：`target` 可以是 session id，也可以是唯一标题/工作区名；多命中返回
  `{ok:false, step:"resolve", target, candidates:[{id,title,workspace,model}]}` 且**不投递**；投递成功
  `{ok:true, delivered:true, queued:true, target, sourceSession, message_id}`。消息进入目标会话 mailbox，
  驱动循环被唤醒并以 content 为输入跑新一轮。
- `worker_status`：读 registry.tsv 返回 `{ok, total, by_status:{RUNNING,DONE,FAILED}, by_state:{in-turn,idle,running}, workers:[...]}`；
  带 `wid` 时返回 `{ok:true, wid, worker:{...}}`，查不到返回 `{ok:false, step:"lookup", error:"no worker <wid> in registry"}`。
  **只统计本进程写入的行**（`proc` token 匹配），跨进程残留行不算。

### 2.3 安全闸门：ToolGuard 路径白名单

`crates/tools/src/guard.rs`。`mount_production_guards`（`guard.rs:225`）在注册表装配时挂 `PathGuard`：

| 工具 | 策略 |
| --- | --- |
| `read_file` / `list_dir` | canonical 目标必须落在 workspace 或 `CELESTEA_TOOL_ROOTS`（`PATH` 风格分隔，Unix `:`） |
| `write_file` | canonical 目标（或最近已存在祖先 + 未创建后缀）必须在 workspace 内；白名单根只读 |
| 其它工具 | 直接放行（`run_shell` 有自己的沙箱层，`http_request` 有自己的目标策略，worker 工具在本 guard 范围内无 `path` 参数） |

- 拒绝形状：`toolguard: code=path_forbidden msg="<转义后的消息>"`；注册表把它包成
  `ToolOutput { error: Some("denied: <reason>"), decision: Some(Deny(reason)) }`（`registry.rs:56-63`）。
- 环境变量：`CELESTEA_TOOL_ROOTS`（额外读根）、`CELESTEA_TOOL_WORKDIR`（workspace 覆盖，默认 guard 构造时的进程 cwd）、
  `CELESTEA_TOOL_GUARD=0`（**显式逃生舱**，只跳过 guard 挂载，不削弱沙箱/HTTP 策略，且会打印告警）。
- 已文档化的残余风险（`guard.rs:27-33`）：检查与工具自身 open 之间的 TOCTOU；`run_shell` 在沙箱内仍可读只读宿主根。

### 2.4 后台进程完成推送（W251）

装配时 `compose.rs:137-151` 把 `ProcessRegistry::set_completion_sink` 指向宿主 mailbox：

```
run_shell(background:true, notify:true)
   └─ ProcessRegistry reaper 观察到自然退出
        └─ sink(ProcessCompletion{handle,pid,exit_code,stdout_tail,stderr_tail,elapsed_ms})
             └─ mailbox.send("cli-main", "[process] <handle> exited code=<n> (<ms>ms)\nstdout: ...\nstderr: ...", "process-<handle>")
                  └─ 宿主下一轮 run_turn 开头 drain 进会话日志（Studio autowake 循环随后唤醒 agent）
```

`ProcessCompletion` 的 tail 上限 1KiB、换行折叠。kill / shutdown 路径置 `kill_path=true`，**不触发** sink。

---

## 3. `run_code`（P0 重点）

设计依据见 [`run-code-mode-eval.md`](./run-code-mode-eval.md) §4.1 方案 A；本节只写**已落地的实现**。
更细的 SDK 用法、错误处理与完整示例见 [`run-code-sdk.md`](./run-code-sdk.md)。

### 3.1 一次调用的端到端时序

```
agent-loop  dispatch(ToolInput{call_id:"rc1", name:"run_code", args:{code}})
   └─ RunCodeTool::execute_with  （唯一覆写 execute_with 的工具，需要 call_id）
        └─ broker_run(crates/tools/src/run_code.rs:677)
             1. 校验 code 非空 / timeout_ms ∈ [1,120000]
             2. RegistryHandle::resolve() → 拿到同一注册表的 Arc（未绑定 → code=registry）
             3. 拼装程序 = RUN_CODE_SDK + 用户代码 + RUN_CODE_RUNNER
                写到 <sandbox workdir>/.celestea/run_code_<pid>_<n>.py
             4. sandbox::spawn_sandboxed("python3 -uB .celestea/<file>")  ← 与 run_shell 同一套沙箱
             5. 读子进程 stdout 逐行：
                  {"id","tool","args"}      → 限额校验 → registry.dispatch(同一管线) → 写回一行 JSON
                  {"__final__": <json>}     → 记录最终值，结束
                  {"__error__": "<msg>"}    → 记录程序异常，结束
                  其它/非 JSON              → 当作日志行（≤64KiB）
             6. 关闭 stdin（让阻塞中的子进程见 EOF 报错而非永久挂起）
             7. settle(2s 宽限) → 超时则杀整个进程组；收集 stderr
             8. 成功 → value = 最终值，render = 日志/告警；失败 → Err(结构化或程序异常)
```

程序文件在**所有退出路径**上都会被删除（`ScriptCleanup` 的 `Drop`）。若调用方 future 被 drop（取消/abort），
`ChildKillGuard` 的 `Drop` 会杀掉整个进程组，不留孤儿 `python3`。

### 3.2 线路协议（stdout / stdin 单行 JSON）

```
child → parent   {"id": <int>, "tool": "<name>", "args": {...}}
parent → child   {"id": <int>, "ok": true, "value": <json>}
                 {"id": <int>, "ok": true, "value": <json>, "truncated": true, "warning": "..."}
                 {"id": <int>, "ok": false, "error": "<message>"}
child → parent   {"__final__": <json>}      // main() 正常返回
                 {"__error__": "<message>"} // 未捕获异常（stderr 里另有 traceback）
```

- 一行一个 JSON 对象，**没有其它分帧**；`stdin` 是父进程的回复通道，所以程序**不得读 `sys.stdin`**，
  也不要写 `if __name__ == "__main__"` 块。
- 单行上限 `MAX_LINE_BYTES = 1 MiB`：超长行被 drain 后丢弃，并**按日志行处理**（截断的协议行不可能有效）。
- 回复 id 必须与请求 id 一致，否则 SDK 抛 `ToolCallError`（reply id mismatch）。
- 父进程写回失败（stdin 关闭）→ 结构化错误 `run_code: code=protocol`。

### 3.3 SDK 白名单四工具

`SDK_TOOLS = ["read_file", "write_file", "list_dir", "run_shell"]`（`run_code.rs:64`）。

- 只有这四个名字会被父进程 `dispatch`；**其它任何名字**（含 `run_code` 自己、`spawn_worker`、
  `session_send_message`、`process_control`、`http_request`）一律回
  `{"ok":false,"error":"tool '<name>' not exposed in run_code SDK"}`，SDK 侧表现为 `ToolCallError`。
- 子调用**串行**执行（P0 语义）；Python 侧并发是已文档化的后续项。
- 每次子调用都走**与模型直调完全相同**的管线：guard 链 → 注册表查找 → `execute_with`。因此路径白名单、
  沙箱、超时、输出上限对子调用同样生效，**零重复实现**。

### 3.4 限额（父进程强制）

| 限额 | 常量 | 值 | 超限行为 |
| --- | --- | --- | --- |
| 子调用数 | `MAX_SUB_CALLS` | 20 | 第 21 次直接回 `ok:false`（`run_code: sub-call limit exceeded`），不计入 dispatch |
| 整体墙钟 | `DEFAULT_TIMEOUT` / `MAX_TIMEOUT` | 120s / 120s（硬上限） | 杀整个进程组，`code=timeout`，已捕获日志字节数写进消息 |
| 子调用输出累计 | `MAX_SUB_OUTPUT_BYTES` | 256 KiB | 字符串取 UTF-8 安全前缀；对象/数组无法无损切割则替换为占位串；回复带 `truncated:true` + `warning` |
| 程序 stdout 日志 | `MAX_LOG_BYTES` | 64 KiB | 截断并追加 `[run_code] stdout logs truncated at 65536 bytes` |
| stderr | 同 `MAX_LOG_BYTES` | 64 KiB | 截断并在 render 中标注 |
| 单行 | `MAX_LINE_BYTES` | 1 MiB | drain 后丢弃，按日志行处理 |

默认墙钟可用 `CELAESTEA_RUN_CODE_TIMEOUT_MS` 调整（clamp 到 `[1, 120000]`——**cap 不可调**）。
per-call `timeout_ms` 超过 120000 是 `code=invalid_arg`，不是截断。

### 3.5 `_Value` 双接口与 `_AttrDict`

模型写 Python 的两种风格必须都成立：

- `tools.list_dir(path=".")` —— 直接当 list 用（下标 / 迭代 / `len` / `bool` / `str`）；
- `await tools.list_dir(path=".")` —— 当 awaitable 用。

实现：

- `_Value`（`run_code.rs:255`，SDK 内）包装子调用结果，实现 `__getitem__` / `__iter__` / `__len__` /
  `__bool__` / `__str__` / `__repr__` / `__eq__` / `get()` / `__getattr__`（方法透传，如 `splitlines`），
  以及 `__await__`：**yield 空后 return 值**。注意：`__await__` 里不能 yield 值本身，否则 asyncio 会把它
  当成 awaitable，dict/list 结果会报 `Task got bad yield`。
- `_AttrDict`（`run_code.rs:234`）：`dict` 子类，`__getattr__` 回落到 `self[name]`，所以
  `s.stdout == s['stdout']`。`_attr()` 会**递归**把任意深度的 dict 转成 `_AttrDict`（list 内也递归）。
- 因此 `await` 前后都成立：直接调用拿到 `_Value`（`__getattr__` 透传到内部 `_AttrDict`）；
  `await` 拿到 `_Value._v`，本身就是 `_AttrDict`。
- 最终返回值经 `_plain()` 递归解包 `_Value` 再 JSON 序列化（否则无法序列化包装对象）。

### 3.6 `ToolCallError`

```python
class ToolCallError(Exception):
    def __init__(self, tool_name, message):
        super().__init__(f"tool '{tool_name}' failed: {message}")
        self.tool_name = tool_name
```

触发条件（全部在 SDK 侧，程序可 `try/except` 后继续）：

| 场景 | message |
| --- | --- |
| 参数不是 JSON 可序列化 | `arguments are not JSON-serializable: ...` |
| 父进程关闭回复通道（读 stdin 得到 EOF） | `the parent broker closed the reply channel (run aborted)` |
| 回复行不是合法 JSON | `malformed reply from the parent broker: ...` |
| 回复 id 与请求 id 不一致 | `reply id mismatch (expected X, got Y)` |
| `ok:false` | 父进程给的 `error`（guard 拒绝 / 未知工具 / 子调用限额 / 工具自身错误） |

未被捕获的异常由 runner 兜底：打印 traceback 到 stdout，再输出 `{"__error__": "<Type>: <msg>"}` 并 `exit(1)`。

### 3.7 事件映射：`parent_id` 与 `derive_messages` 截断

- 父进程在 dispatch 子调用**前后**各写一条会话事件（若绑定了 session 日志 sink）：
  - `SessionEvent::ToolCall { id: "<parent>:c<n>", name, args, parent_id: Some("<parent>") }`
  - `SessionEvent::ToolResult { id: "<parent>:c<n>", value, error, parent_id: Some("<parent>") }`
- 外层 `run_code` 自身的 ToolCall/ToolResult 由 agent-loop 正常写入，`parent_id: None`。
- 事件**保留在日志里**（审计 / replay 可见完整子树），但 `derive_messages`（`crates/session/src/log.rs:73-153`）
  对 `parent_id.is_some()` 的 ToolCall/ToolResult **直接跳过**——模型可见历史只有外层 `run_code` 一轮往返。
  这样既保住审计能力，又不让几十条子调用撑爆上下文。
- `parent_id` 序列化时 `skip_serializing_if = "Option::is_none"`，所以 W255 之前的 jsonl 字节形状不变；
  读取时 `#[serde(default)]`，旧行反序列化为 `None`（`crates/core/src/session_log.rs:64-84`）。

### 3.8 最小可运行示例

以下三段均已用**真实 SDK 前导 + runner** 加模拟 broker 实测通过（见 §10 验证记录）。

**A. 基本用法（直接下标 + 属性两种写法混用）**

```python
async def main():
    listing = tools.list_dir(path=".")
    first = listing[0]

    s = tools.run_shell(command="printf 'a\\nb\\n'")
    lines = s.stdout.splitlines()          # s.stdout == s['stdout']
    return {"first_entry": first, "line_count": len(lines), "stdout": s['stdout']}
# 实测 final = {"first_entry": "alpha.txt", "line_count": 2, "stdout": "a\nb\n"}
```

**B. `await` 形式（结果同样是 `_AttrDict`）**

```python
async def main():
    s = await tools.run_shell(command="echo hi")
    return s.stdout.strip()                # 实测 final = "hi"
```

**C. 捕获子调用失败后继续**

```python
async def main():
    try:
        tools.read_file(path="/etc/shadow")   # 被 PathGuard 拒绝
    except ToolCallError as e:
        return f"denied: {e}"                 # 程序可继续做别的事
    return "unexpectedly allowed"
# 实测 final = "denied: tool 'read_file' failed: denied: toolguard: code=path_forbidden"
```

---

## 4. 沙箱分层

实现：`crates/tools/src/sandbox.rs`。`run_shell` 与 `run_code` 共用同一套执行沙箱。

### 4.1 三层降级顺序

`OsSandboxLayer` 是扩展点（`sandbox.rs:168`），默认层是 `OsSandboxV2`（`sandbox.rs:558`）：

| provider | 条件 | 能力 |
| --- | --- | --- |
| `bwrap` | `detect_bwrap()` 找到可用 bubblewrap，且 `bwrap_sandbox_usable()` 探测通过 | mount/user/pid/ipc/uts 命名空间、**只读根**、可写 workdir、私有 tmpfs、可选独立 netns |
| `raw` | 无可用 bwrap，但 `raw_namespaces_supported()` 为真 | `unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWNET)` + `chroot`，同样的 net/tmp 默认 |
| `userspace` | 都不满足，或探测到 OS 隔离会破坏 v1 契约（例如打不开 `/dev/zero`） | 仅 v1 用户态保证：超时、输出上限、workdir 控制、env 清洗、结构化错误、**rlimit** |

- 自动探测顺序：`detect_provider()`（`sandbox.rs:518`）→ bwrap 可用则 `bwrap`，否则 raw 支持则 `raw`，
  否则 `userspace`。结果用 `OnceLock` 缓存。
- 可用 `CELAESTEA_RUN_SHELL_OS_SANDBOX` 显式指定：`off`/`0`/`false`/`no` → `userspace`；
  `bwrap` → 有则 bwrap 否则 userspace；`raw` → 支持则 raw 否则 userspace；未设 → 自动探测。
- 降级到 `userspace` 时会打印一行告警（“no net/tmp namespace isolation; rlimits + timeout + env
  sanitization still apply”）。**降级不会 panic**；wrap 后的 spawn 失败时按
  `degrade_on_spawn_failure()` 回退到裸 v1 命令。
- 每次运行的实际模式写进结果里的 `sandbox` 对象（§2.2）。

### 4.2 网络与 /tmp 默认

| 行为 | 默认 | 打开宿主的开关 | 说明 |
| --- | --- | --- | --- |
| 网络 | **隔离**（独立 netns） | `CELESTEA_SANDBOX_NET=1` | bwrap `--share-net` / raw 保留宿主 netns |
| `/tmp` | **私有 tmpfs**（不挂宿主 /tmp） | `CELESTEA_SANDBOX_SHARE_TMP=1` | 旧别名 `CELAESTEA_RUN_SHELL_V2_TMPFS_TMP`（已废弃）：`1` = tmpfs、`0` = 宿主 /tmp |

优先级：`CELESTEA_SANDBOX_SHARE_TMP=1`（显式共享，最高）> 旧别名。子进程看到的 `TMPDIR` 始终是 `/tmp`。

### 4.3 seccomp（默认关闭）

- 开关：`CELESTEA_SANDBOX_SECCOMP=1`（新名）或 `CELAESTEA_RUN_SHELL_V2_SECCOMP=1`（旧名）。
- 实现是**最小 syscall 白名单**：bwrap 走 `--seccomp`（blob 经保留 fd 200 传入）；
  raw / userspace 走子进程内 `install_direct()`。仅 Linux x86_64 有真实实现，
  其它平台 `build()` 返回空、`write_blob()` 报不支持。
- 默认关闭的原因：部分内核上 bwrap `--seccomp` 有竞态（`sandbox.rs:208-210`）。

### 4.4 rlimit（CPU / AS / NPROC / FSIZE / NOFILE）

`V2Limits`（`sandbox.rs:237`），默认值：

| 限制 | 默认 | 环境变量 |
| --- | --- | --- |
| `RLIMIT_CPU` | 20 秒 | `CELAESTEA_RUN_SHELL_V2_CPU_SEC` |
| `RLIMIT_AS` | 2048 MiB | `CELAESTEA_RUN_SHELL_V2_MEM_MB` |
| `RLIMIT_NPROC` | 512 | `CELAESTEA_RUN_SHELL_V2_NPROC` |
| `RLIMIT_FSIZE` | 256 MiB | `CELAESTEA_RUN_SHELL_V2_FSIZE_MB` |
| `RLIMIT_NOFILE` | 256 | `CELAESTEA_RUN_SHELL_V2_NOFILE` |
| `RLIMIT_CORE` | 0（禁 core） | `CELAESTEA_RUN_SHELL_V2_CORE`（`0` 关闭禁 core） |

- 数值为 0 表示不限；env 值只有 `> 0` 才生效。
- **v1 userspace 路径同样套用**（`apply_rlimits_pre_exec` 在 `pre_exec` 里 `setrlimit`），
  保证降级后 CPU/AS/NPROC/FSIZE/NOFILE 边界不丢。
- 失败是**尽力而为**：`setrlimit` 出错被忽略（rlimit 是加固层，不是硬要求）。

### 4.5 超时杀进程与结构化错误

- Unix 上子进程 `process_group(0)` 领自己的进程组；超时后对**整个进程组** SIGKILL，
  再用有界宽限等待回收，`kill_on_drop(true)` 兜底。
- `SandboxError` 变体与 `code`（`sandbox.rs:1235`、`Display` 在 `:1306`）：

| 变体 | `code` | 触发 |
| --- | --- | --- |
| `Timeout{...}` | `timeout` | 超过 deadline（消息含 pid、timeout_ms、已捕获字节数、前后预览） |
| `WorkdirOutsideRoot{...}` | `workdir` | 覆写 workdir canonical 后不在 root 内 |
| `WorkdirMissing{...}` | `workdir` | 覆写 workdir 不存在 |
| `WorkdirNotDir{...}` | `workdir` | 覆写 workdir 不是目录 |
| `InvalidArg{...}` | `arg` | `timeout_ms` 越界等 |
| `Config{...}` | `config` | 配置非法（cap 为 0 等） |
| `Spawn{...}` | `spawn` | shell 启动失败 |

统一形状：`run_shell-sandbox: code=<code> msg="<转义、截断到 512 字符的消息>"`。
工具层把它原样放进 `ToolOutput.error`，`decision` 仍是 `Allow`（闸门放行了，是执行失败）。

---

## 5. 会话与事件模型

定义：`crates/core/src/session_log.rs`。**日志是唯一真源**，模型可见历史永远由它派生，不单独存储。

### 5.1 `SessionEvent` 全变体

serde 形状是 `#[serde(tag = "type", rename_all = "snake_case")]`，即每行 JSON 形如 `{"type":"turn_start","id":"turn-0"}`。

| 变体 | 字段 | 语义 |
| --- | --- | --- |
| `TurnStart { id }` | `id: String` | 一轮开始 |
| `UserMessage { text }` | `text: String` | 用户输入（含 mailbox 注入的 `[from <label>] ...`） |
| `AssistantMessage { text }` | `text: String` | 模型的最终文本回复 |
| `ThinkingDelta { text }` | `text: String` | 一段**连续**思维链（W252：agent-loop 把连续 delta 聚合成一条，不是每 token 一行）；纯 replay 装饰，**永不进入模型可见历史** |
| `ToolCall { id, name, args, parent_id? }` | `parent_id: Option<String>` | 一次工具调用 |
| `ToolResult { id, value, error, parent_id? }` | `parent_id: Option<String>` | 对应结果；`value` 与 `error` 互斥语义（error 非空时 `derive_messages` 取 error） |
| `TurnEnd { id, outcome }` | `outcome: TurnOutcome`（`#[serde(default)]`） | 一轮结束，携带真实终态 |

兼容性保证：新增字段/变体都是**纯增量**——旧 jsonl 行缺 `outcome` 反序列化为 `Completed`，
缺 `parent_id` 反序列化为 `None`，不认识的 `ThinkingDelta` 之前的老文件照常 replay。

### 5.2 `parent_id` 语义

- `None` = 模型直接发起的调用（`agent-loop` 写）。
- `Some(<父 call id>)` = `run_code` 父 broker 发出的**子调用**，id 形如 `<父 id>:c<n>`。
- 子调用行**留在日志**（`events()` 能看到完整子树，用于审计/replay），但 `derive_messages` 跳过，
  不进入模型上下文（§3.7）。

### 5.3 `TurnOutcome` 五种终态

`crates/core/src/session_log.rs:19`：

| 变体 | 含义 |
| --- | --- |
| `Completed` | 正常结束：模型给出回复且无更多工具调用 |
| `Cancelled` | 协作式取消信号触发，优雅停止（已产出的部分留在日志） |
| `Error { kind, message }` | LLM 生成/流失败；`kind` 为 `"generate"`（`generate()` 返回错误）或 `"stream"`（流中途断） |
| `StepLimit` | `max_steps` 用尽仍未给出最终答复（**预算耗尽不等于完成**） |
| `Interrupted` | 流在终止帧前被撕裂（上游 EOF 无 `[DONE]` 等） |

契约：**每个开始的 turn 恰好以一条 `TurnEnd` 结束**，且终态必须是上述之一，绝不默认伪成功。
agent-loop 在每条退出路径上都写 `TurnEnd`（`crates/agent-loop/src/loop.rs:497`），
并向 sink 恰好发一次 `LoopEvent::TurnEnd(outcome)`。

### 5.4 turn id 单调与 replay 恢复

- 计数器归 `SessionLog` 所有（`next_turn_id()`），**不是** agent-loop——因为 runtime 每轮重建 loop，
  计数器若在 loop 里会重复。格式 `"turn-<n>"`。
- `InMemorySessionLog`：`AtomicU64` 从 0 起，`clear()` **不重置**（已发出去的 id 永不复用）。
- `PersistentSessionLog`：`open` 时从盘上 replay 出的**最大** `turn-<n>` 推 `n+1` 作为起始
  （`persistent.rs:146`），所以重启后不会复用磁盘上已有的 id。

### 5.5 JSONL 持久化与撕裂尾处理

`crates/session/src/persistent.rs`：

- 路径 `<dir>/<sanitized session id>.jsonl`（只保留 `[A-Za-z0-9._-]`，防路径穿越）。
- 一条事件 = 一行 JSON；`PersistentOptions` 默认 `flush_each_append = true`（进程崩溃不丢记录）、
  `sync_each_append = false`（要防掉电再开）。`flush()` / `sync()` 是显式持久化点，`Drop` 尽力 flush。
- **撕裂尾处理**：`open` 时 replay 并校验，保留**最长合法前缀**，从第一条无法解析的记录起
  `set_len(valid_bytes)` 截断——半条记录永远不会被 replay；若文件末尾缺换行，先补一个换行再追加
  （否则下一条会和残缺末行粘成一行）。
- 写失败**不 panic**：事件仍留在内存视图（`derive_messages` 照常工作），失败计数进
  `write_error_count()` 并在 stderr 告警。
- 锁序：`append` / `clear` 都是先 events 写锁再 writer 写锁，避免死锁；append 期间持有 events 写锁，
  读者不会在记录落盘前看到它。

---

## 6. 用量与缓存

### 6.1 `Usage` 字段

`crates/core/src/message.rs:82`：

```rust
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read: u64,        // 缓存命中的 prompt token（各家键名不同，统一到这里）
    pub reasoning_tokens: u64,  // 思维链 token（若 provider 报告）
}
```

配套：`is_empty()`（五项全 0）、`add(&Usage)` / `AddAssign`（逐字段累加）。serde 是扁平的五个字段。

### 6.2 `extract_usage` 兼容的三种缓存字段名

`crates/llm/src/client.rs:518`：

| 目标字段 | 探测顺序 |
| --- | --- |
| `prompt_tokens` | `usage.prompt_tokens` |
| `completion_tokens` | `usage.completion_tokens` |
| `total_tokens` | `usage.total_tokens` |
| `cache_read` | `usage.prompt_cache_hit_tokens`（DeepSeek 扁平）→ `usage.cache_read_input_tokens`（其它）→ `usage.prompt_tokens_details.cached_tokens`（OpenAI 嵌套） |
| `reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens`（嵌套） |

缺失键补 0；五项全 0 时返回 `None`（跳过空 usage 帧）。usage 可能出现在独立的 usage-only 帧或最后一个 chunk。

### 6.3 `UsageTracker`（agent-loop）

`crates/agent-loop/src/loop.rs:56`：

- `record(u)`：`total += u`，同时 `latest = u`。
- `latest()`：最近一次 LLM 流的用量（没有则全 0）。
- `total()`：累计用量。
- 内部是 `std::sync::Mutex<UsageState>`，`&self` 可调用。

### 6.4 runtime 如何把 tracker 挂进 loop

1. `compose` 建 `Arc<UsageTracker>`，用 `DefaultAgentLoop::with_bindings(config, None, None, Some(usage.clone()))`
   建**默认 loop**（供 worker 驱动使用），并提供 `AgentLoopService`。
2. `run_turn` 走的 `make_loop`（`crates/runtime/src/run.rs:28-40`）每轮重建 loop 时同样传入
   `Some(self.usage.clone())`——所以**宿主 turn 与 worker 驱动会话共用同一个 tracker**。
3. loop 在消费 `StreamEvent::Usage(u)` 时调用 `tracker.record(u)`（`loop.rs:358-364`）。
4. 对外：`Runtime::latest_usage()` / `total_usage()`，以及 `Runtime.usage` 字段（Studio 的状态栏直接读它）。

---

## 7. 配置

### 7.1 profile 解析优先级

`resolve_profile(explicit, strict, primary, fallback)`（`crates/runtime/src/config.rs:340`）：

1. 显式路径 `--profile <path>`：**必须存在**，否则报错（不会静默回退）。
2. `./celestea.toml`（`DEFAULT_CONFIG`，TOML）。
3. `./profile.json`（`LEGACY_CONFIG`，JSON；命中会打印一行“使用 legacy”提示）。
4. `~/.celestea/celestea.toml`（home 目录回退；`USERPROFILE` 优先于 `HOME`）。
5. `~/.celestea/profile.json`。
6. 都没有 → `Profile::default()`（打印提示）。

格式按扩展名判定：`.toml` 用 `toml` crate 解析后映射成 JSON 形状，再走**同一套 merge**；
其它扩展名按 JSON 解析。默认 **lenient**：未知键忽略、类型不对回退默认；
`strict`（CLI 的 `--strict` 语义，runtime 侧即 `merge_profile_strict`）则未知键/错类型**硬报错**。
`PROFILE_KEYS` 常量（`config.rs:65`）就是 strict 的已知键白名单。

### 7.2 全部配置键（12 个）

`Profile`（`config.rs:14`）字段与 `PROFILE_KEYS` 一一对应：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `model` | string | `deepseek-chat` | 模型名，仅要求非空（provider 自定目录） |
| `system_prompt` | string | `You are celestea, an AI agent. You are concise, accurate and direct.` | 系统提示词（与 `AgentConfig::default` 保持一致的身份） |
| `max_steps` | integer | `16` | 单轮最大步数；**0 = 不限步数** |
| `max_parallel_tool_calls` | integer | `4` | 一批工具调用的并发上限（`.max(1)`，0 视作 1） |
| `context_window_tokens` | integer | `1000000` | 上下文窗口 token；**0 = 关闭裁剪** |
| `context_trim_threshold` | number | `0.8` | 触发裁剪的窗口占比，必须 ∈ [0.0, 1.0] |
| `context_keep_recent` | integer | `10` | 裁剪时保留的最近消息条数（System 消息始终保留） |
| `base_url` | string | 无（回退 env / provider 默认） | 覆盖 API base URL |
| `reasoning_effort` | string | 无 | **自由字符串**，见 §7.3 |
| `max_output_tokens` | integer (u32) | 无 | 输出 token 上限 |
| `api_key_env` | string | `DEEPSEEK_API_KEY` | 存放 key 的环境变量名（token 值不落盘） |
| `api_key_file` | string | 无 | key 文件路径（trim 后作为 key；env 未设/为空时生效） |

> 与 README 的差异：README 仍写“配置键（9 个）”，实际是 12 个（缺 `context_window_tokens` /
> `context_trim_threshold` / `context_keep_recent`）——见 §10。

### 7.3 `reasoning_effort`：自由字符串透传（W260）

- 类型是 `Option<String>`，**不是枚举**；`config.rs:195-213` 只做两件事：`trim()`；
  空串或大小写不敏感的 `"off"` → `None`（清除覆盖），其它任何非空标签**原样保留**。
- 透传路径：`Profile.reasoning_effort` → `DeepSeekConfig.reasoning_effort` → `DeepSeekLlm.request_body`
  （`crates/llm/src/client.rs:167-175`）：先按 typed request 序列化，再
  `body["reasoning_effort"] = Value::String(effort.clone())` 注入。
- 因此 `low` / `medium` / `high` / `max` / 任意 provider 自定义档位都**不改名、不折叠、不设上限**地到达上游。
  注释明确记录了这一点（`crates/llm/src/config.rs`：“FREE-FORM (Option<String>, verbatim passthrough)”）。
- 注意：`deepseek-chat` 是否接受该字段由上游决定；引擎不做模型能力校验。

### 7.4 API key 的三条路径

`resolve_api_key`（`config.rs:432`），按优先级：

1. env[`api_key_env`]（默认 `DEEPSEEK_API_KEY`）——非空即用（trim）。
2. `api_key_file`——读文件、trim，非空即用；文件存在但 trim 后为空 → 报错。
3. 都没有 → 硬错误，消息里点名缺失的变量与可用替代。

另外 `load_dotenv()`（`config.rs:420`）在启动时尽力加载 `./.env` 与 `~/.celestea/.env`（失败静默）。
**token 值永远不写进 profile、不写进日志、不写进任何响应**；`DeepSeekConfig` 的 `Debug` 把 `api_key`
打印为 `"<redacted>"`（`crates/llm/src/config.rs`）。

### 7.5 环境变量总表

下表由源码常量/字面量汇总（`crates/**`）。注意仓库里**两种前缀并存**：`CELESTEA_*` 与 `CELAESTEA_*`
（后者拼写如此，属历史命名，见 §10）。

**模型 / 会话**

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | 默认 `api_key_env` 指向的 key（可用 profile 改指向别的变量） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | base_url 回退（profile 优先） |
| `CELESTEA_SESSION_DIR` | 未设（内存日志） | 设置后宿主会话改用 `PersistentSessionLog`，落盘 `<dir>/cli-main.jsonl` |

**工具闸门 / HTTP**

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CELESTEA_TOOL_ROOTS` | 空 | `read_file`/`list_dir` 额外可读根（`PATH` 风格分隔） |
| `CELESTEA_TOOL_WORKDIR` | 进程 cwd | 路径 guard 的 workspace 覆盖 |
| `CELESTEA_TOOL_GUARD` | 挂载 | `0`/`off` 跳过 guard 挂载（打印告警；不削弱沙箱/HTTP 策略） |
| `CELESTEA_HTTP_ALLOW` | 未设（全放行） | http_request 目标 IP/CIDR 允许列表 |
| `CELESTEA_HTTP_DENY` | 空 | http_request 目标 IP/CIDR 拒绝列表（解析失败 fail-closed） |

**run_shell / 沙箱**

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CELAESTEA_RUN_SHELL_TIMEOUT_MS` | `30000` | 默认超时 |
| `CELESTEA_SHELL_MAX_TIMEOUT_MS` | `300000` | per-call `timeout_ms` 上限 |
| `CELAESTEA_RUN_SHELL_MAX_OUTPUT_BYTES` | `65536` | 每流输出上限 |
| `CELAESTEA_RUN_SHELL_WORKDIR` | 进程 cwd | 固定工作目录 |
| `CELAESTEA_RUN_SHELL_ROOT` | git top-level / workdir | workdir 必须落在其中的根 |
| `CELAESTEA_RUN_SHELL_OS_SANDBOX` | 自动探测 | `off` / `bwrap` / `raw` |
| `CELESTEA_SANDBOX_NET` | `0`（隔离） | `1` = 共享宿主网络 |
| `CELESTEA_SANDBOX_SHARE_TMP` | `0`（私有 tmpfs） | `1` = 挂宿主 `/tmp` |
| `CELESTEA_SANDBOX_SECCOMP` | `0` | `1` = 启用 seccomp 白名单 |
| `CELAESTEA_RUN_SHELL_V2_SECCOMP` | `0` | 旧名，等价于上面 |
| `CELAESTEA_RUN_SHELL_V2_TMPFS_TMP` | `1` | 废弃别名：`1` tmpfs / `0` 宿主 /tmp |
| `CELAESTEA_RUN_SHELL_V2_CPU_SEC` | `20` | `RLIMIT_CPU` 秒 |
| `CELAESTEA_RUN_SHELL_V2_MEM_MB` | `2048` | `RLIMIT_AS` MiB |
| `CELAESTEA_RUN_SHELL_V2_NPROC` | `512` | `RLIMIT_NPROC` |
| `CELAESTEA_RUN_SHELL_V2_FSIZE_MB` | `256` | `RLIMIT_FSIZE` MiB |
| `CELAESTEA_RUN_SHELL_V2_NOFILE` | `256` | `RLIMIT_NOFILE` |
| `CELAESTEA_RUN_SHELL_V2_CORE` | 禁 core | `0` = 允许 core dump |

**run_code**

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CELAESTEA_RUN_CODE_TIMEOUT_MS` | `120000` | 整体墙钟默认值（clamp 到 `[1, 120000]`，cap 不可调） |

**其它（非引擎开关，供参考）**

| 变量 | 作用 |
| --- | --- |
| `HOME` / `USERPROFILE` | `~/.celestea` home 配置目录与 `.env` 定位 |
| `PATH` / `LANG` / `LC_ALL` / `LC_CTYPE` / `LC_MESSAGES` / `TERM` | 沙箱环境白名单（唯一会传给子进程的宿主变量） |
| `CARGO_HOME` / `RUSTUP_HOME` / `CARGO_HTTP_PROXY` / `HTTPS_PROXY` | 构建期，见 §8.1 |

布尔解析规则（`env_flag`，`sandbox.rs:358`）：`1|on|true|yes` = 真，`0|off|false|no` = 假，其它取默认值。

---

## 8. 构建与测试

### 8.1 构建环境

本机工具链**不在默认 PATH**，需要显式导出（实测值）：

```bash
export RUSTUP_HOME=/opt/rustup
export CARGO_HOME=/opt/cargo
export PATH=/opt/cargo/bin:$PATH

# 需要走代理拉依赖时（本仓库依赖已缓存于 /opt/cargo/registry，通常不必）
export CARGO_HTTP_PROXY=http://<proxy-host>:<port>
export HTTPS_PROXY=http://<proxy-host>:<port>

cargo --version   # cargo 1.98.0 (797e8a9bc 2026-08-05)
rustc --version   # rustc 1.98.0 (88d9e12ae 2026-08-18)
```

常用命令：

```bash
cargo build --workspace                 # 全量编译
cargo test  --workspace                 # 全量测试
cargo test  -p celestea-tools           # 只跑工具 crate
cargo test  -p celestea-tools run_code  # 只跑 run_code 相关用例
cargo test  --workspace -- --nocapture  # 看 eprintln 日志（含 [bench] 行）
```

CI 见 `.github/workflows/ci.yml`（push/PR 跑 `cargo test --workspace`）与
`.github/workflows/release.yml`（`v*` tag 构建三平台产物）。

### 8.2 当前测试覆盖与真实用例数

2026-09-09 实测 `cargo test --workspace`：

| target | 用例数 | 结果 |
| --- | --- | --- |
| `celestea-agent-loop`（unit） | 35 | ok |
| `celestea-core`（unit） | 26 | ok |
| `celestea-llm`（unit） | 38 | ok |
| `celestea-runtime`（unit） | 69 | ok |
| `celestea-session`（unit） | 50 | ok |
| `celestea-tools`（unit） | 85 | ok |
| `run_code_e2e`（integration） | 1 | ok |
| `celestea-workers`（unit） | 43 | ok |
| **合计** | **347 passed / 0 failed** | 另 **1 ignored**（`celestea-tools` 的 `run_code_tool_with_handle` doc-test 被 `ignore`） |

> 上表是**本机实跑**数字，不是抄旧文档。测试并行跑，整体耗时约 2 秒（含 sandbox/python 用例）。

覆盖重点（挑代表）：seam 往返（Context/EventBus/LlmRegistry）、工具 dispatch 与 guard 拒绝形状、
沙箱超时/降级/rlimit、后台进程生命周期与完成回执、run_code 协议回环与限额、会话 replay 与撕裂尾、
turn 终态与取消、usage 提取与累加、worker 状态机/看门狗/registry.tsv 原子读写。

### 8.3 如何加测试

1. **单元测试**：在实现文件底部加 `#[cfg(test)] mod tests { use super::*; ... }`。这是本仓库的主流做法
   （几乎每个模块都有）。异步用例用 `#[tokio::test]`，需要多线程时
   `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`。
2. **集成测试**：`crates/<crate>/tests/<name>.rs`（只能用该 crate 的公开 API）。
   范例：`crates/tools/tests/run_code_e2e.rs`——用真实 builtin 注册表 + `run_code` Weak 回引做端到端。
3. **环境相关用例要能优雅跳过**：fork 受限、python3 不可用等环境问题时 `eprintln!("skip: ...")` 后 `return`，
   不要 fail（见 `crates/tools/src/lib.rs:307-315`、`run_code.rs:1122` 的 fork-health 探测）。
4. **临时目录命名**：用 `std::env::temp_dir().join(format!("celestea-<module>-{tag}-{}", std::process::id()))`，
   测试结束清理；涉及 registry.tsv 的用例必须用独立临时路径，避免并行互踩。
5. **不要依赖网络**：LLM 一律用 `FakeLlm` / `EventLlm` 之类的假实现（`crates/agent-loop/src/lib.rs:87-140`）；
   HTTP 用本地 `TcpListener` 起的假服务器（`crates/tools/src/lib.rs:546`）。
6. **改契约要同步改断言**：`ToolSpec` 形状、`SessionEvent` serde 形状、结构化错误前缀
   （`run_shell-sandbox:` / `toolguard:` / `run_code:` / `http_request:`）都有测试钉住。

---

## 9. 与 Studio 的集成

Studio（`/src/celestea_studio`）是引擎的 Web 前端，**通过 path 依赖嵌入引擎**，不是独立进程。

### 9.1 path 依赖

`/src/celestea_studio/Cargo.toml`：

```toml
celestea-runtime    = { path = "/src/celestea_harness/crates/runtime" }
celestea-core       = { path = "/src/celestea_harness/crates/core" }       # Content / ToolDecision
celestea-agent-loop = { path = "/src/celestea_harness/crates/agent-loop" } # UsageTracker
# dev-dependencies 另有 celestea-session（测试用真实 SessionRegistry）
```

所以 Studio 与引擎**共用同一份源码**，不存在版本漂移；但也意味着：

> **引擎改动必须在 Studio 侧重新 `cargo build` 并重启服务才生效。**
> 只改 harness 仓库不会热更新正在运行的 Studio 进程。

Studio 的装配入口是 `build_gen` / `prepare_gen`（`/src/celestea_studio/src/main.rs:397`、`:413`）：
合并 profile →（可选）把 API key 注入进程环境 → `Runtime::compose(&profile)` → 包成 `Gen`。

### 9.2 worker 闭环

```
spawn_worker(wid, brief, report_to)
   ├─ SessionRegistry::create  → 子会话（独立 SessionLog）
   ├─ 命名 <wid>·<短名>，写 registry.tsv（/tmp/celestea-workers-registry.tsv，proc= 标记归属）
   └─ WorkerRegistry::drive_if_possible(sid, brief)
        └─ tokio 后台任务（JoinSet 跟踪）：
             为 worker 建独立 Context（Llm/ToolRegistry 共享宿主，SessionService 指向自己的 log）
             → 跑一轮 brief turn
             → 机械回执：写 results/<wid>-<short>.md
                          + mailbox.send(report_to, "WORKER_<wid>_DONE|_FAILED ...", from=<worker sid>)
             → 阻塞在 mailbox.recv(sid)
                每条消息 → 以 content 为输入再跑一轮 turn（同一 worker 串行）
             → 直到 stop_driver(sid) / abort_all_now() 才退出
```

- **registry.tsv 契约行**：`wid \t started_at \t status \t extra`（`crates/workers/src/types.rs`）。
  `status ∈ RUNNING | DONE | FAILED`；`extra` 是空格分隔的 `k=v` token（`sess=`/`ws=`/`title=`/`driven=`/
  `proc=`/`state=in-turn|idle`/`retries=` 等）。写表是**原子替换**：先写同目录 `*.tmp-<pid>-<seq>` 再 rename。
- **交付物判定**：看门狗（`crates/workers/src/watchdog.rs`）默认每 30s 巡检，交付物目录
  `/server-center/runtime/worker-exec/results`，匹配 `results/<wid>-*.md`；宽限 10min，重派上限 2 次。
  （`WorkerRegistry::results_dir()` 默认是相对的 `"results"`，由嵌入方 `set_results_dir` 注入真实目录。）
- **回执格式**：`WORKER_<wid>_DONE OK 报告 <rel>（完成）` /
  `WORKER_<wid>_FAILED ERR <摘要> 报告 <rel>（失败：<摘要>）`，尾部可选 ` 答复: <最后一条 AssistantMessage
  的文本摘要>`（约 200 字符、换行折叠）。
- 宿主侧消费：`Runtime::run_turn` 每轮开头 drain `cli-main` mailbox（`run.rs:65-72`），
  把回执作为 `UserMessage` 注入宿主日志——Studio 的 autowake 循环随后自动唤醒 agent 新一轮。

### 9.3 `swap_gen`：换代时迁移未消费消息

`/src/celestea_studio/src/main.rs:429`。Studio 热切换（改模型/配置/prompt）时：

1. 先构造好新 `Gen`（`prepare_gen` → `Runtime::compose`）。
2. 在**替换写锁内**、旧 `Runtime` 被 drop 之前，从旧 gen 的 `WorkerRegistry` mailbox 里
   `poll("cli-main")` 取出所有 pending 消息（worker → 宿主的回执），逐条
   `send("cli-main", content, from_label)` 到**新** gen 的 mailbox。
3. 计数 >0 时打印 `swap_gen: migrated N pending host receipt(s) to the new generation`。
4. `gen_epoch.send_modify(|e| *e += 1)` 通知 autowake 循环：它正阻塞在旧代 mailbox 上，
   需要丢弃旧订阅、重新绑定到新代（`main.rs:1061`、`:1571`）。
5. 最后 `drop(old)` → 旧 `Runtime` 的 `Drop` 执行 `shutdown_now()`（abort 驱动、杀进程、purge mailbox、清会话）。

**为什么必须先迁移**：旧 gen 的 `Runtime::shutdown` 会 `purge_all()` 掉 mailbox；旧 gen 里仍在跑的 worker
随旧 runtime 一起被 shutdown，它们**已经发出的回执**如果还在旧 mailbox 队列里，就会一起被丢弃。
先 poll 再迁移，回执就不会在换代瞬间丢失。

**顺序不可颠倒**：`swap_gen` →（迁移）→ `gen_epoch` → `drop(old)`。若先 drop 旧 gen，`purge_all` 已经把消息清掉，
迁移就取不到任何东西了。

---

## 10. 核对代码时发现的文档 / 代码不一致

以下均为本次逐文件核对中发现、**代码是对的、文档过时**或**注释与常量不一致**的点，供后续修订：

| # | 位置 | 不一致 |
| --- | --- | --- |
| 1 | `README.md`（安装段） | 仍写 `cargo install --path crates/cli`、产物 `target/release/celestea`——**仓库已无 `crates/cli`**（W214 删除 CLI，能力下沉到 `celestea-runtime`）。 |
| 2 | `README.md`（用法段） | 写“内置工具共 7 个”“配置键（9 个）”——实际工具面 **10 个**、profile 键 **12 个**（缺 `context_window_tokens`/`context_trim_threshold`/`context_keep_recent`）。 |
| 3 | `README.md`（配置表） | `system_prompt` 默认写作 `You are a helpful assistant.`；代码 `Profile::default` 与 `AgentConfig::default` 都是 `You are celestea, an AI agent. You are concise, accurate and direct.` |
| 4 | `README.md`（配置表） | `reasoning_effort` 写作 `low` / `medium` / `high` 三档；W260 已改为**自由字符串透传**，任意非空档位原样发送。 |
| 5 | `ARCHITECTURE.md`（`## CLI (crates/cli)` 一节） | 整节描述的 CLI crate 已不存在。 |
| 6 | `ARCHITECTURE.md`（`## Environment`） | 只列 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`，漏掉全部约 25 个 `CELESTEA_*` / `CELAESTEA_*` 开关（本文 §7.5 已补全）。 |
| 7 | `crates/tools/src/sandbox.rs:1131-1133` | `SandboxConfig::new` 的文档注释写“30s timeout / **120s** per-call cap”，实际常量 `DEFAULT_MAX_TIMEOUT = 300s`（`sandbox.rs:86`）。 |
| 8 | 全仓库命名 | 环境变量前缀不统一：`CELAESTEA_*`（sandbox / run_shell / run_code，拼写为 CELAESTEA）与 `CELESTEA_*`（tools guard / http / session / shell-max-timeout）并存。历史遗留，改动会破坏兼容，建议文档明确、代码保留。 |
| 9 | `crates/core/src/agent.rs` vs `crates/runtime/src/config.rs` | 两处默认 `context_window_tokens` 不同：`AgentConfig::default` 是 `65_536`，`Profile::default` 是 `1_000_000`。compose 用 profile 值，所以生产路径是 1M；直接构造 `AgentConfig::default` 的嵌入方拿到 64K。 |
| 10 | `crates/runtime/src/compose.rs:313` 注释 | 注释写“六 builtin + 三 worker + run_code = 10”，紧邻的另一个测试名是 `tools_registration_surfaces_all_nine`（9，不含 run_code）——两者都对，只是容易误读；已在 §1.7 说明。 |
| 11 | 仓库文档清单 | 任务/README 语境中提到的 `docs/prompt-injection-eval.md` **在仓库中不存在**（`docs/` 实际只有 5 个评估文档 + 本文两份）；引用它的链接已从本文移除。 |

**验证记录**（本文档声称的可复现事实）：

- `cargo test --workspace` 实跑：347 passed / 0 failed / 1 ignored（§8.2）。
- §3.8 的三段 Python 示例：用 `run_code.rs` 中真实的 `RUN_CODE_SDK` + `RUN_CODE_RUNNER` 拼装程序，
  配一个模拟 broker（按协议回 JSON），实测得到注释里写的结果——覆盖直接调用、`await`、`_AttrDict`
  属性/下标、`ToolCallError` 捕获四条路径。
- 工具数量、turn 终态、env 变量名、compose 顺序等均以源码行号为准逐条核对。

---

## 附录：关键文件索引

| 主题 | 文件 |
| --- | --- |
| seam 定义 | `crates/core/src/{context,plugin,event_bus,message,llm,session_log,tool,agent}.rs` |
| 装配 / 生命周期 | `crates/runtime/src/{compose,run,config,tools,summary}.rs` |
| 工具注册与 guard | `crates/tools/src/{registry,guard}.rs` |
| 内置工具 / 沙箱 / 进程 / HTTP | `crates/tools/src/{builtin,sandbox,process,http}.rs` |
| run_code | `crates/tools/src/run_code.rs`、`docs/run-code-sdk.md` |
| 会话日志 / 持久化 / mailbox | `crates/session/src/{log,persistent,mailbox,registry}.rs` |
| agent loop / 上下文裁剪 / 用量 | `crates/agent-loop/src/{loop,context,events}.rs` |
| worker 编排 | `crates/workers/src/{registry,tools,watchdog,plugin,types}.rs` |
| LLM provider | `crates/llm/src/{client,config,registry}.rs` |
| Studio 集成点 | `/src/celestea_studio/src/main.rs`（`build_gen`/`prepare_gen`/`swap_gen`/autowake） |
