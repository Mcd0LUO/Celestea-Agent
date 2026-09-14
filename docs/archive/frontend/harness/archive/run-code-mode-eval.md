# run_code 折叠机制评估（W254）：多语言程序化工具执行模式是否值得 Celestea 借鉴

> 📦 历史文档（2026-09-11 归档）：描述的是 run_code 折叠机制落地前的评估与决策过程（W254），实现已在引擎落地，评估本身属历史。当前权威入口见 [../run-code-sdk.md](../run-code-sdk.md)。

> 状态：只读调研 + 设计评估（不写代码、不改引擎仓其他文件、不 push）。
> 前置阅读：`docs/archive/dsh-ptc-mode-eval.md`（W253，PTC 三层拆解）。本文是 W253 §1.2 / 判定行 N1 的**定向深挖**：W253 已判定"不抄完整 L2"，本文回答的是——**若只做最小闭环（Python + 复用现有沙箱），结论是否会被推翻**。
>
> 一句话结论：**完整版仍不抄；但"简化版"（仅 Python SDK + parent-broker 走 stdin/stdout JSON-lines，复用 ToolRegistry/ToolGuard/三层沙箱）成本从 W253 估计的 1–2 人月降到 4–6 人日，且 token/墙钟收益在典型多步任务上量化成立，值得在 P0 最小闭环上做实证验证后再决定去留。** 是否开工取决于 §10 决策清单第 1 题（往返成本痛点是否真实存在，需先度量）。

---

## 1. 调研范围与事实来源

DSH 侧（`/opt/dsh/profiles/web/node_modules/@deepseek-ai/`，只读）：

| 包 | 作用 | 关键位置（lib/index.js） |
|---|---|---|
| `dsh-agent-tool-presentation` | preset 行 `mode: native|ptc|both`；ptc 需 `codeRuntime` 服务，缺失则挂载期即报错 | 全文件 51 行 |
| `dsh-tools` | 工具注册表：PTC_ONLY 规则段、run_code 保留名、SDK 投影（TS/Python）、子调用调度器、折叠强制 | 887–1381（ptc 传输）、1593–1658（TS SDK）、2308–2365（Python SDK）、2421（PTC_ONLY）、2557–2608（maxParallelSubCalls）、2770–2801（保留名）、2952–2958（executionMode）、2994–2995（collapses）、3068–3078（折叠拒绝） |
| `dsh-code-runtime` | 运行时 seam：绑定全局保留名清单、跨语言保留字、错误类成员规则 | 28–140 |
| `dsh-code-runtime-worker-thread` | **唯一随包发布的后端**：worker 线程运行时、类型剥离、输出账本、四重限额 | 456–640（账本/限额）、648–941（执行循环） |
| `dsh-code-runtime-worker-thread/lib/worker.cjs` | worker 引导：`new AsyncFunction(...globals, "console", code)` 注入绑定 + console shim | 630–895 |

Celestea 侧（`/src/celestea_harness/crates/`，只读）：

| 位置 | 事实 |
|---|---|
| `tools/src/builtin.rs` | 6 内置工具 read_file/write_file/list_dir/run_shell/process_control/http_request；run_shell 有 background/notify/进程注册表 |
| `tools/src/sandbox.rs` | 三层沙箱 bwrap→raw→userspace；rlimit（CPU/AS/NPROC/FSIZE/NOFILE/CORE）；默认断网 + /tmp 私有 tmpfs；`spawn_sandboxed` 提供**活 stdin/stdout/stderr 管道**；环境白名单（PATH/LANG/LC_*/TERM，排除 HOME/密钥类）；默认超时 30s、上限 300s（env 可调） |
| `tools/src/guard.rs` | PathGuard 路径白名单（read_file/list_dir/write_file），`mount_production_guards` 生产接线，`CELESTEA_TOOL_GUARD=0` 逃生门 |
| `tools/src/registry.rs` | `ToolRegistryImpl::dispatch` = 守卫链（首个非 Allow 短路）→ 工具执行，错误捕获不抛出 |
| `core/src/session_log.rs` | SessionEvent：TurnStart/TurnEnd(outcome)/UserMessage/AssistantMessage/ThinkingDelta/ToolCall{id,name,args}/ToolResult{id,value,error}；`derive_messages` 是模型可见投影 |
| `agent-loop/src/loop.rs:436-484` | 工具派发流程：先 append 全部 ToolCall → 按 max_parallel_tool_calls 分批 dispatch → append ToolResult |
| `session/src/persistent.rs` | 每会话追加式 jsonl，flush_each_append 默认开 |
| `workers/src/lib.rs` | 3 worker 工具 spawn_worker/session_send_message/worker_status（+ registry.tsv/watchdog） |
| Cargo.toml | **引擎无 HTTP 服务端依赖**（只有 reqwest 客户端）——loopback 方案需新增依赖 |

