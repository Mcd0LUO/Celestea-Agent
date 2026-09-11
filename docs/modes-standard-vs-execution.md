# 特性设计 · 会话双模式（标准模式 / 执行模式 · DSH PTC 对应物）

> 状态：**P0 已实现（W729），P1/P2 仍是设计**。见文末 §10「P0 落地状态」逐条对照与偏离。
> 本文其余部分保持设计原文（含写文档当日的行号与基线数字），**不回改历史结论**；
> 与落地实现冲突的两处口径以 §10 的裁决为准。
> 范围：`packages/core`（无改动，见 §4）、`packages/tools`、`packages/runtime`、`apps/studio/src/{store,handlers,runtime}`、
> `contracts/`、共用前端 `/src/celestea_studio/frontend/src/**`；仓库外 `celes-worker-spawn` 插件（`/src/dsh_plugins/celes-worker-spawn`）只作为**映射边界**出现。
> 前置阅读：`docs/ARCHITECTURE.md`（分层/seam 纪律）、`docs/feature-session-independence.md`（W513，已实现：每会话实例 + SSE `v:2` 信封）、
> `docs/feature-session-grants.md`（W516，已实现：会话级配置与审计先例）、`docs/iteration-e-capabilities.md`（§5.3 契约清单写法）、
> `/src/celestea_harness/docs/archive/dsh-ptc-mode-eval.md`（W253，PTC 三层拆解，已归档）、`/src/celestea_harness/docs/archive/run-code-mode-eval.md`（W254，run_code 折叠评估，已归档）、`/src/celestea_harness/docs/run-code-sdk.md`（W255，已落地 SDK 契约）。
> 一句话目标：**同一份引擎，两种会话工作方式**——标准模式按今天的方式逐步调用工具；执行模式把多步依赖调用折叠进 `run_code` 程序里，并以**会话元数据**固定下来，而不是每轮改口径。
>
> **术语**：`<session dir>` = `<workspace>/<session>/`；`mode` 只有两个字面量 —— **`standard`**（标准模式）与 **`execution`**（执行模式，文档/UI 里括号注明「PTC 对应物」）。
> **本文的实现状态栏**：所有「现状」均标注 `文件:行号`，为本次实读结论（`/src/celestea_studio-ts`，live 服务 `celestea-studio-ts` 在 127.0.0.1:3777，pid 618902）；
> 所有「建议数值/估值」均**不是实测数据**；无法确认的宿主事实集中在 §7。

---

## 0. 结论速览

| # | 议题 | 裁决 |
|---|---|---|
| D1 | 两模式的定义 | `standard` = 今天的行为（逐步直调工具，模型自己串联多步）；`execution` = 同一套工具面，但**行为契约转向 `run_code` 程序化组合**（P1 起 SDK 覆盖的 4 个工具不再直调，只能从程序内到达）。 |
| D2 | 模式归属 | **会话元数据（每会话固定）**，写在 `session.json`，与 `model`/`prompt` 同级；**不做每轮可选**（理由见 §2.1）。运行期切换只允许在**轮次边界**（P1 起），语义与 `POST /api/config` 的 epoch 失效同款。 |
| D3 | worker/子会话 | 引擎内 worker 会话（`worker:<sid>`）**默认继承**父会话 mode；`spawn_worker` 新增可选 `mode` 覆盖。DSH 外部 fleet 的 `agentPreset` **不由会话携带**，只在 spawn 边界单向映射（§3.3）。 |
| D4 | `agentPreset` 关系 | **单向映射、单点翻译**：`mode` 是 Studio 引擎的唯一模式语义；`agentPreset` 只是 DSH 宿主的入参，由 spawn 适配层从 `mode` 派生（`standard→standard`、`execution→code`）。Studio 的契约/接口/数据文件**永不出现** `agentPreset` 字段，反之 DSH 预设名也不进 Studio 契约。**禁止**把 `mode` 直接透传成宿主预设名、禁止两个字段并存。 |
| D5 | 分期 | **P0** 只加 `mode` 字段 + 提示词变体（不改工具暴露面）；**P1** 工具暴露差异（execution 折叠 4 个 SDK 工具）+ UI 选择器；**P2** 折叠强制力与预算联动 + A/B 度量（不过线即回退 P1 的暴露差异，见 §5.4）。 |
| D6 | 契约硬断言 | P0：`API_ENDPOINT_COUNT` **保持 43**（零新端点）；P1：`POST /api/sessions/{id}/mode` → **43→44**。`BUILTIN_SECTIONS` 保持 **10 行且 order 数组不变**（模式差异靠**模板变体**表达，不加第 11 段）。 |
| D7 | 唯一不可回避的实现风险 | 今天系统提示词是**进程启动时按「全局活跃会话」装配一次**（`apps/studio/src/app.ts:96`、`real-runtime-adapter.ts:168`），每会话只覆盖 `model`（`session-compose.ts:154`）。P0 必须把装配**下沉到会话实例**，否则「每会话模式」只在聚焦会话上生效。见 R3。 |

---

## 0.1 共同约束（沿用 `iteration-e-capabilities.md` §0.1 的 K 编号体系）

| # | 约束 | 依据 | 对本设计的直接影响 |
|---|---|---|---|
| K1 | 依赖只能向下，L1 之间不横向依赖 | `ARCHITECTURE.md` §1.1/§1.3 | 暴露面装饰器必须落 `packages/tools`（与 `ToolRegistry` 实现同包）；`runtime` 只做装配，不判模式 |
| K2 | 公开面收口在 `src/index.ts` | §2.2 | 新符号（`mode.ts`、`exposedRegistry`）经各包 `index.ts` 导出；改导出 = 契约变更 |
| K3 | 单文件 ≤400 / 单函数 ≤80 / 嵌套 ≤4 / 形参 ≤5 | §4.1 | 模式表、变体表必须**数据表外提**为模块级常量（§4.2 范式 2） |
| K4 | 事件日志是唯一真源，模型可见历史是派生物 | §3.1 `SessionLog` 行 | 切模式**不重写、不裁剪日志**；历史里指向已折叠工具的 `tool_call` 行原样保留（历史合法性见 U3） |
| K5 | 事件名与信封冻结（8 个事件名；信封 `{v:2, session, turn, seq, payload}`） | `apps/studio/src/sse.ts:39,180-184` | mode 的可见性**只加 payload optional 字段**（`status.mode`），不得新增事件名 |
| K6 | 契约是硬断言（端点数、data-file schema） | `apps/studio/src/routes.ts:48`（`API_ENDPOINT_COUNT = 43`）、`app.ts:81-109`（`assertCoverage`）、`prompts.test.ts:40-42` | 每加一个端点必须同步 `contracts/endpoints.json` 的 `count` 与常量；`BUILTIN_SECTIONS` 长度与 order 数组被测试钉死 |
| K7 | `core` 零依赖、零实现 | §3.1 | 模式**不进** `AgentConfig`/`Profile` 冻结键集（12 键，`packages/runtime/src/profile.ts:8-36`）；不由 core 认识 mode 值 |
| K8 | 今天的行为是基线，未声明的差异视为缺陷 | §0 红线 | 无 `session.json.mode` 的会话**逐字节等同今天**（P0 的向后兼容判据，见 M3/M13） |

---

## 0.2 现状总览（实读，带行号）

