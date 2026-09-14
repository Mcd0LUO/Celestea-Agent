# Celestea-Studio 后端语言切换评估报告

> 📦 历史文档（2026-09-11 归档）：结论「维持 Rust axum、不换语言」已被后端 TypeScript 全量重写推翻（Rust 后端 2026-09-11 退役）。当前权威入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md) 与 [/src/celestea_studio-ts/docs/README.md](/src/celestea_studio-ts/docs/README.md)。

- 评估人：W229（DSH worker）
- 评估对象：维持 Rust axum（基准）/ Go / C# (.NET 8/9) / TypeScript（Node 24 + Hono/Fastify，附 Bun/Deno）
- 结论：**维持 Rust axum，不换语言；同时建议把「抽引擎 sidecar」作为独立的、语言中立的架构演进（优先级高于任何换语言方案）**
- 一句话理由：换语言的收益（迭代速度、与 TS 前端共享类型）**远小于**其成本（sidecar 协议 + 双进程运维 + 流式边界回归风险），而引擎 core 保持 Rust 是既定约束，Rust 后端是与引擎同构、且已被生产验证的最优选择。

---

## 0. 结论先行

**推荐：维持 Rust axum + 先抽引擎 sidecar（可选演进）。**

支撑论据：

1. **换语言 = 必须拆引擎 sidecar**：引擎（celestea-harness 8 个 crate、约 12,283 行 Rust）通过 path 依赖直接嵌进后端二进制（`Cargo.toml` 第 10-12 行），工具在进程内执行（含 2,004 行的 v1 沙箱）。换任何语言，后端都必须先变成「新语言进程 + Rust 引擎进程」的双进程架构——这是本次评估最大的成本项（详见 §2）。
2. **要换走的 HTTP 层只有 ~1,604 行**（main.rs 853 + api.rs 751），但其中嵌着大量与引擎语义耦合的细节（W225 热重载、会话回放、SSE lagged 处理、worker 工具分发）。重写量不大，**回归风险不小**。
3. **现有方案已通过生产验证**：SSE 事件协议（status/text/thinking/tool/tool_result/done）、每轮取消（watch channel）、热重载（RwLock<Gen> swap + PersistentSessionLog 回放）都已在 W215-W228 迭代中跑通，nginx 反代（Basic Auth + `proxy_buffering off`）已部署。
4. **单维护者 + 引擎必须懂 Rust**：维护者无论如何都要维护 12k 行 Rust 引擎，后端保持 Rust 意味着**不用学/维护第三种语言**；换语言反而引入第三语言认知负担（TS 后端是例外，见下）。
5. **TS 后端是唯一「有正当理由」的备选**（前端已是 TS、可共享类型），但加权得分仍明显低于维持 Rust（4.81 vs 3.63），且要付出双进程运维 + 平台发布矩阵退化的代价。

**什么条件下才值得换**：同时满足 ① 后端 API 未来 12 个月频繁大幅演进（新端点/新交互成为常态）；② 维护者愿意接受每个部署位两个进程 + supervisor；③ 不再需要 Windows/macOS 单文件发布；④ 维护者有连续 2-3 周整块时间做迁移 + 契约回归。此时优先考虑 TypeScript（Node + Hono），且必须**先完成 §6 的 sidecar 拆分**再动手。

---

## 1. 现状与事实清单（标注读过的源码）

### 1.1 后端（Rust axum，唯一二进制）

读过的文件：`/src/celestea_studio/src/main.rs`（853 行）、`/src/celestea_studio/src/api.rs`（751 行）、`/src/celestea_studio/Cargo.toml`、`/src/celestea_studio/celestea.toml`。