宿主环境实测：`python3` 3.14.4 与 `node` v24.19.0 均可用；沙箱内可见性取决于 bwrap 根挂载（与 run_shell 运行任意二进制同前提，见 §4.4）。

---

## 2. 机制拆解：DSH run_code 逐环节

### 2.1 呈现层：一张注册表，三种投影

- preset 只加一行 `tool-presentation`（`mode: ptc`）；插件在挂载期要求 `codeRuntime` 服务存在，**缺失则挂载失败**（不是首个 prompt 才炸）。
- `mode: ptc` 下注册表对模型的投影 = 唯一工具 `run_code`；`mode: both` 下 native schema 与 SDK 段并存；`mode: native` 无 SDK 段。
- 规则段 `PTC_ONLY`（order 800）原文（`dsh-tools:2421`）：*"`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program."* 只在 `ptc` 下渲染。
- 引擎强制与提示词双保险：`collapses(name, scope, nested)`（`:2994`）在派发入口判定——模型直调非 run_code 工具时返回 `ToolNotFoundError` 并附引导文案"call `x` from inside a run_code program instead"（`:3077`）；带 parent token 的嵌套子调用**绕过**折叠。`run_code` 是保留名，禁止注册/遮蔽/进 restrict 名单（`:2781/:2801`）。

### 2.2 程序如何拿到 SDK：每次组装的代码生成

- `TOOLS_SDK` 段（order 5000）是**每次组装按当前 scope 现算的纯函数输出**：同一注册表 store → 两种语言投影（`SDK_RENDERERS = {typescript, python}`，`:2422`）。工具按名字典序排序，同一工具集输出字节级确定（缓存友好）。
- TS 投影：`interface ToolArgsMap` / `ToolOutputMap` + `declare const tools: {[K in ToolName]: (args) => Promise<Output>}` + `ToolCallError` 类声明（`:1642-1657`）。jsonSchema→TS 支持全部统一 schema 构造，坏输入降级 `unknown` 不抛。
- Python 投影：每工具（及嵌套对象）一个命名 `TypedDict` + `class Tools(Protocol)` + `tools: Tools` 单例；契约明说 **TypedDict 是静态 stub、运行期不存在**，参数用普通 dict/list 构造（`:2310`）；非法标识符（保留字/下划线开头/Unicode 边界）走 `tools["name"]` 下标访问路径（`:2349-2358`）。注释自述"光 Python 投影的标识符/NFKC/关键字边界处理就写了 60 行注释"（W253 §1.2 已引）。
- **运行期绑定不是这段文本**：真正注入的是 worker 引导里 `new AsyncFunction(...namespaceGlobals, "console", code)`（`worker.cjs:887`）——`tools` 全局对象是宿主逐工具构造的闭包桥（见 2.3），`ToolCallError` 是注入的错误类（`memberNameProperty: "toolName"`）。
- run_code 工具 schema：`code`（async 函数体，erasable syntax only——类型注解运行前剥离）+ `description`（5–10 词主动语态，UI 卡片标题用）。

### 2.3 程序如何调用工具：消息协议 + 同管线子派发

一次 `tools.name(args)` 的完整链路：

1. 程序内调用 `tools` 绑定的方法 → worker 通过 MessagePort 向宿主发 `{type:"call", global, name, args}`（结构化克隆、id 幂等去重）。
2. 宿主 `onCall`（`dsh-code-runtime-worker-thread:820-879`）按 `bindings.get(global).functions[name]` 找到桥函数；参数必须 lossless JSON，否则结构化回错。
3. 桥函数（`dsh-tools:1207-1313`）→ **走注册表同一套调度器** `registry[TOOL_RUNTIME_SCHEDULER]`：`prepare → dispatch → finalize/finish`。**这意味着与直调完全相同的管线**：参数 schema 校验、pre/guard/around/post 策略、输出校验、沙箱策略——全部内建复用，DSH 不需要为子调用单独写一道 guard。
4. 结果回 worker：`{type:"reply", id, ok, value|message}`；失败 reject 为 `ToolCallError`（程序可 try/catch 继续）。
5. 并发与顺序由**宿主侧单车道队列调度器**保证（`:1146-1200`）：FIFO 排队 + 提交队列；`executionMode` 按工具 `isConcurrencySafe(args)` 判定 `parallel | exclusive`（`:2952`）——只读安全调用可并发（上限 `maxParallelSubCalls`，默认 10），变更型调用独占运行、按提交顺序；外层 abort（取消/预算耗尽）级联：排队项 abandon、在飞项跑完丢弃、run 后到调用直接拒绝。
6. 子调用 id：`<run_code callId>:code:<n>`（branded string，`:1211`）——供事件关联与回放。