| 维度 | 现状 | 位置 |
|---|---|---|
| 模式概念 | **完全不存在**：无 `mode` 字段、无模式端点、无按会话的工具面差异 | 全仓 grep 无命中；`contracts/endpoints.json` 43 端点清单里没有 mode 类端点 |
| 工具暴露 | 单一来源 `registry.schemas()`，模型每一步都看到**全部 10 个**工具 | `packages/agent-loop/src/loop.ts:165`；`contracts/tools.json`（`count: 10`，含 `run_code`） |
| `run_code` 现状 | **已落地且是"并存"形态**（非 DSH 的唯一入口）：注册进注册表，broker 子调用走同一 registry；白名单 4 工具；硬限额 20 次/120s/256KiB/64KiB 日志 | `packages/tools/src/plugin.ts:117-133`、`run-code/limits.ts:26-43`、`run-code/broker.ts:303-322` |
| `run_code` 的提示词 | `tool_access` 段已含 run_code 段落，并**硬编码**了 10 个工具名清单 | `apps/studio/src/store/builtin-sections.ts:34`（该段 617 B，是全 10 段里第二长） |
| 提示词段 | 冻结 **10 段**（order 100..1000），内置模板拼装后总长 **3835 B**（含空行分隔） | `builtin-sections.ts:17-78`；`prompts.test.ts:40-42` |
| 提示词上限 | `PROMPT_MAX_LEN = 8192` 字节，**尾部截断**（char 边界） | `apps/studio/src/store/prompts-template.ts:10,94-100`、`prompts-compose.ts:55` |
| 提示词装配时机 | **进程启动 / 配置变更时一次**，且按「全局活跃会话」取 scope、vars 与 prompt 绑定 | `app.ts:96`、`config-shape.ts:71-89`、`real-runtime-adapter.ts:168-172` |
| 会话级覆盖 | 只有 `model`：`profileFor(sessionId)` 用 `session.json.model` 盖 base profile；`system_prompt` 来自 base（全局） | `session-compose.ts:152-156`、`session-meta.ts`（`SessionMeta = {model?, prompt?}`） |
| `{{tools}}` 变量 | 取**默认实例**的注册表名字（`registry.peek(null)`），与聚焦会话无关 | `config-shape.ts:83`、`real-runtime-adapter.ts:180-182` |
| 会话数据文件 | `session.json` = `{model?, prompt?}`，`additionalProperties: true`；写入器只写这两个键 | `contracts/data-files/session.schema.json`、`store/session-meta.ts` |
| 会话创建 | `POST /api/sessions` 请求 `{workspace?, title, model?, prompt?}`；无 mode | `contracts/endpoints.json` `post_sessions`；前端 `frontend/src/ui/sessions.ts:743-880`、`types.ts:321-328` |
| 运行期重建 | 配置变更 → `bumpEpoch()` + `registry.invalidateAll()`，实例在**下一轮边界**惰性重建 | `real-runtime-adapter.ts:384-387`、`feature-session-independence.md` §2.2 |
| 能力位 | `/api/health.capabilities = {grants:true}` 已是既有先例 | `apps/studio/src/handlers/health.ts:35` |
| DSH 侧 | `celes-worker-spawn` 支持 `agentPreset` 透传（`session.create` 原生字段）；宿主预设**仅 blank 会话可切**，否则 `agent-preset-locked`；`GET {prefix}/presets` 可枚举 | `/src/dsh_plugins/celes-worker-spawn/README.md:58-76`、`HANDOFF.md:123-126`、`lib/index.js:227-282` |
| DSH PTC 语义 | `ptc` preset = standard 减 `workflow` + `tool-presentation(mode:ptc)`；呈现层把整张注册表折叠成 `run_code` 单工具，规则段 `PTC_ONLY` 禁止直调 | `/src/celestea_harness/docs/archive/dsh-ptc-mode-eval.md` §1.1-1.2（已归档） |
| W254 的既有结论 | Celestea 的 `run_code` 应是**并存模式**而非唯一入口；不抄 `collapses()` 禁令；P0 验收门槛 `p≥0.8` 且 token 节省 ≥60% 才上 P1 | `/src/celestea_harness/docs/archive/run-code-mode-eval.md` §9、§10（已归档） |

**一句话现状**：`run_code` 的能力**已经全在**（W255），缺的是**「让它成为一个可选择的会话工作方式」**这件事本身——以及支撑它的**每会话提示词/工具面**这条通路。

---

## 1. 两种模式的定义与可观测差异

### 1.1 定义（一句话）

- **标准模式 `standard`**：今天的行为。模型每一步看到全部 10 个工具，自行串联多步调用；`run_code` 可用但**不被引导**。
- **执行模式 `execution`**：同一套引擎与沙箱，但会话的行为契约转向**程序化组合**——需要多个依赖步骤时，写**一个** Python 程序在 `run_code` 里完成取数/处理/落盘，只把最终值带回对话；P1 起 SDK 覆盖的 4 个工具（`read_file`/`write_file`/`list_dir`/`run_shell`）**不再出现在可直调工具面**，只能从程序内到达。

**明确不是什么**（防止把 DSH 的形态整段抄错，据 W253 §1.2/§3.1、W254 §9）：

| 不做 | 理由 |
|---|---|
| 不做「`run_code` 是唯一可直调工具」的**禁令**（DSH `PTC_ONLY`） | 那需要把 `workflow`/`spawn_worker`/`http_request` 等全部工具接进 SDK，且禁令一旦生效，程序写不出来就没有出路；Celestea 的编排面与网络面必须保持直调 |
| 不做**全量 SDK 代码生成器**（schema→TS/Python 投影） | 无宿主代码运行时红利；现行 SDK 是引擎侧常量文本（`run-code/sdk.ts`），9 个工具名本身就是合法 Python 标识符，无生成器即无投影边界问题 |
| 不做 TS flavor | W254 §5：收益在 Rust 单体下不成立 |
| 不删 `run_code` 的回退路径 | 程序失败后模型必须能退回直调（W254 §9 的"天然保险"）；执行模式的折叠**只是把 4 个工具从直调面移出**，`http_request`/`process_control`/worker 三工具与 `run_code` 本身始终直调 |

### 1.2 差异矩阵（每格都是可观测断言或明确标注为估值）