- **依赖**：axum 0.8 / tokio 1.53 / tokio-stream / futures（`Cargo.toml`）；引擎以 path 依赖直嵌：`celestea-runtime = /src/celestea_harness/crates/runtime`、`celestea-core = .../core`。
- **端点**（main.rs 第 816-834 行路由表）：`/api/turn`、`/api/events`、`/api/cancel`、`/api/health`、`/api/status`、`/api/tools`、`/api/config`(GET+POST)、`/api/sessions`、`/api/sessions/{id}/messages`、`/api/clear`、`/api/worker/spawn|send|status`，静态文件 + SPA fallback。
- **SSE 机制**（main.rs 第 609-634 行）：单一广播总线 `tokio::sync::broadcast(512)`；turn 任务的 EventSink 把每个引擎 `LoopEvent` 映射为同名 SSE 事件（text/thinking/tool/tool_result/done，第 428-470 行），status 事件由 turn 任务每 2 秒 tick 附加（第 704-719 行）；`BroadcastStream` + axum `Sse` + `KeepAlive`；**慢客户端落后超过 512 个事件时收到 Lagged 错误，被映射为 `status{phase:"lagged"}` 事件**（第 617-632 行）。
- **取消**：`POST /api/turn` 创建 `watch::channel(false)`，存入全局 `busy: Mutex<Option<watch::Sender<bool>>>`；`POST /api/cancel` 发送 true，`Runtime::run_turn(input, Some(cancel_rx), Some(sink))` 协作式取消（main.rs 第 651-653、707、743-752 行）。单并发 turn：busy 非空时 POST /api/turn 返回 409。
- **配置热重载（W225）**：`AppState.gen: RwLock<Gen>`（main.rs 第 312 行）；`Gen` = `Runtime` + `Profile` + 消毒后的 config JSON，整体 swap，读者永远看不到混合状态（第 280-289 行）；`POST /api/config` 拒绝 turn 进行中的请求（409）、用引擎的 lenient merge 合并到当前 Profile、api_key 只写进程 env 永不落盘、重新 `Runtime::compose` 后换代——**会话靠 `CELESTEA_SESSION_DIR` 下的 PersistentSessionLog 回放存活**（api.rs 第 379-542 行，main.rs 第 759-776 行）。
- **状态行**（W218）：steps 计数 + 5 秒滑动窗口字符速率估算 tokens_per_sec；context_usage 由会话日志字符量估算（main.rs 第 344-400 行）。
- **会话/worker**：`GET /api/sessions` 汇总三个来源（worker 注册表、宿主 cli-main、持久化 *.jsonl 文件，api.rs 第 79-163 行）；`session_file_name` 复刻引擎的会话 id 消毒规则（api.rs 第 172-188 行）；worker 端点经引擎 ToolRegistry 分发 `spawn_worker`/`session_send_message` 工具（api.rs 第 565-600 行）。
- **二进制体积**：release 构建 10,563,480 字节（约 10.1 MiB）。

### 1.2 引擎（Rust，core 保持 Rust 的既定约束）

读过的文件：`/src/celestea_harness/crates/runtime/src/lib.rs`、`/src/celestea_harness/crates/tools/src/{lib.rs,registry.rs}`、`/src/celestea_harness/crates/llm/src/client.rs`（头部注释）、各 crate `Cargo.toml`。

- **规模**：8 个 crate 共约 12,283 行 Rust（`find ... | xargs wc -l` 实测）：runtime ≈1,965、tools ≈2,642（其中 sandbox.rs 单文件 2,004 行）、core ≈965、llm、session、agent-loop、workers、summary 等。
- **公共面**：`Runtime::compose` / `Runtime::run_turn`（可取消、可流式的单轮执行，消费方注入 `EventSink` 与 tokio watch 取消通道）；`Profile`/`resolve_profile`（TOML/JSON 9 键配置、lenient merge、api-key 三路解析）。
- **LLM 流式**：async-openai 0.41.3 + `eventsource-stream` 裸 SSE 解码（typed stream 会丢 `reasoning_content`，W213 起手工解析 provider 的 SSE 事件）。
- **工具执行在进程内**：builtin 文件工具 + `run_shell`（挂 v1 用户态沙箱）+ worker 编排工具，全部经 `ToolRegistryImpl`（守卫链 + 按名分发）在引擎进程内执行。

### 1.3 前端（TypeScript + Vite）

读过的文件：`/src/celestea_studio/frontend/src/{sse.ts, api.ts, chat.ts}`（前端共 16 个 TS 模块、约 3,589 行）。

- `sse.ts`：原生 `EventSource('/api/events')`，6 种事件名强类型分发，`payload` 缺省时回退整个 envelope；断线状态 online/down。
- `chat.ts`：SSE 连接在启动时建立一次，done 事件标记一轮结束；**EventSource 断线自动重连后服务端不重放错过的 mid-turn 事件**，statusline 靠 `GET /api/status` 轮询兜底——这是现有限制，也是迁移时最容易被忽视的回归点。
- `api.ts`：全部 REST 调用集中在 fetch 封装，错误按 `{error}` 契约解析。