### 2.4 结果如何回流与截留

- 程序输出 = `console.log` 日志 + `return` 值（lossless JSON）；run_code 的 ToolResult 规范值是 `{logs: string[], result?: json}`，渲染为 `logs.join("\n") + 渲染值`，全空则 `"(run_code completed with no output)"`（`:1101-1121`）。
- **截留契约**（SDK 段原文 `:1601`）：只有 print/return 的内容进会话上下文；"every other intermediate result stays out of the conversation, so extract just what you need"；唯一例外是含图片的子工具结果——`exec.deferContext` 在 run 结束后附加，供下一步查看（`:1295-1301`）。
- 程序失败（异常/预算/中止/worker 死亡）→ `CodeRunFailedError`（code: `CODE_RUN_FAILED`），消息带失败 kind + 捕获日志尾部（`:1342-1344`），模型可据此自纠。

### 2.5 隔离与计量（`dsh-code-runtime-worker-thread`）

| 维度 | 机制 |
|---|---|
| 语言 | TypeScript（erasable syntax），`node:module stripTypeScriptTypes` 剥离后执行（`:699`）；Python flavor 的运行时是**私有 CPython 子进程后端，未随开源树发布**（`dsh-code-runtime:60-66` 注释明说 "experimental, private"） |
| 进程隔离 | 每次运行一个新 `Worker`，`env: {}`、`execArgv: []`、`resourceLimits.maxOldGenerationSizeMb`（默认 512MB） |
| CPU | `computeMs` 默认 60s：25ms 轮询 `eventLoopUtilization` 的**忙时**预算（`:910-915`）；`maxWallMs` 默认 600s 墙钟 |
| 输出 | `maxOutputBytes` 默认 64MiB **字节级账本**：逐条 log + 最终值按 lossless-JSON 序列化字节精确计量，超限截断保留前缀并报 `output-limit`（`OutputLedger :573-640`；连 stdout/stderr 旁路管道都计量 `:760-774`） |
| 绑定名 | 保留全局 `console/__dsh_main__/__builtins__/__name__/__debug__`；跨语言保留字 = ECMAScript ∪ Python 关键字全并集（`dsh-code-runtime:68-140`）；错误类成员拒绝 dunder 与 JS/Python 协议成员——**一份清单保证两语言可移植，代价是加语言要扩并集** |
| 终止 | abort signal 即时生效；服务 teardown 时 settle 全部在飞 run 为 aborted 并 `await` worker 退出 + 管道排干（`:673-681`） |

### 2.6 会话记录：子调用全落日志，但不进模型历史

- 每个子调用 settle 时 append `tool/code-dispatch-start`（开始时）与 `tool/code-dispatch`（结束时）事件，携带 `rootCallId/parentCallId/subCallId/name/arguments/isError/content`（`:1243-1251/:1265-1271`）——**日志可完整重建程序行为**，与 2.4 的上下文截留互补（模块注释 `:888-890`："logged for reconstruction, while only the outer curated result enters model history"）。
- 日志内容经 `tools/ptc-dispatch-log` waterfall 钩子整形（第三方可做脱敏/截断，`:2962-2977`）。
- 设计动机（源码注释明说，W253 已引）：把 5 次往返的序列变成一次往返；代价是 native schema 从请求里删掉后 SDK 成为参数/输出形状**唯一**来源——这是投影做得重的**原因**（一致性），不是省 token 的手段。

### 2.7 对 Celestea 最重要的三个结构事实

1. **子调用与直调共用同一执行管线**（guard/policy/校验零重复建设）——Celestea 的 `ToolRegistryImpl::dispatch`（守卫链→工具）正是同构物。
2. **运行时与工具注册表解耦**：`dsh-code-runtime` 契约明确"runtimes know nothing about tools or sessions"——Celestea 若做，也应把"沙箱内跑程序"与"程序内工具桥"分成两层。
3. **Python 后端是私有实验件，开源树只有 TS worker-thread**：DSH 自己都没把 Python 运行时工程化到发布级，Celestea 选 Python 做 parent-broker 时没有现成 DSH 代码可抄，只能抄**协议形态**（call/reply id 配对、截留契约、限额维度）。

---

## 3. Celestea 现状盘点（承接点）