| 维度 | 标准模式 `standard` | 执行模式 `execution` | 可观测点 |
|---|---|---|---|
| **系统提示词段** | `tool_access` 变体 A：只讲直调纪律与 `{{tools}}` | `tool_access` 变体 B：变体 A + 「多步依赖 → 一个程序」契约 + 子调用截留说明 + 限额数字 + 失败后**修程序重试优先于回退** | 组装结果字符串（P0 起逐会话不同） |
| **工具暴露（P0）** | 10 个（不变） | 10 个（**P0 刻意不变**：只改口径不改暴露面） | `registry.schemas()` 名字集合 |
| **工具暴露（P1）** | 10 个 | 6 个：`run_code` + `http_request` + `process_control` + `spawn_worker` + `session_send_message` + `worker_status` | 同上 + `GET /api/tools?session=` |
| **工具暴露（P2）** | 同 P1 | 同 P1 + 折叠的**引导错误**文案与限额联动 | 直调折叠名的 `ToolOutput.error` |
| **上下文与 token 经济** | 每步请求带全部 10 个 schema（实测 `contracts/tools.json` 的 name+description+parameters 合计 **10 768 B ≈ 2.4–3.0k token**，按 3.6 B/token 粗估）；多步序列的中间结果**全部进上下文** | 折叠掉 4 个工具 ≈ 省 **1 321 B ≈ 370 token/请求**；execution 段文本净增约 **+400~700 B**；**中间结果不进上下文**（只落会话日志，`derive_messages` 跳过 `parent_id` 行） | 请求体 bytes；`GET /api/status.context_usage`；会话日志行数 vs 模型可见消息数 |
| **延迟/墙钟（估值，未实测）** | N 步 = N 次生成往返 | 1 次生成 + 程序内 N 次子调用（P0 子调用串行） | W254 §8.1 模型：N=5 时输入 token 与墙钟都显著下降；**p（一次成功率）未实测** |
| **失败面** | 单步失败可见、可逐步重试；错在"下一步再修" | 程序语法/形状错误 → 整次 `run_code` 失败（带日志尾部 ≤2 KiB）；也可能出现"程序写不出就放弃"的中间态 | `run_code: code=` 结构化错误类别（`invalid_arg`/`config`/`spawn`/`protocol`/`timeout`/`aborted`）与 `ToolCallError.tool_name` |
| **审计/回放** | 每步一行 `tool_call`/`tool_result` | **子调用同样全量落日志**（`id=<parent>:c<n>`、`parent_id=<parent>`），但模型只看到外层往返 | jsonl 行数与 `deriveMessages` 投影的差 |
| **权限/沙箱** | `run_shell` 与各工具按会话 grants | **完全相同**：子调用走同一 guard 链；程序本身与 `run_shell` 同级（可绕 ToolGuard 直接 I/O，W254 §6.1 已承认） | `ToolOutput.decision` 与 grants 审计行 |
| **成本归属** | 每步一次计费 | 每步一次计费（省的是往返次数与前缀重复，不是单价） | 账本（能力 3，见 `iteration-e-capabilities.md` §3） |

**关键诚实结论（token 经济）**：Celestea 只有 10 个工具，**"折叠 schema"本身几乎不省 token**（省 370、加回数百）。真正的 token 收益来自**往返折叠**（5 次往返 → 1 次，前缀重复消失）——W254 §8.1 的 −78% 是**往返度量**，不是 schema 度量。两者不可混算；任何"执行模式省 token"的说法必须先有 A/B 实测（§5-P2、M15）。

### 1.3 提示词变体（落地级文本，P0 直接可用）

`tool_access`（order 300）**改为两张模板变体**，注册表仍是 10 行（K6）：

**变体 A（standard）**——顺手修掉现有的清单漂移（今天硬编码 10 个工具名，P1 起清单随模式变，硬编码必然自相矛盾）：

```text
Tool access: call tools directly ({{tools}}); never wrap tool calls in prose; one message may contain several tool calls.

For a single lookup or a single change, just call the tool. `run_code` (a Python program in the sandbox) is available when a task needs several dependent calls, but stepping through the tools one at a time is the normal path here.
```

**变体 B（execution）**：

```text
Tool access: call tools directly ({{tools}}); never wrap tool calls in prose; one message may contain several tool calls.

Execution mode — prefer one program over many round trips. When a task needs more than one dependent call (read several files, filter, then write or run something), write ONE Python program for `run_code` and return only the value you need. Inside the program `tools.read_file(path=...)` / `tools.write_file(path=..., content=...)` / `tools.list_dir(path=...)` / `tools.run_shell(command=...)` are dispatched through the same guarded pipeline as a direct call; a denied or failed sub-call raises `ToolCallError` — catch it and continue. Intermediate sub-call results are recorded in the session log but do NOT enter the conversation: `print` nothing you do not need, and return the final value from `main()`.
Hard limits: ≤20 sub-calls, wall clock ≤120s, sub-call output ≤256 KiB, program logs ≤64 KiB. If the program fails, read the error, fix the program and retry — fall back to one-by-one calls only if the program cannot work.
```

**字节预算核算**（P0 必查，M6）：现 10 段合并 3835 B；变体 A ≈ 现文本 −250 B，变体 B ≈ +450 B；两者都远低于 `PROMPT_MAX_LEN = 8192`，且**不得**超过 ~1 KB（否则开始挤占 `environment` 1106 B 与 `identity` 397 B）。P1 折叠后变体 B 再加一句「这四个工具在本模式下不可直调，只能从 `run_code` 程序内到达；直调会返回一条说明错误」——这句**必须与实际暴露面一致**。

---

## 2. 模式归属

### 2.1 三选一与推荐

| 方案 | 语义 | 优点 | 致命问题 |
|---|---|---|---|
| **A. 会话元数据（推荐）** | `session.json.mode`，创建时固定；P1 起允许在**轮次边界**切换 | 与 `model`/`prompt` 同级，已有读写与容错先例；基座是 per-session 实例（W513），重建粒度天然是会话；可在 `GET /api/sessions` 列表显示 | 需要把提示词装配下沉到会话（R3） |
| B. 每轮可选（请求体带 mode） | `POST /api/turn {mode}` | 灵活 | 提示词与工具面是**按实例构建**的派生物（`profile.system_prompt`、`registry.schemas()`），每轮改口径 = 每轮重建实例或每轮改请求前缀 → 破坏 prompt-prefix 缓存稳定性、让"这一轮属于哪个模式"在日志里无处安放（日志只有事件，没有"当轮模式"字段，加了就是契约变更） |
| C. 全局配置（`POST /api/config`） | 进程级 mode | 改动最小 | 违背 W513 的方向（每会话独立实例、独立 model），且与"会话工作方式"语义不符：一个会话在执行模式、另一个在标准模式是最自然的用法 |

**推荐 A，并在 P0 就写死"每会话固定"**。切换纪律（P1 起）：语义等同 `POST /api/config` 的"下一轮生效"（`real-runtime-adapter.ts:384-387`），**在飞轮次不打断**；有在飞轮次时返回 409，错误串与 `compact` 同款纪律（作用域 = 该会话）。

**为什么不做"每轮"**：DSH 自己的最近先例是**更严**的——`agentPreset` 仅 blank 会话可切，一旦有 `turn/start` 即 `agent-preset-locked`（`celes-worker-spawn/HANDOFF.md:123-126`）。我们选择"轮次边界可切"而不是"blank 才可切"，理由是我们的引擎**已经**具备"实例在轮次边界惰性重建"的机制（epoch），且有"配置将在会话下一轮生效"的既有产品语义；代价与风险见 U3。

### 2.2 生效时机与可见性

1. **创建时**：`POST /api/sessions.mode` → 写入 `session.json`；缺省 `standard` 且**不写该键**（保持与今天逐字节一致，K8）。
2. **下一轮**：会话实例在 `ensure()`/重建时按当前 `session.json.mode` 组装 `system_prompt` 与工具暴露面。
3. **可见性**：`GET /api/sessions` 行、`GET /api/status`（被查询会话）、SSE `status` 帧 optional `mode`（K5，不加事件名）。
4. **审计**：切换 mode 走 `grants-audit.jsonl` 同款本地 append-only 审计（W516 先例），事件名 `mode_change`，含 `{session, from, to, at}`。

### 2.3 worker / 子会话的继承

| 关系 | 规则 | 理由 |
|---|---|---|
| 引擎内 worker 会话（`worker:<sid>`，`session-compose.ts` 的 `sessionIdPrefix`） | **默认继承**父会话 mode；`spawn_worker` 新增可选 `mode` 参数可覆盖 | worker 是同一引擎的会话，报告里常带大量文件操作；父若在执行模式而 worker 退回标准模式，会让"报告怎么产生的"与主会话不一致 |
| worker 回执/报告 | 报告头部由 `receipt.ts` 生成，**增加一行 `- mode: <mode>`**（纯文本，不改协议） | 主会话读回执时知道子会话的工作方式 |
| DSH 外部 worker（`celes-worker-spawn` 走 DSH `session.create`） | 不在 Studio 引擎内，**不读 `session.json.mode`**；由 spawn 调用方把 mode 映射成 `agentPreset`（§3.3） | 两个后端、两套会话存储；强耦合会得到两套语义纠缠的字段 |
| 未来 fork/branch（`POST /api/sessions/{id}/branch`） | 继承源会话 mode（branch 会复制 `session.json`，天然满足） | 与 `model`/`prompt` 同规则 |