### 1.4 部署与运维

读过的文件：`/etc/nginx/sites-available/studio.celestea.top.ssl`。

- nginx 443 反代 → 127.0.0.1:3777：Basic Auth（`.htpasswd-studio`）+ `proxy_buffering off` + `proxy_cache off` + `chunked_transfer_encoding on` + `proxy_read_timeout/send_timeout 3600s`（保 SSE 长连接）。
- 后端是单进程、监听 loopback 的静态二进制；引擎侧 release 矩阵 = Linux + macOS(aarch64) + Windows。
- **当前部署机工具链实测**：node v24.19.0、bun 1.4.0 已安装；go、dotnet、deno、rustc 均未安装（发布用预编译二进制，交叉编译在别处完成）。——即：**今天能立刻本地开发的语言只有 Node/TS 和 Bun**。

---

## 2. 核心前提：core 保持 Rust → 换语言必须先把引擎拆成 sidecar

这是本次评估最大的成本项，必须先展开。

### 2.1 为什么换语言 = sidecar 化

- 引擎经 `path = "/src/celestea_harness/crates/..."` 直嵌后端 crate（Cargo.toml 第 10-12 行），后端直接调用 `Runtime::compose` / `run_turn` / `EventSink`（main.rs 第 48-52、294、707 行）。
- 工具在进程内执行：read_file / run_shell（2,004 行沙箱）等不能搬到新语言进程，否则等于重写引擎。
- 因此换语言后架构变为：**新语言后端进程（静态文件 + API 外观）** ↔ **本地 IPC** ↔ **Rust 引擎 sidecar 进程（引擎全部语义：compose、turn、取消、工具、会话持久化、worker 编排、热重载）**。

### 2.2 两种切分点（决定迁移成本的天平）

| 切分点 | 新语言后端做什么 | 重写量 | W225 回归风险 |
|---|---|---|---|
| A. 完整语义重写 | 后端保留全部 API 语义（config 校验/合并、session 消毒规则、worker 聚合过滤…），只把引擎调用换成 IPC | ~1,200-1,600 行（≈现状） | 高：语义在两种语言里各写一份，必须逐条对齐 |
| B. 薄代理（推荐） | 后端只做静态文件 + `/api/*` → sidecar `/v1/*` 转发；API 语义整体下移到 Rust sidecar（即把现有 axum 层搬进引擎进程） | ~200-400 行 | 低：热重载/回放/409 守卫是同一份 Rust 代码，W225 行为自动对齐 |

**关键发现：如果采用切分点 B，换语言后要写的代码只剩一个「懂 SSE 的代理」——此时新语言能提供的差异极小，换语言的价值（重写更少逻辑）也同比例消失。** 这个发现本身构成「维持 Rust」的又一条论据。

### 2.3 sidecar 化本身的成本（语言中立，无论换不换都建议做）

- 协议设计 + 契约文档：1.5 人日
- sidecar 二进制（现有 axum API 搬进引擎进程、去掉静态服务，Rust）：3 人日
- 契约回归测试矩阵（取消/lagged/重连/热重载/回放）：2 人日
- CI 调整：0.5-1 人日
- 合计约 **7 人日**（单维护者）。

### 2.4 双进程带来的普适成本（任何换语言方案都要付）

1. 每个部署位两个进程：systemd 双 unit 或一个 supervisor，启动顺序（sidecar 先起、端口就绪探测）、崩溃重启策略。
2. 第二个故障域：sidecar 挂掉时后端要有明确的 502/降级行为；日志两处合并。
3. IPC 边界的新故障模式：半开连接、超时、序列化版本漂移（sidecar 与后端分开发版）。
4. CI 矩阵是**加法不是替换**：Rust 三平台交叉编译不能删（sidecar 仍要发 Linux/macOS/Windows），再加新语言的构建任务。

---

## 3. 各候选语言评估（优势 / 风险 / 适配本项目关键点）

### 3.1 基准：维持 Rust axum