- **9 工具**：read_file/write_file/list_dir/run_shell/process_control/http_request（`tools/src/builtin.rs`）+ spawn_worker/session_send_message/worker_status（`workers/src`）。
- **run_shell 三层沙箱**：bwrap（namespaces+只读根）→ raw → userspace v1，rlimit（CPU/AS/NPROC/FSIZE/NOFILE/CORE=0），默认断网、/tmp 私有 tmpfs、可选 seccomp，超时 30s/上限 300s，输出字节 cap，生效层在结果里显式回报（`sandbox` 对象）。**关键承接点**：`spawn_sandboxed` 已经支持活 stdin/stdout/stderr 管道（background 路径为 process_control 预留）——parent-broker 直接复用。
- **ToolGuard**：守卫链在 `dispatch` 内、工具执行前，首个非 Allow 短路；PathGuard 生产接线（路径白名单）；判定写入 `ToolOutput.decision`。
- **SessionEvent**：ToolCall{id,name,args}/ToolResult{id,value,error}，追加式 jsonl（`serde(tag="type")`、无 deny_unknown_fields → **加可选字段是纯增量**），`derive_messages` 是唯一模型可见投影；agent-loop 先 append 全部 ToolCall 再派发（确定性日志序）。
- **引擎无 HTTP 服务端依赖**（只有 reqwest 客户端）——loopback 方案要新增 axum/hyper。

---

## 4. Celestea 适配设计（若做）：两个可行方案

### 4.1 方案 A：父进程经纪人（parent-broker，推荐）

```
run_code(code, description)
  │ 引擎（父进程，Rust）
  │ ① 校验 → 把 code 写入沙箱 workdir（.celestea/run_code_<n>.py）
  │ ② spawn_sandboxed("python3 -u <程序>")   ← 复用三层沙箱 + rlimit + 默认断网（stdin_piped 已有）
  │ ③ 沙箱内 SDK（引擎注入的 ~120 行 Python 常量文本，embed 在 crate 里）
  │     程序: await tools.read_file({"path": ...}) ...
  │     SDK 把每次调用编码成 stdout 一行 JSON-RPC 请求: {"id":1,"tool":"read_file","args":{...}}
  │ ④ 父进程逐行解析 → registry.dispatch(ToolInput{call_id:"<rid>:c1", name, args})
  │       ← 同一守卫链（PathGuard 等全部复用）
  │ ⑤ 结果行写回程序 stdin: {"id":1,"ok":true,"value":...} | {"id":1,"ok":false,"error":...}
  │     SDK resolve 返回值 / 抛 ToolCallError（toolName=子调用工具名）
  │ ⑥ 程序结束（SDK 发 {"op":"done","value":...} 或进程退出）
  │     父进程汇总 {logs: print 行, result}；子调用事件已在 ④ 落 SessionEvent（带 parent_id）
```

- **无 HTTP、无端口、无 token**：沙箱内程序天然不知道父进程的任何网络面；管道是进程边界，协议面最小。
- **Guard 复用**：子调用走与直调**完全相同**的 `dispatch`，PathGuard/未来守卫零改动生效。
- **限额**（父进程侧全控）：子调用数上限（P0 建议 20）、每子调用超时（复用 run_shell 30s）、整 run 墙钟（P0 建议 120s，独立 env `CELAESTEA_RUN_CODE_*`）、输出账本（逐行累积 stdout 字节 + 最终值，超限截断报 `output-limit`——DSH 账本的简化版）。
- **SDK 注入方式**：引擎把 SDK 文本（常量）在 spawn 前置入 workdir，程序 `from run_code_sdk import tools, ToolCallError`。比 DSH 的"绑定注入全局"更 Pythonic；SDK 用标准库 asyncio/json/sys 即可，**零 pip 依赖**。
- **复杂度/风险**：行协议解析与超时竞态（程序写半行、父进程处理超时、子进程死亡）需仔细测；bwrap 根内 python3+stdlib 可见性需验证（与 run_shell 运行任意命令同前提，P0 第一项验收）。

### 4.2 方案 B：回环 HTTP 网关（loopback broker）

```
run_code → 引擎启动一次性监听器 127.0.0.1:<随机端口>，token 注入沙箱 env
  │ 沙箱内 SDK 用标准库 urllib POST {"tool":..., "args":...} → 引擎 axum handler → dispatch → 返回结果
```

- **代价清单**（Celestea 现状下每一项都是新增）：
  1. 引擎需新增 HTTP 服务端依赖（axum/hyper）——现在完全没有。
  2. **网络例外**：沙箱默认断网；`CELESTEA_SANDBOX_NET=1` 是**全开**（恢复宿主 netns），不是"仅 loopback"。要做到"仅 127.0.0.1 放行"需在 bwrap/raw 层加过滤（iptables/nft 或 netns 路由），这是沙箱层改动 + 新攻击面。
  3. 端口/token 治理：随机端口 + 一次性 token 的泄露面（沙箱内程序可扫 loopback 上引擎同机其它服务）、每 run 监听器生命周期、并发端口冲突。
  4. 结果回流需要引擎主动 poll/等 POST，与 run_shell 的管道模型割裂，事件时序更难保证。