---

## 3. 选择通道

### 3.1 API（端点与字段）

**P0（零新端点，`API_ENDPOINT_COUNT` 保持 43）**

| 端点 | 变更 | 类型 |
|---|---|---|
| `POST /api/sessions` | 请求**纯增**可选字段 `mode?: "standard" \| "execution"`（非法值 → `400 invalid mode: <value>`，文案冻结）；写进 `session.json` | 兼容增字段 |
| `GET /api/sessions` | 每行**纯增** `mode` 字段（worker 行同） | 兼容增字段 |
| `GET /api/status` | **纯增** `mode`（被查询会话的模式）；`GET /api/status?session=` 语义沿用 W513 | 兼容增字段 |
| `GET /api/config` | `system_prompt` 改为**聚焦会话**的组装结果（语义收窄，见 §4.2）；**不**新增 `mode` 字段（config 是进程级热调面，mode 不是热调项） | 语义变更（可测） |
| `GET /api/tools` | P0 不变（两模式暴露面相同）；P1 起支持 `?session=`，缺省 = 聚焦会话 | P0 不变 / P1 兼容增 query |
| `GET /api/health` | `capabilities` 增 `session_mode: true`（P0）、`session_mode_tools: true`（P1） | 兼容增字段 |

**P1（新增 1 个端点：43 → 44）**

| 端点 | 变更 |
|---|---|
| `POST /api/sessions/{id}/mode`（新） | body `{mode}`；200 `{ok, session, mode, effective: "next_turn"}`；409 `{ok:false,error:"turn 进行中，无法切换模式"}`（与 `compact` 同款冻结文案）；404 未知会话；400 非法 mode。**TS-only 端点**，须登记进 `contracts/rust-route-table.snapshot.json` 的 `tsOnlyRoutes`（W516 先例） |
| `POST /api/turn` | 无变更（mode 不是每轮参数，D2） |

**为什么 P0 不给切换端点**：P0 的差异只在提示词，创建期固定即可闭环；把切换推到 P1 与 UI 选择器同批上线，可避免"能切但无处点"的半成品，也让"切换是否安全"（U3）有实测机会。

### 3.2 前端（入口位置与既有 UI 的关系）

| 位置 | 内容 | 落点 |
|---|---|---|
| **新建会话弹窗**（主入口） | 「工作方式」下拉：`标准模式` / `执行模式（PTC）`，默认标准；随 `POST /api/sessions` 提交 | `frontend/src/ui/sessions.ts:743-880`（现有 标题/工作区/模型 三行之后）、`types.ts:321-328` 的 `SessionCreateReq` |
| **statusline**（每次可见） | 会话标识格旁加一个**只读**徽标 `标准` / `执行`；点击 → 弹层里可切换（P1，调 `POST /api/sessions/{id}/mode`），与现有"模型/推理档位"快速切换同款交互与错误处理 | `frontend/src/statusline.ts`（已有按会话快照缓存 `cache: Map<string, StatusSnapshot>`，mode 随 `StatusSnapshot` 一起缓存） |
| **设置页「会话」页签** | 会话列表增「模式」列（只读 + 切换按钮）；**不加全局模式项** | `frontend/src/ui/config.ts`（导航页：通用配置/工具/会话） |
| **新建会话后的提示** | 切模式后在状态栏提示「将在会话下一轮生效」（复用配置变更的既有文案模式） | `statusline.ts` / `ui/config.ts` 既有 hint 机制 |

**与 statusline/设置的关系裁决**：`mode` **不进**「通用配置」页（那是 `POST /api/config` 的进程级热调面：模型/基址/档位/上下文/系统提示词）。理由：会话工作方式不是全局参数；一旦放进 `POST /api/config`，就会与 `/api/config` 的 epoch 失效语义纠缠成"所有会话一起换模式"。

### 3.3 `agentPreset` 裁决（禁止两套并行语义）

**裁决：`mode` 是唯一模式语义，`agentPreset` 是宿主入参，二者是 `mode → agentPreset` 的**单向派生**关系，翻译点全仓只有一处。**

1. **映射表**（落 `apps/studio/src/runtime/dsh-preset-map.ts`，模块级常量表，K3）：

   | Studio mode | DSH agentPreset | 备注 |
   |---|---|---|
   | `standard` | `standard` | 名字巧合，**不得**因此省略映射（省略即隐式双语义） |
   | `execution` | `code` | 部署侧 `agentPreset` 名（PTC 档）；**未验证**，见 U1 —— 映射缺失/宿主不认时**不传**并记审计，绝不猜测 |

2. **边界在哪**：
   - **Studio 引擎**（`packages/**`、`apps/studio/**`、`contracts/**`）：**不得出现** `agentPreset`/`agent_preset` 字样（M14 用正则门禁钉死）。Studio 的 `spawn_worker` 工具参数名是 **`mode`**。
   - **DSH 侧 spawn 适配层**（`/src/dsh_plugins/celes-worker-spawn`，仓外）：把调用方给的 `mode` 翻译成 `agentPreset` 后透传 `session.create`（该插件已支持，`lib/index.js:227-282`）。翻译表是**它自己的**责任，Studio 不替它决定宿主预设名。
3. **禁止清单**（任一条实现即视为返工）：
   - ❌ `POST /api/sessions` 接受 `agentPreset`（或任何 preset 别名字段）；
   - ❌ `session.json` 存 `agentPreset`；
   - ❌ `mode` 值直接取宿主预设名（如把 mode 设成 `code`/`cordis`/`minimal`）；
   - ❌ 同时提供 `mode` 与 `agentPreset` 两个入口做同一件事；
   - ❌ 两侧各自维护一份"标准/执行 ↔ 预设"的映射（映射只能有一张表、一个调用点）。
4. **与 DSH `agentPreset` 的能力差异必须在文档里说明**：宿主 `agentPreset` 是**整份 preset**（含 persona、工具行、`tool-presentation`），切换受 `agent-preset-locked` 限制；Studio `mode` 只影响**工具访问叙述 + 工具暴露面（P1）**，不影响 persona/其余段落。二者**不是同一个东西**，只是"工作方式"这一层语义同源。

---

## 4. 契约影响（逐条，照 `iteration-e-capabilities.md` §5.3 写法）

约定：**兼容** = 老前端/老客户端不受影响；**变更** = 需同步前端或声明破坏。

### 4.1 `endpoints/data-files/sse-events/tools` 变更清单