- **优势**：现状即方案，0 迁移；与引擎同语言同生态（tokio/async-openai 全家桶），类型边界零成本（直接 import `LoopEvent`/`SessionEvent`）；单二进制 10.1 MiB、三平台交叉编译矩阵已存在；broadcast + watch 的取消/背压模型已被 W215-W228 生产验证；单维护者不需要第三种语言。
- **风险**：异步 Rust 心智负担与编译时间对「UI 侧频繁小改动」不友好；对不熟悉 Rust 的合作者门槛高（目前无合作者）；axum 生态相对小众（但对本项目够用）。
- **适配关键点**：引擎 12k 行 Rust 是绕不开的维护负担，后端的边际 Rust 成本远低于「为换语言而新学一门语言 + 维护双进程」；痛点应通过 sidecar 解耦缓解（引擎与 HTTP 层各自独立编译/发布），而不是换语言。

### 3.2 Go（net/http / chi + SSE）

- **优势**：SSE 是 stdlib 直球——`http.ResponseWriter` + `http.Flusher`（`Write` + `Flush()`），模式成熟、文档海量；goroutine 对「多 SSE 长连接 + 每连接 cancel」天然友好（每连接一个 goroutine + `context.WithCancel`，`POST /api/cancel` 调 cancel func 即可）；`GOOS/GOARCH` 交叉编译是同类中体验最好的（静态二进制 ~10 MiB，比 Rust 交叉编译还省心）；官方 OpenAI SDK `openai-go` 支持流式，JSONL 一行一个 `json.Marshal` 的事；编译秒级，迭代快。
- **风险**：没有 axum `Sse`/`broadcast` 这种开箱组合，pub/sub + 每客户端队列 + lagged 丢弃策略要自己写（~150-250 行，r3labs/sse 之类的库只覆盖序列化一半）；背压是纯手工的（select client ctx / 满则丢）；新语言 = 第三语言认知负担；双进程运维成本（§2.4）。
- **适配关键点**：若选 Go，路由用 `chi`（贴近 net/http、无框架魔法），SSE 手工实现并**显式复刻 lagged → status 事件**与 512 事件缓冲语义；热重载语义留在 Rust sidecar（薄代理切分点 B），Go 端只做转发 + 并发守卫，W225 对齐风险最低。

### 3.3 C#（.NET 8 LTS / 9 minimal API）

- **优势**：minimal API 的 `IAsyncEnumerable` + `yield return` 是框架级流式一等公民，配合 `RequestAborted` token，**客户端断开检测是自动的**（不用像 Go/Node 手工探测）；`Channel<T>` 可做每客户端有界队列；官方 OpenAI .NET SDK 成熟；Kestrel 对长连接高并发调优成熟；日志（ILogger）、DI、健康检查全家桶；OpenAPI 内建。
- **风险**：部署是三候选里最重的——框架依赖发布要装 .NET runtime（还得跟着安全补丁走），self-contained 发布单 RID 约 60-90 MiB，NativeAOT 对 ASP.NET Core 仍受限/实验性；交叉发布靠 `dotnet publish -r <rid>`（可用，但三平台产物要分别发布 + 依赖 runtime pack 下载）；SSE 在 ASP.NET Core 的「逐事件 flush 时机」受中间件压缩/缓冲影响，细节坑比 Go/Node 多（需显式禁用压缩或 `FlushAsync`）；对本项目维护者是最陌生的生态，学习曲线最陡。
- **适配关键点**：只应在「维护者本来就深谙 .NET」或「未来要并入更大 .NET 体系」时才选；本项目两者皆不成立。若选，SignalR 不要用（前端是原生 EventSource，引 SignalR 客户端库 = 为 SSE 上牛刀），minimal API + IAsyncEnumerable 即可。

### 3.4 TypeScript（Node 24 + Hono/Fastify；附 Bun/Deno）