- **唯一优势**：协议"标准"、未来跨进程/跨机器执行（如把程序发给远端沙箱池）可平移；TS/前端同语言 SDK 时心智统一。
- **结论**：Celestea 引擎是 Rust 单体、无 HTTP 面、沙箱已断网——B 的适配成本显著高于 A，且引入新的网络攻击面；**若做只选 A**。B 留作"未来需要远程执行或多语言 SDK"时的再评估项。

### 4.3 对比表

| 维度 | A parent-broker（stdio JSON-lines） | B loopback HTTP 网关 |
|---|---|---|
| 新增依赖 | 0（复用 spawn_sandboxed + 管道） | HTTP 服务端框架 + 沙箱网例外机制 |
| 网络面 | 无（管道，进程边界） | 有（端口/token/loopback 扫描面） |
| Guard 复用 | dispatch 同管线 | dispatch 同管线（但结果回流绕一圈 HTTP） |
| 沙箱改动 | 无 | 需要"仅 loopback 放行"能力（现状只有全断/全开） |
| 跨进程扩展 | 差（管道天然本机） | 好（协议可平移远程） |
| 实现风险 | 行协议/竞态/僵尸进程 | 监听器生命周期/端口/token/超时 |
| 与 DSH 形态相似度 | 中（协议同构，载体不同） | 低（DSH 无 HTTP 面） |
| P0 工作量估计 | 4–6 人日 | 8–12 人日 |

### 4.4 与 DSH 实现的映射

| DSH 组件 | Celestea 方案 A 对应物 |
|---|---|
| worker-thread 消息协议（call/reply/log/done，id 配对） | stdin/stdout JSON-lines，同字段形态 |
| `tools` 绑定桥 → 注册表调度器 | 父进程逐行 → `registry.dispatch` |
| `isConcurrencySafe`/maxParallelSubCalls | P0 可砍（串行子调用）；P1 加工具级只读标记（Celestea 侧新增一个声明，非运行时改） |
| OutputLedger（64MiB 字节账本） | 逐行字节累积 + 截断（P0 用 run_shell 的字节 cap 常量即可） |
| 保留名/关键字投影 | 不适用：Celestea SDK 是手写常量文本，9 个工具名都是合法 Python 标识符，无生成器即无此问题 |
| `tool/code-dispatch-*` 事件 | SessionEvent ToolCall/ToolResult + 可选 `parent_id` 字段（§7） |
| 结果截留 + deferContext（图片） | `derive_messages` 跳过嵌套行（§7）；无图片结果，不需要 defer 机制 |
| 折叠强制 `collapses()` | 不抄：Celestea 保留直调（native 模式），run_code 是**额外**工具而非唯一工具——见 §9 定位差异 |

---

## 5. 语言选择：python3 优先，TS 不推荐

| 维度 | python3（宿主 3.14.4） | node/TS（宿主 v24.19.0） |
|---|---|---|
| 运行时依赖 | 0（标准库 asyncio/json/sys 写 SDK） | 需 node 在沙箱根内可见 + `--input-type` 类执行（无 strip-types 等价物则要限制纯 JS） |
| 引擎同语言收益 | —（引擎是 Rust） | —（前端同语言与工具执行无关，Celestea 无 DSH 的"宿主即 Node"红利） |
| DSH 可抄度 | 协议形态可抄，运行时**无开源代码可抄**（Python 后端私有） | worker-thread 全套开源可抄，但抄的是 Node 宿主件，Celestea 无 Node 宿主 |
| 模型遵从度（预估） | flash-0731/pro-0813 均为强代码模型，Python 单文件脚本语料密度高；类型注解可选、写法宽松 → 正确率最高 | TS 异步/类型标注对 flash 档模型更易出现类型注解残渣与未 await 错误 |
| SDK 声明大小（9 工具投影，估算见 §8） | ~0.9–1.4k token | ~1.0–1.5k token |
| 维护面 | 一份常量文本（P0 手写，与 schema 同仓 + 一致性测试） | 运行时安装/版本治理 + 类型剥离 |

**结论：只做 python3。** TS 作为 P1 可选项的唯一理由（与前端团队同语言、未来复用 DSH worker-thread 参考实现）在 Celestea 的 Rust 单体架构下不成立。

模型写程序能力预估（用于 §8 成败率，**需 P0 实测校准**）：
- pro-0813（1.6T MoE，编码基准顶配）：3–5 步只读/轻写 Python 组合程序，一次写对概率估 85–93%；失败主因是 schema 形状错配/非 JSON 返回值，而非语法。
- flash-0731（284B/13B active，编码强、廉价、速度快）：估 70–85%；长程序、嵌套异步、dict 形状细节翻车率明显高于 pro。
- 两者共同风险：程序把中间结果全 print 出来（违背截留契约）——SDK 提示词需像 DSH 一样明说"extract just what you need"。

---

## 6. 安全分析