| 文件 | 变更 | 阶段 |
|---|---|---|
| `contracts/endpoints.json` | `post_sessions.request` 增可选 `mode`（+ `errors.400` 新文案）；`get_sessions.response` 行增 `mode`；`get_status.response` 增 `mode`；`get_health.response.capabilities` 增 `session_mode`；**P1**：新增 `post_session_mode`（`count` 43→44）；`get_tools.request` 增可选 `session` query | P0 / P1 |
| `apps/studio/src/routes.ts:48` | `API_ENDPOINT_COUNT`：**P0 保持 43**；**P1 改 44**（漏改 → `app.ts:81-109` `assertCoverage` 启动抛错） | P0 / P1 |
| `contracts/data-files/session.schema.json` | `properties` 增 `mode: {"enum":["standard","execution"]}`；`notes` 增「缺省 = standard；非空才写盘；非法值 → 400 `invalid mode: <v>`；`additionalProperties: true` 保持」 | P0 |
| `contracts/data-files/index.json` | **无新增文件、计数不变**（本设计不引入任何新数据文件） | — |
| `contracts/sse-events.json` | `status.payload` 增 **optional** `mode`（仅切换/首轮携带）；事件名集合**逐字不变**（8 个） | P1 |
| `contracts/tools.json` | `spawn_worker.parameters` 增可选 `mode`（enum）；`count` 仍 10、`title` 仍 "(10 tools)"；`run_code` 的 description **不变**（限额数字已一致，`limits.ts:26-43`） | P0 |
| `contracts/rust-route-table.snapshot.json` | `tsOnlyRoutes` 增 `POST /api/sessions/{id}/mode`（W516 先例） | P1 |
| `docs/ARCHITECTURE.md` | §7.1「加一个工具」旁增一句：**工具的模型可见面由 registry 暴露装饰器决定**，新增"按会话隐藏工具"的能力登记到 §3.1 seam 表（若 `exposedRegistry` 被视为新 seam）；§5 例外表若超线需登记 | P1 |
| 本文 | 落地后逐条回填「已实现 / 偏离」 | 全程 |

### 4.2 需要显式声明的**语义变更**（不是纯增字段）

| # | 变更 | 影响 | 缓解 |
|---|---|---|---|
| S1 | `GET /api/config.system_prompt` 从「全局活跃会话的组装结果」收窄为「**聚焦会话**的组装结果」 | 老前端无感（它本来就只显示当前会话）；但"两个会话提示词不同"从此成立 | 在 `config-shape.ts` 的注释与 `contracts/endpoints.json` 的 notes 里写明；M5 断言 |
| S2 | `{{tools}}` 变量的取值源：默认实例（`registry.peek(null)`）→ **聚焦/请求会话的实例** | P0 值相同；P1 起不同（暴露面差异） | 与 S1 同批改动；M9 断言"提示词里的工具清单 == 该会话 schemas()" |
| S3 | P1：execution 模式下 4 个工具**直调返回错误**（不再执行） | 只影响自选执行模式的会话；错误文案给出两条出路（写程序 / 切回标准模式） | 引导错误是**普通 tool 结果**（`error` 字段），不抛异常（`registry.ts:60` 同款形态）；M8 |

**明确不做的契约动作**：不加 SSE 事件名（K5）；不改 `session-event.schema.json`（模式不进事件流——`tool_call`/`tool_result` 形状不变）；不扩 `Profile` 12 键（K7）；不改 `tools.json` 的工具**数量**。

### 4.3 硬断言（会被现有测试/启动检查挡住）

| 断言 | 位置 | P0 | P1 |
|---|---|---|---|
| `API_ENDPOINT_COUNT` == `contracts/endpoints.json#count` == `endpointIds.length` | `routes.ts:48`、`app.ts:85-87`、`tests/contracts.test.ts` | **43（不变）** | **44** |
| `BUILTIN_SECTIONS` 长度 == 10 且 order == `[100..1000]` | `prompts.test.ts:40-42` | **不变** | **不变** |
| 每个内置模板通过 `validateTemplate` | `prompts.test.ts:41` | 两张变体都要过 | 同 |
| 组装结果 ≤ `PROMPT_MAX_LEN` | `prompts.test.ts:160-167` | 新增两变体断言 | 同 |
| `contracts/data-files/index.json` 计数 | `tests/contracts.test.ts` | 不变（无新文件） | 不变 |
| Studio 代码/契约不含 `agentPreset` | 新正则门禁（仿 `ui-copy-tech-notes.md` §209 的建议） | 新增 | 同 |

---

## 5. 分期

### 5.1 P0 —— 最小可用：mode 字段 + 提示词切换（不改工具暴露）

| # | 内容 | 落点 |
|---|---|---|
| 1 | `SessionMode = "standard" \| "execution"` 类型 + `DEFAULT_SESSION_MODE` + `parseMode()`（数据表外提，K3） | `apps/studio/src/store/session-meta.ts`（或 `mode.ts`） |
| 2 | `SessionMeta` 增 `mode?`；`writeSessionMeta` 增 mode（**空值不写键**，K8） | `store/session-meta.ts` |
| 3 | `tool_access` 变体表 + `assembleSystemPrompt(..., mode)` 选变体；变体 A/B 文本按 §1.3 | `store/builtin-sections.ts`、`store/prompts-compose.ts` |
| 4 | **提示词装配下沉到会话**：`SessionComposer` 增 `sessionMode(id)`/`sessionSystemPrompt(id)` 钩子；`profileFor(sessionId)` 同时覆盖 `model` 与 `system_prompt`；宿主在 `createRealRuntimeAdapter` 里注入（与既有 `sessionModel` 同形） | `runtime/session-compose.ts:152-156`、`apps/studio/src/app.ts:64-78`、`runtime/real-runtime-adapter.ts` |
| 5 | `{{tools}}` 与 scope/vars 改为按**传入会话**解析（S1/S2 的前半） | `handlers/config-shape.ts:71-89` |
| 6 | `POST /api/sessions.mode`（校验 + 400 文案 + 写盘）；`GET /api/sessions` 行 + `mode`；`GET /api/status` + `mode`；`/api/health.capabilities.session_mode` | `handlers/sessions.ts`、`handlers/health.ts`（`get_status`/`get_tools`/`get_health` 三个只读端点同在 `health.ts`） |
| 7 | `spawn_worker` 增可选 `mode`（缺省继承父会话）+ 回执头部 `- mode:` 行 | `packages/workers/src/tools.ts`、`receipt.ts` |
| 8 | 契约与测试：`session.schema.json`、`endpoints.json`、`tools.json`、`prompts.test.ts`、`sessions.test.ts`、`app-domains.test.ts` | `contracts/`、各 `*.test.ts` |

**P0 不变量**：`API_ENDPOINT_COUNT` 仍 43；无 `session.json.mode` 的会话行为**逐字节等同今天**（M3）；两模式工具面相同（`registry.schemas()` 名字集合相等，M7 的 P0 形态）。

### 5.2 P1 —— 工具暴露差异 + UI 选择器

| # | 内容 | 落点 |
|---|---|---|
| 1 | `exposedRegistry(inner, {hidden, guidance})`：`schemas()` 过滤隐藏名；`dispatch()` 对隐藏名返回 `{error: "tool_unavailable_in_mode: …（写程序 / 切模式）"}`；`get/register/addGuard` 透传 | `packages/tools/src/exposure.ts`（新）、`packages/tools/src/index.ts` 导出 |
| 2 | **装配接线（本设计的关键机关）**：会话 Context 里 provide 的是**装饰后的 registry**，而 `run_code` 的 `RegistryHandle` 继续绑**内层 registry**（`plugin.ts:131` 现成）→ 子调用不受折叠影响，**无需识别 `:c<n>` 这类 id 形状** | `packages/tools/src/plugin.ts`、`apps/studio/src/runtime/engine-plugins.ts:83-88` |
| 3 | `execution` 模式的暴露面常量表：`{run_code, http_request, process_control, spawn_worker, session_send_message, worker_status}` | `packages/tools/src/exposure.ts`（模块级常量） |
| 4 | 变体 B 增「这 4 个工具不可直调」一句（与实际一致） | `store/builtin-sections.ts` |
| 5 | `GET /api/tools?session=`（缺省聚焦会话）；`{{tools}}` 取该会话实例（S2） | `handlers/health.ts`（`get_tools`）、`config-shape.ts` |
| 6 | `POST /api/sessions/{id}/mode` + `API_ENDPOINT_COUNT` 43→44 + `tsOnlyRoutes` 登记 + 409 文案冻结 | `handlers/sessions.ts`、`routes.ts`、`contracts/` |
| 7 | SSE `status.payload.mode`（切换后一帧）+ 审计 `mode_change` 行 | `sse` 装配处、`store/grants-audit.ts` 同款 |
| 8 | 前端：新建会话「工作方式」下拉、statusline 徽标与切换弹层、设置页「会话」列 | `frontend/src/ui/sessions.ts`、`statusline.ts`、`ui/config.ts`、`types.ts` |