- **优势**：**前端已是 TS**——可共享 `frontend/src/types.ts` 的 DTO 与事件契约（sse.ts 的 6 种事件名/载荷类型直接 import，编译器保证契约不漂移），这是任何其他候选都没有的加权项；Hono 内建 `streamSSE`（或 Fastify 的 `@fastify/sse`），SSE 服务端实现极简；`openai` 官方 npm SDK 流式一流；JSONL 就是 `JSON.stringify`；单人迭代速度最快；部署机上 node 24.19 已装，**今天就能开工**。
- **风险**：单线程事件循环——当前后端有读文件 + 逐行解析大 JSONL 会话（api.rs 第 223-235、304 行）与全量字符统计（main.rs 第 376-400 行），搬到 Node 必须在 worker_threads 里做或懒加载，否则卡死所有 SSE 连接（薄代理切分点 B 下此问题自然消失，因为语义在 sidecar）；SSE 背压手工（`res.write` 返回 false 要暂停 + lagged 丢弃策略自写）；未捕获异常/内存泄漏是长驻服务的经典风险，需要 systemd/pm2 与内存监控；**平台发布矩阵退化**：Node 本身要装 runtime（Linux 还好，macOS/Windows 的发布体验最差），Bun `--compile` 可出单文件（~90 MiB）但**只支持在目标平台本机构建**，Deno `compile` 同理、Node SEA 实验性且不便打包 node_modules；双进程运维成本（§2.4）。
- **适配关键点**：唯一有正当理由的备选。若选，推荐 **Node 24 LTS + Hono**（streamSSE 内建、标准 Response 类型、与前端同族心智）；Fastify 亦可；Bun/Deno 仅当愿意牺牲三平台发布才考虑。**必须**采用薄代理切分点 B（把 JSONL 解析/统计/热重载全部留在 Rust sidecar），否则单线程阻塞风险会吃掉所有收益。

---

## 4. 加权决策矩阵

### 4.1 权重与理由

| # | 维度 | 权重 | 理由 |
|---|---|---|---|
| D1 | SSE 流式 + 取消/背压 | 20% | 产品核心交互路径；语言运行时在流边界（flush、断连、背压）上差异最大、线上最容易出事 |
| D2 | 配置热重载等价 | 10% | W225 是标志性功能，但 sidecar 化后语义留在 Rust，各语言只剩转发与守卫，差异收敛 |
| D3 | 并发与内存 | 8% | 负载是「多长连接 + 单 turn」，所有主流运行时都扛得住，区分度有限 |
| D4 | 部署（二进制/交叉编译/体积） | 10% | 单维护者 + 三平台 release 矩阵，发布摩擦直接影响日常 |
| D5 | 开发速度与生态 | 7% | 本项目依赖少（流式 SDK + JSONL + SSE），生态差异不足以主导决策 |
| D6 | 运维与安全 | 8% | nginx/Basic Auth/fail2ban 方案与语言无关；差异在运行时更新与进程监督 |
| D7 | 迁移成本（sidecar 协议 + 重写 + 回归 + CI + W225 对齐验证） | 25% | 任务给定的事实：最大成本项，且失败代价（丢事件、热重载错乱）不可接受 |
| D8 | 单维护者技能匹配 / 前端已是 TS | 12% | 只有一个人维护；「前端 TS」这一事实是 TS 后端唯一的独特加权 |

### 4.2 评分（1-5 分；D7 按「切分点 A：完整语义重写 ~1,600 行」保守计分，切分点 B 的敏感性见 4.3）

| 维度（权重） | Rust axum（基准） | Go | C# | TS (Node) |
|---|---|---|---|---|
| D1 SSE/取消/背压 (20%) | 5 | 4 | 4 | 4 |
| D2 热重载等价 (10%) | 5 | 4 | 4 | 4 |
| D3 并发内存 (8%) | 5 | 4 | 4 | 3 |
| D4 部署 (10%) | 5 | 5 | 3 | 2.5 |
| D5 生态/开发速度 (7%) | 4 | 4 | 4 | 5 |
| D6 运维安全 (8%) | 5 | 4 | 3.5 | 3 |
| D7 迁移成本 (25%) | 5 | 3 | 2.5 | 3 |
| D8 单维护者/TS 前端 (12%) | 4 | 3 | 2 | 5 |
| **加权总分** | **4.81** | **3.73** | **3.25** | **3.63** |
| 排序 | **1** | 2 | 4 | 3 |

评分要点注释：