1. **程序代码 = 任意执行面，与 run_shell 同级**。必须承认：沙箱内 Python 程序可以直接 `open()`/`os` 读写 workdir 内文件、fork 进程——**绕开 ToolGuard 的路径白名单**。DSH 同理（worker 里程序可直连 Node API，靠 `env:{}` 与工具面契约而非硬隔离）。风险增量判断：run_shell 本来就能 `cat/write/rm` 沙箱内任意文件，所以 run_code 不提升**实际可达能力**，只提升**模型多步操作的自动化密度**——真正要防的是"批量+条件"放大错误（见 2、3）。
2. **工具调用必须仍过 ToolGuard**：这是硬约束——子调用全部经父进程 `registry.dispatch`，PathGuard 拒绝会以 `ToolCallError` 回流给程序（可 catch 继续，这正是 DSH 语义）；guard 判定照常落 `ToolOutput.decision` 与事件日志，**审计闭环不断**。
3. **限额三件套**（P0 硬性）：子调用数 ≤ 20、整 run 墙钟 ≤ 120s（独立于 run_shell 300s cap 的 `CELESTEA_RUN_CODE_*` 配置）、输出账本 ≤ 256KiB 截断。缺一个都不准上生产——程序是模型写的，死循环/无限打印/扇出是常态风险。
4. **禁网默认**：parent-broker 天然继承沙箱断网（这正是选 A 而非 B 的安全理由；B 需要网例外）。
5. **SDK 白名单，不全量注入**：与 DSH"SDK 覆盖全部可见工具"不同，Celestea 应**默认只注入安全子集**：read_file/write_file/list_dir/run_shell。**禁止注入** spawn_worker（程序内扇出 worker = 递归编排爆炸）、session_send_message（程序内跨会话发消息面）、process_control（程序内管进程 = 双重进程面）；http_request 默认不给（断网下本就不可达，P1 视需求 + 白名单域再议）。
6. **输出防灌**：子工具结果默认截留（不进上下文，§7）；外层 run_code 输出受账本限额——防止程序把大文件内容整段 print 进上下文。
7. 残余风险：行协议解析竞态（半行/超长行）、子进程成为僵尸（kill_on_drop 已有，run 结束父进程显式收割）、python 字节码缓存写沙箱 workdir（无碍）。

---

## 7. 会话一致性与事件映射设计

目标：**子工具调用照常落 SessionEvent（可回放/可审计/UI 可展开），但不进模型可见历史**。与 DSH 的"日志全量 + 上下文截留"完全同构。

1. **Schema 增量**（纯加法，旧 jsonl 兼容）：给 `ToolCall`/`ToolResult` 各加可选字段 `parent_id: Option<String>`（`#[serde(default)]`）。旧行无此字段反序列化不受影响；新行在旧二进制上被忽略（serde 默认容忍未知字段）——需在新老两个方向补序列化测试，见 P0 验收。
2. **事件写入点**：run_code 处理器在父进程 dispatch 前后直接 `session.append(ToolCall{id:"<run_code_call_id>:c<n>", name, args, parent_id: Some(<run_code_call_id>)})` 与对应 `ToolResult{..., parent_id: Some(...)}`。run_code 本身的 ToolCall/ToolResult 仍由 agent-loop 照常写（parent_id=None）。子调用 id 沿用 DSH 的 `<parent>:c<n>` branded 形态。
3. **上下文投影（截留）**：`derive_messages` 改为跳过 `parent_id.is_some()` 的 ToolCall/ToolResult 行；只投影外层 run_code 的 ToolCall + 其 ToolResult（{logs, result}）。模型看到一次往返，日志里是完整子树。**这是"截留"在 Celestea 的落地形态**——比 DSH 更干净：DSH 用独立事件类型 + deferContext，Celestea 用一个可选字段。
4. **取舍**：全量入日志的成本 = jsonl 体积（每次 run_code 多 2n 行，n=子调用数）+ 大结果 double 写（子结果完整落日志，外层截留）；收益 = 回放/审计/UI 分组。**不采纳"日志也截留"**：审计闭环与"引擎与模型同事实源"原则优先，DSH 同样全量落（`tool/code-dispatch` 携带 content）。
5. **UI**（P1）：事件流里按 parent_id 折叠为可展开组，标题用 run_code 的 description 参数（DSH 用 `presentCall` 卡片同款语义）。

---

## 8. 收益/成本量化估算

### 8.1 典型多步任务模型（直调 vs run_code）

假设：N=5 步工具序列（如：list_dir → 读 3 个文件 → write_file → run_shell 跑测试读输出）；上下文前缀 P=10k token；每步模型输出 ~300 token；每个工具结果平均 ~400 token 入上下文。