**门禁（G-P1，先于 P1 编码完成）**：U3 探针必须先绿——即"上游 provider 能接受历史里出现已不在 `tools` 列表中的工具名"。探针失败 → P1 只上 UI 选择器与提示词，暴露差异推迟到 P2 并与度量结论一起裁决。

### 5.3 P2 —— 折叠强制力与预算联动

| # | 内容 |
|---|---|
| 1 | 折叠的**引导质量**：错误文案 + 变体 B 文本联合迭代（目标：程序失败后模型优先"修程序"而不是"退回直调"；度量 `放弃率`） |
| 2 | **预算联动**：`execution` 模式的 `run_code` 默认值向硬上限靠（`maxSubCalls` 默认 20 = 现行硬上限；`timeoutMs` 默认 120 000 = 硬上限；**硬上限本身不动**，`limits.ts:29-43` 是安全边界） |
| 3 | **可观测**：`GET /api/status` 增 `run_code:{mode, sub_calls, sub_output_bytes, wall_ms}`（纯增字段）；账本行（能力 3）带 `mode` |
| 4 | **A/B 度量器**（W254 §9 的验收实验，落 `scripts/mode-ab.ts`）：同一批 3–5 个真实多步任务，在 `standard` 与 `execution` 下各跑，产出 `{p(一次成功率), 往返数, 输入/输出 token, 墙钟, 放弃率}`；门槛沿用 W254：`p≥0.8` 且 token 节省 ≥60% |
| 5 | **决策闸门 G-P2**：度量不过线 → 撤销 P1 的暴露差异（保留 mode 与提示词差异，即退回 §5.4 的"E2 保守形态"），把结论写回本文 |

### 5.4 备选形态（诚实记录，供 G-P2 回退）

**E2 保守形态**：`execution` 模式**不隐藏**任何工具，只保留提示词差异 + 预算联动 + 度量。适用条件：U3 探针失败，或 A/B 显示折叠收益不显著/放弃率显著上升。代价：两模式的**可观测差异**只剩提示词与预算（模型仍可能直调），"模式"的产品说服力变弱。**这是可以接受的结局**——W254 §9 本来就判定 Celestea 应"并存"而非折叠。

---

## 6. 可机械检验的验收标准

> 每条都能落成单测/契约测试/可观测断言。落点列给出建议测试文件。

| # | 场景 | 断言 | 落点 | 阶段 |
|---|---|---|---|---|
| M1 | `POST /api/sessions {title, mode:"execution"}` | 200；`session.json` 内容 == `{"mode":"execution"}`（或与 model/prompt 合并后的键集）；`GET /api/sessions` 该行 `mode==="execution"` | `sessions.test.ts`、`app-domains.test.ts` | P0 |
| M2 | `mode:"fast"` | `400 {ok:false,error:"invalid mode: fast"}`（文案冻结）；磁盘**未被写** | `sessions.test.ts` | P0 |
| M3 | 不传 `mode` 建会话 | `session.json` 字节与「今天的写入器」输出**逐字节相同**（无 `mode` 键）；`GET /api/sessions` 该行 `mode==="standard"` | `sessions.test.ts` | P0 |
| M4 | 变体选择 | `assembleSystemPrompt(...,"standard")` **不含** `run_code`；`..."execution"` 含 `run_code` 且含 `ToolCallError` 与 `≤20 sub-calls`；两者均含 `{{tools}}` 展开后的清单 | `prompts.test.ts` | P0 |
| M5 | 每会话提示词隔离 | 同一进程内 standard 与 execution 两会话各自实例的 `profile.system_prompt` 不同；`GET /api/config`（聚焦 execution 会话）返回 execution 变体 | `session-independence.test.ts` 延伸 | P0 |
| M6 | 预算 | 两变体在最大变量集下的组装结果 `byteLength ≤ PROMPT_MAX_LEN`，且各 ≤ 1024 B（防止挤占） | `prompts.test.ts` | P0 |
| M7 | 暴露面 | `execution` 实例 `registry.schemas().map(name).sort()` == `["http_request","process_control","run_code","session_send_message","spawn_worker","worker_status"]`；`standard` == 10 个（含 4 个 SDK 工具）；**P0 两模式相等** | `exposure.test.ts` | P0(相等) / P1(差异) |
| M8 | 折叠 + 子调用放行（同一用例两断言） | `execution` 实例：直接 `dispatch({name:"read_file"})` → `error` 含 `tool_unavailable_in_mode` 且**未执行**；同一实例内 `run_code` 程序里的 `tools.read_file` **成功**（证明 handle 绑内层） | `run-code/broker.test.ts` 延伸 + `exposure.test.ts` | P1 |
| M9 | 防漂移 | `GET /api/tools?session=X` 的名字集合 == `GET /api/config`（聚焦 X）里 `{{tools}}` 渲染出的集合 | `app-domains.test.ts` | P1 |
| M10 | 切换 | 无在飞轮次 → 200，**下一轮**请求的 tools 集合已变（断言第二个 turn 的 request）；有在飞轮次 → 409 且文案 == compact 同款冻结串；日志**无重写**（切换前后既有行 sha256 不变） | `app-domains.test.ts` | P1 |
| M11 | 继承 | `spawn_worker` 不带 `mode` → `GET /api/sessions` 的 `worker:` 行 `mode === 父 mode`；带 `mode:"standard"` → 覆盖为 standard；回执报告含 `- mode:` 行 | `packages/workers` + `app-domains.test.ts` | P0 |
| M12 | 契约 | P0：`API_ENDPOINT_COUNT===43` 且 `assertCoverage` 通过；P1：`===44`；`contracts/endpoints.json#count` 同步；`contracts/tools.json` 的 `spawn_worker.parameters.properties.mode` 存在且 `count===10` | `app.test.ts`、`tests/contracts.test.ts` | P0/P1 |
| M13 | 段注册表回归 | `BUILTIN_SECTIONS.length===10` 且 order 数组 `[100,…,1000]` 不变；每段模板 `validateTemplate===null` | `prompts.test.ts`（既有用例保持绿） | P0 |
| M14 | 单一语义门禁 | `contracts/**` 与 `apps/studio/src/**`、`packages/**` 中**无** `agentPreset|agent_preset` 字样（正则门禁）；映射表单测 `standard→standard`、`execution→code`，未知 mode → `null`（不传宿主） | `scripts/` 门禁 + `dsh-preset-map.test.ts` | P0 |
| M15 | P2 度量 | `scripts/mode-ab.ts` 产出 JSON 含 `p/turns/tokens/wall_ms/abandon_rate` 且样本 ≥3 任务 × 2 模式；结论行写明门槛判定（`p≥0.8 && saved≥60%`） | `scripts/mode-ab.ts` 报告 | P2 |
| M16 | P2 预算联动 | `execution` 模式 `runCodeConfig()` 的 `maxSubCalls===20`、`timeoutMs===120000`（数值冻结断言）；`standard` 模式 == 今天的默认值 | `run-code/limits.test.ts` 延伸 | P2 |