- **D1**：Rust 现状 = 5（broadcast 512 有界 + lagged→status 映射 + watch 取消 + KeepAlive，已生产验证）。Go/TS 都要手工复刻「满则丢 + lagged 事件」策略（-1）；C# 断连检测自动、但 flush 时机受中间件影响（-1）。
- **D2**：Rust 现状 = 5。其余三者侧重不同：sidecar 语义下移后后端只需转发 + 409 守卫，都给 4；扣分留给协议实现中的并发守卫细节。
- **D3**：Node 单线程，大 JSONL 解析/字符统计会阻塞所有连接，必须 worker 化（-2）；Go/C# 无压力（-1 仅为双进程内存足迹 vs 现状单进程）。
- **D4**：Go 交叉编译体验甚至优于 Rust（都给 5，Rust 的 5 含「矩阵已存在」）；C# self-contained 60-90 MiB/平台分别发布/NativeAOT 受限（3）；Node 需 runtime，Bun/Deno 单文件不可交叉、体积 ~90 MiB（2.5，Bun 可至 3 但以放弃交叉为代价）。
- **D5**：TS 独享 5（与前端同族 + 官方 SDK + 部署机现成工具链）；Rust 4（async-openai/eventsource-stream 已在用，扣编译时间）；Go/C# 4（SDK 成熟）。
- **D6**：Rust 现状 = 5（单进程监督）。双进程都扣 1；C# 再扣 runtime 安全补丁跟随（3.5）；Node 再扣未捕获异常/内存漂移风险（3）。
- **D7**：Rust = 5（不迁移）。其余都要付 §2.4 全套双进程成本：Go 3（重写最直白、语言最可预期）；TS 3（重写最快但单线程坑 + 发布退化 + 契约回归仍需全做）；C# 2.5（生态陌生 + 发布最重 + 回归工作量最大）。
- **D8**：TS 5（类型共享是硬加分）；Rust 4（引擎必须 Rust，后端同语言 = 认知负荷最小，扣 1 给异步 Rust 的日常摩擦）；Go 3（第三语言）；C# 2（最陌生生态）。

### 4.3 敏感性分析

- 若把 D8 提到 20% 并等额压 D7（「前端同构」需求极强时）：TS ≈ 4.0 反超 Go ≈ 3.7，但**仍低于 Rust ≈ 4.6**——即使最偏向 TS 的权重，维持 Rust 依旧胜出。
- 若采用薄代理切分点 B（D7 各候选 +1）：Go 4.0 / TS 3.9 / C# 3.5，排序不变；但换语言收益同比例缩水（见 §2.2），结论反而更稳。
- Rust 唯一的「失分场景」：后端 API 高频大幅演进 + 维护者 Rust 熟练度下降。这是换语言的真实触发条件，而非生态优劣之争。

---

## 5. 明确结论

**推荐：维持 Rust axum + 先抽引擎 sidecar。**

- **一句话理由**：把引擎锁进 sidecar 后，要换语言重写的部分只剩一个几百行的 SSE 代理，换语言没有划算的理由；而 sidecar 化本身才是值得投入的演进（解耦引擎与 HTTP 层、让未来任何前端/语言都能接入）。

支撑论据：

1. 加权矩阵 4.81 : 3.73 : 3.63 : 3.25，且对权重扰动稳健（§4.3）。
2. 迁移的确定性成本（sidecar 协议 + 双进程运维 + 契约回归 + CI 加法）大于收益；流式边界（lagged、断线重连不重放、中途取消、409 守卫）的回归一旦发生，代价是用户可见的丢事件与热重载错乱。
3. W225 热重载对齐的最佳策略是「语义留在 Rust」（薄代理），而那样做之后换语言的价值趋近于零——闭环论证。
4. 引擎 12,283 行 Rust 是既定的长期维护负担；单维护者 + 第三语言 = 三语言仓库，长期成本被低估的风险最大。
5. 唯一可能的例外是 TS(Node)：它与前端的类型共享是真实收益。但触发换语言需要 §0 的四条条件同时成立，且必须 sidecar 先行——sidecar 化完成后若条件仍然成立，届时再花 5-8 人日换 TS，代价已可控。

**若推荐换语言（本报告未推荐）时的迁移计划草图与风险清单见 §7——它是「条件成立时」的备用路线，也是 sidecar 化完成后重新评估的输入。**

---

## 6. 引擎 sidecar 协议草案（JSON 契约）

> 位置：无论换不换语言，sidecar 拆分都值得做。协议设计原则：**最大化复用现有 axum 语义，最小化新概念**。

### 6.1 传输选择