| 指标 | 直调（5 往返） | run_code 成功 1 次 | run_code 失败 1 次重试 |
|---|---|---|---|
| 模型输入 token | ≈ 5×P + 4×(300+400) ≈ 52.8k | ≈ P + SDK 段(~1.1k) ≈ 11.1k | ≈ 22.5k |
| 模型输出 token | ≈ 1.5k | ≈ 0.5–0.8k（程序体） | ×2 |
| 往返数 | 5 | 1 | 2 |
| 墙钟（估） | 30–40s（5×生成 ~6s + 工具时间） | 8–15s（1×生成 + 程序执行 + 5 子调用） | 16–30s |
| 上下文净增 | ~3.3k | ~0.6k（logs 裁剪后） | ~1.2k |

- **输入 token 节省 ~78%（成功路径）**；即使两次失败重试（成功前共 3 次尝试 ≈ 33.6k）仍优于直调 52.8k。token 侧几乎稳赢。
- **墙钟**：成功路径 ÷3；失败 1–2 次内持平或仍优于直调。
- **并发红利**（额外）：独立只读子调用并发（P1 加只读标记后），N 步中 k 步只读时子调用墙钟再降。
- **额外成本**：SDK 段 ~0.9–1.4k token 常驻系统提示词（Celestea 9 工具 native schema 本身 ~1.3–1.8k，若 SDK 与 native 并存则是净增 ~1k；若学 DSH 删 native 则是持平——但 Celestea 保留直调模式，**并存**，所以是净增）。
- **风险项**：程序正确率 p。flash-0731 估 p≈0.75、pro-0813 估 p≈0.88。期望输入 token = 11.1k + (1−p)×11.4k：p=0.75 → ~13.9k（仍 -74%）；p=0.6 → ~15.7k（-70%）。**即使 p 低到 0.5，token 仍赢**；真正受伤的是墙钟体验（反复重试）与模型"写不出就放弃回退直调"的中间态（回退本身无损失，只是空耗一次尝试）。→ 成败关键不是 token 而是**成功率与调试体验**，P0 必须实测 p。
- **维护面**：P0 估算 4–6 人日（run_code 处理器 2–3 + SDK 常量文本 0.5–1 + parent_id/投影 0.5 + 测试 1–1.5），对比 W253 完整版 1–2 人月——差异来自四处裁剪：**不做 schema→语言代码生成器**（手写常量 SDK + 一致性测试）、**不做 TS**、**不做 worker 隔离件**（复用沙箱）、**不做 UI**。

### 8.2 与 W253 结论的关系

W253 的"不抄"针对**完整 L2 复制**（提示词段 + TS worker 运行时 + 投影生成器全套），本文确认其正确；但 W253 也写了"SDK 投影代码生成是纯函数，可移植；若出现多步往返成本痛点再评估"——本文的增量发现是：**parent-broker 形态使"运行时"成本坍缩为 0（复用沙箱），痛点触发门槛大幅降低**。是否触发，回到 §10 第 1 题。

---

## 9. 结论与路线

**结论：不抄完整版；推荐"简化版"（仅 Python SDK + parent-broker + SDK 白名单 + 事件映射）作为 P0 实证，数据说话后决定去留。**

三个选项的最终判定：

| 选项 | 判定 | 理由 |
|---|---|---|
| 不抄 | 可选，但错失廉价验证机会 | W253 论证成立（完整版 1–2 人月、收益未证）；但 parent-broker 把验证成本降到 4–6 人日，不做 = 把便宜实验留给了不便宜的错误 |
| 简化版（推荐路径） | **推荐先做 P0** | 复用沙箱/Guard/事件日志三大资产；token/墙钟量化收益成立；风险（成功率/调试）只有实测能定价；P0 验收即决策点（见下） |
| 完整版（TS+Python、代码生成器、UI、全工具 SDK） | 不抄 | 在 Celestea 无宿主红利；维护面/收益比差；等 P0 数据证明模式价值且出现 TS 需求再议 |

**定位差异（重要）**：Celestea 的 run_code 应是**并存模式**而非 DSH 的"ptc 折叠唯一入口"——不删 native schema、不加 PTC_ONLY 式禁令。理由：Celestea 9 工具面小，折叠的上下文收益微乎其微（§8）；且直调是回退路径（程序失败后模型可退回直调，这是正确率风险的天然保险）。

**P0 最小闭环计划（若决策开工，预计 4–6 人日）**：
1. `run_code` 工具（python3 + parent-broker JSON-lines），SDK 白名单 4 工具（read_file/write_file/list_dir/run_shell）。
2. 限额：子调用 ≤20、墙钟 ≤120s（`CELESTEA_RUN_CODE_*`）、输出账本 ≤256KiB。
3. SessionEvent `parent_id` 增量字段 + `derive_messages` 截留 + 双向序列化兼容测试。
4. 测试矩阵：成功组合（读+条件写）、PathGuard 拒绝 → ToolCallError → catch 继续、未知工具、非 JSON 返回值、超时/输出超限、abort、旧 jsonl 回放兼容、子调用事件序确定性。
5. 验收实验：3–5 个真实多步任务在 pro-0813 / flash-0731 各跑 A/B（直调 vs run_code），测 **p（一次成功率）、token、墙钟、模型放弃率**。门槛：pro p≥0.8 且 token 节省 ≥60% → P1；否则砍。
6. P1（数据过线后）：工具级只读标记启用并发、SDK 生成器自动化（9 schema 投影）、UI 分组、评估 http_request 白名单。