---

## 7. 风险与未验证假设（诚实清单）

### 7.1 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | **折叠的失败面**：模型反复直调被折叠的工具（DSH 形态下这是主要失败模式） | 引导错误必须给**两条出路**（写程序 / 切回标准模式）；P2 度量 `放弃率`；E2 回退形态常备 |
| R2 | **"程序写不出来"困在执行模式** | 轮次边界可切模式（非 blank-only，M10）；变体 B 明写"失败优先修程序，其次回退"；`run_code` 结构化错误带日志尾部供自纠 |
| R3 | **提示词装配下沉是本次最大的实现风险**：现装配在启动时按全局活跃会话做一次（`app.ts:96`、`real-runtime-adapter.ts:168`），每会话只覆盖 `model`（`session-compose.ts:154`）。若只加 `mode` 字段而不下沉装配，会出现"模式只对聚焦会话生效、后台会话仍用旧提示词"的静默错误 | P0 把"下沉"列为必做项（§5.1 #4/#5）；M5 用**两个会话同进程**断言 |
| R4 | **用户 override 遮蔽模式差异**：`tool_access` 被 global/workspace/prompt 覆盖时，模式只剩预算/暴露面差异（四层优先级，`prompts.ts:1-13` 的注册表层级注释） | 文档化 + 前端在设置页提示"该段已被覆盖，模式提示词不生效"；不改优先级 |
| R5 | **8KB 预算**：现 3835 B / 8192 B，余量约 4.3 KB；变体 B 若继续加长会挤占 `environment`（1106 B），最终触发**尾部静默截断**（`context` 段最先被砍） | 变体文本硬约束 ≤1 KB（M6）；后续若需长文本，先做分段预算（W253 §5-S5），本文不解决 |
| R6 | **两个 spawn 平面混淆**：引擎内 `worker:<sid>`（Studio）与 DSH 外部 fleet（`celes-worker-spawn`）都有"spawn_worker" | 命名区分：Studio 侧参数叫 `mode`；`agentPreset` 只出现在 DSH 适配层；M14 门禁 |
| R7 | **`agentPreset` 映射的宿主可用性**（预设 id 已核实为 `ptc`；宿主是否暴露 `agentPresets` 服务仍待实测） | 映射表 `null` 兜底（不传 + 审计），P1 前用 `GET {prefix}/presets` / `agentPreset.list` 实测（U2） |
| R8 | **收益被夸大**：执行模式的 token 收益来自往返折叠而非 schema 折叠（§1.2），而 `p` 未实测 | P2 前**禁止**在文档/UI 里宣称收益数字；M15 用实测替换估值 |
| R9 | **切换模式后的历史合法性**（历史里有已隐藏工具名） | U3 探针；失败则 E2 形态；**永不重写日志**（K4） |

### 7.2 未验证假设（U 清单）

| ID | 项 | 状态 | 影响 |
|---|---|---|---|
| U1 | **DSH 宿主 PTC 预设的实际 id** | **已核实（架构师 2026-09-11，sudo 读安装树）**：内建预设 = `standard` / `ptc` / `minimal` / `cordis`（`@deepseek-ai/dsh-agent-presets/lib/types/display.js` 的 `BUILT_IN_PRESET_KEYS`）；`/opt/dsh/.agent-presets/code` 自述是 builtin `standard` 的 0.1.2 兼容别名（**不是 PTC**）；`/opt/dsh/settings.yaml` 的 `agent-presets.default = ptc` | 映射已定：`standard→standard`、`execution→ptc`；`code` 禁止用于执行模式 |
| U2 | **DSH 0.1.5 宿主是否暴露 `agentPresets` 服务/RPC**（插件 README 提到 0.1.1 回退 `apiProxy`） | **未验证**（同上，无安装树读权限） | 同上；外部 fleet 的 mode 传递可延后 |
| U3 | **上游 provider 对"历史中出现已不在 `tools` 列表里的工具名"的容忍度** | **未验证**（未做探针） | P1 暴露差异的**前置门禁**（G-P1）；失败 → E2 形态 |
| U4 | **模型在 Celestea 工具面上写 Python 程序的一次成功率 `p`** | **未实测**；W254 §5 的 `pro 0.85–0.93 / flash 0.70–0.85` 是**估值** | 决定 P2 去留；P2 的 A/B 是唯一定价手段 |
| U5 | **折叠的 token 净收益** | **本次静态测算**（10 schema 10 768 B；4 个被折叠 1 321 B；段文本 +400~700 B）→ 净收益接近 0 甚至略负 | 禁止用"省 token"当 P1 卖点；收益论证必须回到往返折叠 |
| U6 | `{{tools}}` 取值源改动（默认实例 → 会话实例）的外部影响面 | **设计判断**：grep 全仓仅 `config-shape.ts:83` 一处消费该变量；**未做前端实测** | 若发现别处消费，需一并纳入 S2 |
| U7 | 前端 `statusline.ts` 的按会话快照缓存能否直接承载 `mode` 字段 | **未验证**（前端无测试基建） | P1 的人工联调项：两会话分别为标准/执行时徽标不串台 |
| U8 | `POST /api/sessions/{id}/mode` 的忙碌守卫与 `compact` 是否可完全同款（含 Rust 共存期语义） | **未验证**：Rust 参考实现无此端点（TS-only），需登记 `tsOnlyRoutes` 并确认前端在 Rust 后端下不调用（`/api/health.capabilities.session_mode_tools` 能力位兜底） | P1 落地前确认；能力位已设计 |
| U9 | 「无 mode 键 = standard」在**旧会话目录**（历史创建，无 mode）上的行为 | **已定**：等价 standard（K8），但**未**对生产会话目录做全量盘点（可能已有手工写入的未知键） | `additionalProperties: true` 容忍未知键；M3 只断言"不传 mode 时字节不变" |

---

## 8. 与其他设计文档的关系

| 文档 | 关系 |
|---|---|
| `iteration-e-capabilities.md` | mode 与能力 3（账本）在 P2 交汇：账本行带 `mode` 才能回答"执行模式到底省了多少"；本文不复制其 P0 内容，只依赖其 `attempt` 维度约定 |
| `feature-session-independence.md`（已实现） | 本文的**基座**：每会话实例 + epoch 重建 + SSE `session` 信封使"每会话 mode"成为可能；本文不改其任何裁决 |
| `feature-session-grants.md`（已实现） | 会话级配置文件的读写/容错/审计纪律**直接复用**（`session.json` 与 `grants.json` 的差别只在容错等级：前者忽略错误，后者整份忽略 + 告警） |
| `ui-copy-tech-notes.md` | 新增 UI 文案（「工作方式」「标准模式」「执行模式（PTC）」）需过其文案规范；`mode` 值不直接暴露给用户（显示中文标签） |
| W253/W254/W255（harness 侧） | 本文只**承接**其结论：不做 PTC_ONLY 禁令、不做代码生成器、`run_code` 保持并存形态、P2 度量门槛沿用 W254 §9 |

---

## 9. 范围声明（本文未做的事）