- **推荐：localhost HTTP/1.1（127.0.0.1:3778）**。理由：① 复用现有 SSE 事件流与 JSON 契约，curl 可调试；② gRPC 引入 protobuf 工具链 + 流式双向映射成本，本项目收益为零；③ stdio JSON-RPC 没有多客户端/健康语义，且与 supervisor 集成差（进程 stdin 生命周期脆弱）；④ HTTP 自带超时/重试/日志生态。
- sidecar 只监听 loopback；后端与 sidecar 之间可用固定随机 token（写入双方 env）做薄认证，或依赖 loopback + 防火墙。nginx 的 Basic Auth 位置不变。

### 6.2 端点契约

| sidecar 端点 | 语义 | 与现状的映射 |
|---|---|---|
| `GET /v1/health` | `{ok, model, base_url}` | = 现有 /api/health |
| `POST /v1/turn` `{input}` | **响应即 SSE 流**（sidecar 直接以 SSE 返回 turn 事件）；单并发 turn，忙时 409 `{ok:false,error}`；**SSE 连接断开 = 取消本轮** | = /api/turn + /api/events 合体（事件直连发起轮次的连接） |
| `POST /v1/cancel` | 发 cancel 信号 | = 现有 /api/cancel |
| `GET /v1/config` / `POST /v1/config` | 消毒配置读取 / 部分热更新（校验、合并、409 守卫、api_key→env、compose、swap、回放全部留在 sidecar） | 现有实现整体下移 |
| `GET /v1/status` | statusline 快照 | = 现有 /api/status |
| `GET /v1/tools`、`GET /v1/sessions`、`GET /v1/sessions/{id}/messages`、`POST /v1/clear`、`POST /v1/worker/*` | 会话/工具/worker 语义全部下移 | 现有实现整体下移 |
| `GET /v1/events` | 广播总线（保留，供多客户端 UI） | = 现有 /api/events |

后端（若换语言）只剩：静态文件 + SPA fallback + `/api/*` → `/v1/*` 反向代理（path rewrite + 错误映射 + 超时），约 200-400 行。

### 6.3 事件流格式（与现有 SSE 严格对齐）

- 事件名不变：`status` / `text` / `thinking` / `tool` / `tool_result` / `done`。
- 载荷不变：`text/thinking` → `{"delta"}`；`tool` → `{"id","name","args"}`；`tool_result` → `{"id","ok","value","render","error","decision"}`；`done` → `{"text","tool_calls"}`；`status` → `{"phase","statusline",...}`。
- 信封不变：`{"turn":N,"seq":M,"payload":{...}}`（turn/seq 由 sidecar 单点发号，避免双进程各发一号）。
- 行为对齐：lagged → `status{phase:"lagged"}`（512 事件容差）；2 秒 progress tick；KeepAlive 注释帧。

### 6.4 两个可选改进（sidecar 化时顺手做，低风险高价值）

1. **turn 事件环形重放缓冲**（如每轮保留最近 2,048 事件，重连时按 `?turn=N&after_seq=M` 补发）——解决 §1.3 记录的「断线重连不重放 mid-turn 事件」现有限制。
2. `POST /v1/turn` 支持 `?event=broadcast` 走广播总线模式，保持单客户端/多客户端两种拓扑的显式切换。

---

## 7. 迁移计划草图（仅当 §0 条件成立、决定换语言时启用；以 TS 为例，人日按单维护者估）

| 阶段 | 交付物 | 人日 |
|---|---|---|
| P0 引擎 sidecar 化（**换语言的前置，语言中立**） | §6 契约文档；`celestea-engine-sidecar` Rust 二进制（现有 axum API 下移、去掉静态服务）；双进程本地联调脚本；Rust 侧单测 | 6-8 |
| P1 契约回归矩阵 | 脚本化用例：中途取消 / lagged 慢客户端 / EventSource 断线重连 / 热重载（turn 中 409、回放保真、api_key 不落盘）/ worker 工具 / 会话消毒规则逐条对照 | 2-3 |
| P2 新语言后端重写（TS + Hono，薄代理切分点 B） | `frontend/dist` 静态服务 + SPA fallback + `/api`→`/v1` 代理 + 状态聚合；用前端 `types.ts` 做编译期契约检查 | 3-4 |
| P3 CI / 发布 | Node 20/24 矩阵、Linux systemd 双 unit（sidecar + backend）、Bun 单文件或 runtime 方案决策、Windows/macOS 发布方案落定 | 1-2 |
| P4 灰度与切换 | 双端口并行观察（旧 Rust 单二进制 vs 新双进程）1-2 周，事件流逐条 diff；fail2ban/nginx 配置复核；回滚脚本 | 2-3 |
| 合计 | | **14-20 人日**（不含 sidecar 的持续维护与三平台回归） |