---

## 10. 决策清单（8 题）

1. **痛点是否真实存在？** 直调数据里多步任务（≥3 工具步/回合）占比、平均往返数、输入 token 大头是否来自前缀重复？（无度量 → 先度量，不抄。）
2. **是否接受新增一个与 run_shell 同级的任意执行面**（模型写的 Python 在沙箱内可绕过 ToolGuard 直接 I/O）？（不接受 → 不抄。）
3. **是否同意 parent-broker（stdio JSON-lines）而非 loopback HTTP？**（选 B 则成本 +2 倍且开网络面，§4.3。）
4. **是否同意 SDK 白名单 = read_file/write_file/list_dir/run_shell**，且 spawn_worker/session_send_message/process_control/http_request 永不入 SDK？（要全量 SDK → 回到完整版，不抄。）
5. **是否同意子工具结果默认截留**（日志全量落 parent_id 行、模型上下文只见外层 {logs,result}）？
6. **是否同意 SessionEvent 加可选 parent_id 字段**（纯增量，但需双向兼容测试）？
7. **是否同意只做 Python、TS 后置**（即使前端是 TS 团队）？
8. **是否同意 P0 验收门槛**：pro-0813 一次成功率 p≥0.8、token 节省 ≥60%、测试矩阵全绿——不过线即砍？

---

## 附录 A：DSH 源码引用清单（本评估依据）

- `dsh-agent-tool-presentation/lib/index.js`：mode 声明与 codeRuntime 挂载期依赖（全 51 行）。
- `dsh-tools/lib/index.js`
  - `:894` RUN_CODE_NAME；`:902-919` flavor 与 description 契约；`:905-943` resolveFlavor 与语言表三处同步约束。
  - `:1084-1381` createRunCodeTool：schema/render/execute/绑定构造/事件 append/CodeRunFailedError。
  - `:1146-1205` 单车道调度器（pending/commit/inFlight/exclusive）；`:1207-1313` binding 桥与 subCallId。
  - `:1593-1658` TS SDK 段；`:2308-2365` Python SDK 段。
  - `:2421` PTC_ONLY；`:2557-2608` maxParallelSubCalls；`:2770-2801` 保留名与 restrict 禁止。
  - `:2952-2958` executionMode（isConcurrencySafe）；`:2962-2977` ptc-dispatch-log waterfall；`:2994-2995` collapses；`:3068-3078` 折叠拒绝文案。
- `dsh-code-runtime/lib/index.js`：`:28-34` RESERVED_BINDING_GLOBALS；`:45-57` 错误成员规则；`:60-66` Python 后端为 "experimental, private CPython subprocess"；`:68-140` PORTABLE_RESERVED_WORDS。
- `dsh-code-runtime-worker-thread/lib/index.js`：`:456-468` 限额常量；`:573-640` OutputLedger；`:648-667` 配置与校验（computeMs 60s/maxWallMs 600s/maxOutputBytes 64MiB/maxOldGenerationSizeMb 512MB）；`:690-708` 类型剥离；`:736-938` 执行循环/消息协议/账本/终止。
- `dsh-code-runtime-worker-thread/lib/worker.cjs`：`:630-658` console shim；`:820-895` call/reply 协议与 `new AsyncFunction(...)` 注入。

## 附录 B：Celestea 源码引用清单

- `crates/tools/src/builtin.rs`（6 工具 + run_shell background/notify）、`crates/tools/src/sandbox.rs`（三层沙箱/rlimit/断网/spawn_sandboxed 活管道/环境白名单/超时上限）、`crates/tools/src/guard.rs`（PathGuard + 生产挂载）、`crates/tools/src/registry.rs`（dispatch=守卫链→工具）、`crates/core/src/session_log.rs`（SessionEvent 全型）、`crates/core/src/tool.rs`（ToolInput/ToolOutput/ToolDecision）、`crates/agent-loop/src/loop.rs:436-484`（派发与事件序）、`crates/session/src/persistent.rs`（jsonl 追加）、`crates/workers/src/lib.rs`（3 worker 工具）。
- 环境实测：python3 3.14.4、node v24.19.0；引擎无 HTTP 服务端依赖（Cargo.toml 仅 reqwest 客户端）。