- **不改任何代码/配置/服务**，不 commit、不 push；
- 不新增 SSE 事件名（K5）、不改 `session-event.schema.json`、不重写既有日志行（K4）、不扩 `Profile` 12 键（K7）；
- 不安装/不修改 DSH 宿主与 `celes-worker-spawn`（仓外），只在 §3.3 声明映射边界；
- 不做 per-turn 模式（D2）、不做全局模式（§2.1 方案 C）、不做 PTC_ONLY 式禁令（§1.1）；
- 不解决 8KB 静态预算的结构问题（R5，属 W253 §5-S5 的范围）；
- 本文所有 token/墙钟数字均为**静态测算或转引估值**，不是实测；任何允许写入产品文案的数字必须来自 M15 的 A/B 报告。

---

## 10. P0 落地状态（W729，2026-09-11 实读代码回填）

### 10.1 两处口径订正（先修，见 §10.2 的 D6/§5.1 冲突）

| # | 设计原文 | 落地口径（以此为准） | 依据 |
|---|---|---|---|
| C1 | D6/§5.1：P0 `API_ENDPOINT_COUNT` **保持 43** | **44**（`GET /api/sessions/{id}/context` 已在 W725 上线，43 是写文档当日的基线）。P0 **零新端点**，44 不变 | 本仓 `apps/studio/src/routes.ts:49`、`tests/contracts.test.ts` |
| C2 | §5.1 #6「`POST /api/sessions.mode`」在 P0 表内 | P0 的 mode **只在创建时设定**：`POST /api/sessions` 收可选 `mode`；运行期切换端点 `POST /api/sessions/{id}/mode` 属 **P1** | D6「零新端点」优先 |

### 10.2 §5.1 逐条对照

| §5.1 # | 内容 | 状态 | 落点 |
|---|---|---|---|
| 1 | `SessionMode` / `DEFAULT_SESSION_MODE` / `parseMode()`（表外提，K3） | ✅ | `apps/studio/src/store/mode.ts`（另有 `effectiveMode`/`validateMode`/`isSessionMode`） |
| 2 | `SessionMeta.mode`；写盘空值不写键 | ✅ | `store/session-meta.ts`（读盘非法值丢弃 = 缺键） |
| 3 | `tool_access` 变体 A/B；`assembleSystemPrompt(..., mode)` | ✅ | `store/builtin-sections.ts`（`TOOL_ACCESS_VARIANTS` + `builtinRowsFor`）、`store/prompts.ts`、`store/prompts-compose.ts` |
| 4 | 提示词装配下沉到会话（R3） | ✅ | `runtime/session-compose.ts`（`sessionMode`/`sessionSystemPrompt` 钩子 + `profileFor` 覆盖 `model` 与 `system_prompt`）、`app.ts`（宿主注入，`HostRef` 晚绑定） |
| 5 | `{{tools}}` 与 scope/vars 按传入会话解析（S1/S2） | ✅ | `handlers/config-shape.ts`（`assembleSystemPromptFor(deps, sessionId?, mode?)`）、`RuntimeAdapter.sessionTools`（peek，不递归组装） |
| 6 | `POST /api/sessions.mode` + 行/status/health 字段 | ✅（无切换端点，见 C2） | `handlers/sessions.ts`、`handlers/health.ts`、`store/sessions.ts` |
| 7 | `spawn_worker.mode` + 回执 `- mode:` 行 | ✅ | `packages/workers/src/{tools,registry,receipt,sessions,types}.ts`、`packages/runtime/src/worker-wiring.ts` |
| 8 | 契约与测试 | ✅ | `contracts/{data-files/session.schema.json,endpoints.json,tools.json}`、`prompts.test.ts`、`sessions.test.ts`、`app-modes.test.ts`、`runtime/session-modes.test.ts`、`packages/workers/*.test.ts`、`tests/contracts.test.ts` |

### 10.3 P0 三条不变量（都是测试名）

| 不变量 | 断言 | 测试 |
|---|---|---|
| ① 无 `session.json.mode` 的会话行为逐字节等同今天 | 写入器输出与 W729 前的字面量逐字节相同（无 `mode` 键；无内容则不建文件）；无 mode 的会话**不做任何按会话覆盖**，其 `profile.system_prompt` 就是进程基线提示词 | `store/sessions.test.ts > M3/K8…`、`runtime/session-modes.test.ts > P0 invariant ①…` |
| ② 两模式在 P0 的 `registry.schemas()` 名字集合相同 | 两会话的 `names().sort()` 相等且为 10 个契约工具 | `runtime/session-modes.test.ts > P0 invariant ②…` |
| ③ `API_ENDPOINT_COUNT` 仍 44 | 常量 == `contracts/endpoints.json#count` == 44，且无 `post_session_mode` | `app.test.ts > W729 P0 invariants ③…`、`tests/contracts.test.ts` |

### 10.4 与设计文本的三处偏离（诚实登记）

| # | 设计原文 | 落地 | 理由 |
|---|---|---|---|
| D-a | M4：「`standard` 组装结果**不含** `run_code`」 | 变体 A 含 `` `run_code` `` 一词（"…is available when a task needs several dependent calls…"），因此断言改为「不含 `Execution mode` / `ToolCallError` / `≤20 sub-calls`」 | §1.3 的变体 A 正文与 M4 自相矛盾；本仓以 §1.3 的落地级文本为准（任务书亦如此要求） |
| D-b | M6：两变体「各 ≤ 1024 B」 | A = **353 B**、B = **1068 B**（B 超软上限 44 B）；合并总长 3571 B / 4286 B，均远低于 `PROMPT_MAX_LEN = 8192` | §1.3 的 B 文本自身就有 1068 B（与其"+450 B"的估算一致），改文本会偏离 §1.3 |
| D-c | §1.3/P1：变体 B 加一句「这 4 个工具不可直调」 | **未加**（P0 暴露面相同，加了就与事实不符） | §1.3 自己规定该句「必须与实际暴露面一致」，故与 §5.2 #4 一起推到 P1 |

### 10.5 P0 的已知深度限制（P1/P2 待办）

1. **`spawn_worker.mode` 在 P0 只影响元数据与回执**：`worker:<sid>` 的轮次仍由宿主会话那一个 generation 的 loop/profile 驱动（`engine-plugins.ts` 的 `engineLoopPlugin(input.profile)`），所以显式 `mode:"standard"` 覆盖**不会**改变该 worker 的提示词，只改变它的会话元数据、`GET /api/sessions` 行与报告头。默认继承（不带参数）在效果与标注上都是一致的。
2. **`{{tools}}` 在装配期用 peek 取值**：`sessionTools()` 读该会话**已有**实例的 `schemas()`，没有实例时退回默认 generation。P0 两模式暴露面相同（§1.2），故当前值恒等；P1 引入 `exposedRegistry` 后必须在重建前重新取值（否则会用到上一代的暴露面）。
3. **无 mode 的会话不做按会话装配**（K8 的取舍）：`sessionSystemPrompt` 钩子在**已声明 mode** 时才返回该会话的组装结果，其余会话继续用进程基线提示词。代价是老会话的 `{{session}}`/`{{workspace}}` 仍来自基线（今天的既有事实）；收益是「无 mode 键 = 逐字节等同今天」这条不变量可断言。
4. **`GET /api/config` 的口径**：作用域/绑定/mode 取被聚焦会话（S1），但 `{{model}}`/`{{tools}}` 仍走历史口径（进程模型 + 默认 generation），以免改变无 mode 会话的既有输出；引擎侧（会话实例）用的是该会话自己的模型与工具面。