风险清单：

1. **SSE 边界回归**（最高风险）：flush 时机、lagged 语义、断连重放差异——必须 P1 脚本化全量对照，不允许肉眼验收。
2. **W225 行为漂移**：热重载期间会话回放不保真 = 用户对话历史丢失；薄代理切分点 B 是唯一可靠解。
3. **双进程故障域**：sidecar 崩溃/重启时的半开连接、端口抢占、日志割裂；需要就绪探测与 502 降级策略。
4. **平台发布退化**（TS 特有）：Bun/Deno 不可交叉编译 → Windows/macOS 要么放弃单文件、要么三平台各建一次。
5. **单线程阻塞**（TS 特有，切分点 A 下致命）：JSONL 解析/统计必须 worker 化或留在 sidecar。
6. **CI 加法**：Rust 三平台矩阵保留 + 新语言矩阵，维护面扩大。
7. **三语言认知负担**：Go/C# 路线下仓库长期三语言；TS 路线为两语言。
8. **动力风险**：迁移后半程（回归矩阵）单调枯燥，单人项目易烂尾——建议 P1 契约矩阵在 P0 期间就边做边跑。

---

## 8. 决策清单（给用户的判断题）

1. **未来 12 个月，后端 API 会频繁大幅演进（新端点、新交互成常态）吗？** 会 → TS 加权上升，但仍须 sidecar 先行；不会 → 维持 Rust 的理由进一步强化。
2. **你能接受每个部署位两个进程、systemd 双 unit / supervisor 监督吗？** 不能 → 直接排除所有换语言方案。
3. **引擎 12k 行 Rust 的维护意愿/能力是否在下降？** 是 → 优先 sidecar 化收紧 Rust 边界（而不是换语言）；否 → 没有换语言动力。
4. **你接受「新语言只做代理 + 静态服务，API 语义留在 Rust sidecar」吗？** 接受 → 重写成本骤降，但换语言收益也骤降（≈不换）；不接受（想在 TS 里重写全部语义）→ 回归风险最高，不建议。
5. **还需要发布 Windows / macOS 客户端二进制吗？** 需要 → Go 或维持 Rust；Node/Bun 三平台发布最痛苦。
6. **是否计划让第三方 / 插件 / 其他 CLI 接入同一个引擎？** 是 → 先做 sidecar（语言中立、复用面最大），换语言另议。
7. **前端共享 DTO / 类型校验是强需求吗（今天 `types.ts` 与后端契约靠手工对齐是否已让你痛）？** 很痛 → TS 加权上升；不痛 → TS 的最大卖点不存在。
8. **你能拿出连续 2-3 周整块时间做迁移 + 契约回归吗？** 不能 → 不做；能做 → 先把这 2-3 周投给 sidecar 化（P0+P1，~10 人日），其产出无论换不换语言都永久有效。

---

## 附录：读过的源码与事实来源

- `/src/celestea_studio/src/main.rs`（853 行，全部精读）
- `/src/celestea_studio/src/api.rs`（751 行，全部精读）
- `/src/celestea_studio/Cargo.toml`、`/src/celestea_studio/celestea.toml`、`/src/celestea_studio/README.md`
- `/src/celestea_studio/frontend/src/sse.ts`、`api.ts`、`chat.ts`（前端其余 13 个模块仅盘点，未逐行读）
- `/src/celestea_harness/crates/runtime/src/lib.rs`；`tools/src/{lib.rs,registry.rs}`；`llm/src/client.rs`（头部注释）；各 crate `Cargo.toml`
- `/etc/nginx/sites-available/studio.celestea.top.ssl`
- 实测数据：引擎 8 crate 共 12,283 行；后端 1,604 行；前端 3,589 行；release 二进制 10,563,480 B；部署机已装 node v24.19.0 / bun 1.4.0，未装 go / dotnet / deno / rustc。
