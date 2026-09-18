# 特性设计 · 动态工具披露（借鉴 DSH，落地 Celestea 引擎）

> 状态：**只调研与设计（W802，2026-09-16，第 2 版）**。本文不落地任何代码；所有「现状」标注 `文件:行号`；
> 所有 DSH 事实标注 `文件:行号` 与来源树；所有实测数字来自本轮/上一轮探针或既有账本，**未实测项一律标注「待验证」**。
> 第 2 版改动：① 补入 DSH 官方 cookbook 的**渐进式披露配方**（§1.7b–d），纠正第 1 版把 pi-ai 兼容门误读为「DSH 不做渐进披露」；② 缓存章节增加**本轮独立复核探针 A1–A7**（§3.3）；③ 修正账本快照的时点标注；④ 重派 W802 复核补录 **W1–W7 二次独立复核**（§3.3，独立前缀 12808 prompt）与账本重算。
> 范围：只改本文；不改 contracts / tests / fixtures / 产品代码；不新增依赖；不重启服务。
> 前置阅读：`docs/modes-standard-vs-execution.md`（双模式折叠 W729/W791）、`packages/tools/src/exposure.ts`、`docs/feature-session-grants.md`。
>
> **W884 回填（技能渐进披露落地，2026-09-19）**：本文 §1.7d 记录的 DSH 先例（「目录常驻、正文按需」）已在本仓落地为**两个正交面**，与本文的动态工具披露**无关、不共用**：
> 1. **目录常驻**：`packages/core/src/skill-catalog.ts` 只渲染 `name + description`（description >200 字符截断、≤32 条、按名排序并注明截断），由宿主在每个 **turn 起点**作为 **durable user-role 消息**追加进会话日志（`packages/runtime/src/turn-runner.ts` 的 `turnContext`，注入在 receipts/输入之前）；**不进 system prompt**（W874/W879 的裁决：system 在 tools/history 之前，改它会从 token 0 打断 KV 前缀缓存）。没有技能 → 一行都不注入（零成本）。
> 2. **正文按需**：第 14 个契约工具 `load_skill`（`packages/tools/src/tools/load-skill.ts`）返回 SKILL.md 正文 + 目录，**绝不内联** references/scripts；未命中/非法 frontmatter 返回 `load_skill: code=… msg="…"` 结构化错误。
>
> 计数同步：`contracts/tools.json` **13 → 14**（有意契约变更）；`EXECUTION_TOOL_NAMES` 加入 `load_skill`，因此 execution 面 **7 → 8**，standard 面 **13 → 14**。加它的理由见 `exposure.ts`：它是纯读，且不在 `SDK_TOOLS` 白名单里，折叠会让执行模式下技能不可达而目录仍在宣传它们。

---

## 0. 结论速览

| # | 议题 | 裁决 |
|---|---|---|
| D1 | DSH 的「动态工具披露」到底是什么 | **内核没有内建延迟披露 / tool search，也不按 step 收敛 schema。**内核的动态维度是：①按 agent 作用域（agent preset）分层组装注册表 + per-scope 呈现开关 `native/ptc/both`（compose 时固定、每次 prompt 装配重算）；②运行期 MCP 工具列表变更。**官方 cookbook 另给出渐进式披露的自建配方**：可见集变化时**替换一个 scoped `ctx.tools.restrict()` 注册**，由单一 resolver 保证展示/查找/执行三者对齐（§1.7b）。模型只从新的 `tools` 数组得知；被 restrict 掉的名字读作 unknown（`UNKNOWN_TOOL`）。 |
| D2 | 我们对它的正确映射 | `exposedRegistry` 与 DSH `restrict()` 是同一角色的两个实现（都同时决定 schemas/lookup/execution），差异有二：①我们拒绝形状更强（执行前 `deny`，不是 unknown）；②我们**刻意**让 `run_code` 子调用放行，而 DSH 的对齐语义会连带限制子调用（§2.5）。落法：在模式基线之上叠加第二层「按需披露」，把 `hidden` 从常量改为「按 step 读取的不可变快照」。 |
| D3 | 缓存（本设计的关键约束） | 11 个真实工具 ≈ **4329 prompt token**（§3.2，V1−V0，上一轮真实 11 工具探针）；请求序列化顺序 = **system → tools → messages**（§3.2 结论 L1）。**tools 数组的任何变化都会让它之后的 token（含整段历史）从变动点起失效**（§3.3 结论 L3；上游判据 = 严格 token 字节前缀，不是按段缓存）。**「只增 + 尾部追加」不是免费，只是四害相权取其轻**：§3.3 实测**相对序 = 稳定态 ≫ 尾部追加 > 中段删 > 首工具移尾**（A 组命中率 97.5% > 67.7% > 37.6% > 23.3%，口径 = 真实 11 工具 + 合成尾部工具 + 16 轮历史、prompt 8795；W 组同向 98.9% > 56.9% > 35.8% > 26.0%，口径 = 独立前缀 12808）。**追加的代价随会话长度增长**（§3.5：A 组一次「追加 1 工具」需重算 ≈ prompt 的 27.6%（2432/8795），W 组同向 ≈ 41.0%（5248/12808）；两轮绝对值不可比，只可采信相对序与「随历史增长」的方向）。改动后下一次请求即回 97.7% / 98.1%（一次性重热，§3.3 L4）。**结论（四条硬约束）：动态披露必须 ① 只在 turn 边界、② 单调只增、③ 新增追加在数组尾部、④ 系统提示词绝不随披露变。** |
| D4 | 与双模式折叠的关系 | **叠加，不取代**。`exposure.ts` 继续做模式基线折叠；动态披露是第二层。`run_code` 子调用放行语义**天然不变**（handle 绑内层 registry）。 |
| D5 | 契约 | P0 **零新端点、零新工具**：`API_ENDPOINT_COUNT` 保持 **51**，`contracts/tools.json` 保持 **11**。新工具 `tool_search` 仅在 P2 评估。 |
| D6 | 安全 | 披露 = **可用性**，不是授权。未披露工具的直接调用仍必须被拒（`tool_unavailable_in_mode`，执行前拒绝）；动态 hidden 不得绕过 grants/sandbox/guard，不得削弱模式折叠。 |
| D7 | 唯一不可回避的成本 | 每次披露变化 = **一次重热**（A3/A5/A6）；改动后下一步即回 97.7%（A7）→ 频率必须「每 turn ≤1 次」，不能每 step。 |

> **缓存措辞澄清（W840 回填，只动本文）**：速览只引用 §3.3 的**实测相对序**——**稳定态 ≫ 尾部追加 > 中段删 > 首工具移尾**。不同轮次（A 组 prompt 8795 / W 组 prompt 12808；上一轮 H 组 prompt 8434）的**绝对命中率与 token 数不可比**（前缀长度、历史占比、合成工具形态不同），**只可采信相对序**。**「只增 + 尾部追加」不是无损、也不是免费**：它仍把追加点之后的**全部已缓存历史**打成 miss，且该代价**随会话长度增长**；所谓「四害相权取其轻」，就是说不改（稳定态）之外，尾部追加 / 中段删 / 首工具移尾（及任意重排）都会打断缓存，而尾部追加是其中代价最小的一种（§3.5）。凡数字均出自 §3.2 / §3.3 / §3.5 的探针表；未实测项一律标「待验证」。

---

## 1. DSH 侧事实（逐条出处）

### 1.0 来源标注（重要）

本 session 宿主安装树 **root-only 不可读**（2026-09-16 复核仍如此）：

~~~text
$ id
uid=1003(celestea) gid=1003(celesdev) groups=1003(celesdev)
$ ls -la /opt/dsh/profiles/web/
ls: cannot open file '/opt/dsh/profiles/web/': Permission denied
$ ls /opt/dsh
ls: cannot open directory '/opt/dsh': Permission denied
~~~

进程表可佐证本 session 宿主就是 `/opt/dsh/profiles/web`（GUI 端口 3180）：

~~~text
$ ss -ltnp | grep -E '3180|3001|3777'
LISTEN 127.0.0.1:3777   users:(("MainThread",pid=2741249,fd=39))   # studio (celestea)
LISTEN *:3001                                                      # newapi docker
$ pgrep -af 'dsh/lib/bin.js'
2917694 /usr/bin/node /opt/dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 3180
~~~

因此本文全部 DSH 事实来自**同机可读的源码副本**，如实标注为副本（W790/W793 的做法）：

| 代号 | 路径 | 版本（`package.json`） |
|---|---|---|
| **[015]** | `/opt/dsh-src-015/` | `0.1.5-alpha.1` |
| **[013]** | `/opt/dsh-src-013/` | `0.1.3-alpha.1` |

**这不是本 session 实际安装树**；能读到实际安装树时应复核（**待验证** U6）。除特别标注外，行号取自 [015]。

### 1.1 注册点：per-agent-scope 的分层注册表（host-plane 服务 + agent-plane 层）

- 工具服务 `ctx.tools` 的每个 scope 有一个 `ToolLayer`，由 `ScopedLayers` 管理；可见集由「全局层 + scope 链」一次遍历导出 —— [015] `packages/core/tools/src/index.ts:707-747`（`ToolLayer`）、:804-809（`layers` / `defaultMode`）。
- agent preset 是一份 `agent.cordis.yml`，它携带的插件行注册进**该 scope** 的 layer —— [015] `packages/preset/agent-presets/presets/`（`standard/` `ptc/` `minimal/` `cordis/` 各一份）。
- 模块头注释明说：**注册表留在 host plane，preset 只拥有 presentation**；`ctx.tools.presentAs()` 为 mounting scope 声明呈现 —— [015] `packages/core/agent-tool-presentation/src/index.ts:1-19`。

**结论 1.1**：DSH 的「按 agent/preset 动态组装注册表」= **compose 时的作用域分层**，不是运行期按 step 重算。

### 1.2 呈现模式 `native/ptc/both`：披露的静态旋钮

- 类型定义 —— [015] `packages/core/tools/src/index.ts:644`：
  `export type ToolPresentationMode = 'native' | 'ptc' | 'both'`
- 语义（`Config.mode` 文档，[015] `.../index.ts:646-658`）：`native` 发全部可见 schema；`ptc` **只发 `run_code`** + 一段生成的 SDK prompt，并把 executor 折叠成同一个面（模型直调只能叫 `run_code`，`run_code` 内子调用仍可到所有可见工具）；`both` 两者都发。
- 折叠实现 —— [015] `.../index.ts:972-993`（`wireSchemas`）：
  ~~~ts
  if (mode === 'ptc') {
    return { schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME), knownNames: [RUN_CODE_NAME] }
  }
  ~~~
- 选择点：`presentAs(mode)` per scope —— [015] `.../index.ts:938-966`；`modeFor(scope)` 沿 scope 链就近取胜 —— [015] `.../index.ts:892-903`。
- preset 侧声明 —— [015] `packages/preset/agent-presets/presets/ptc/agent.cordis.yml:269-272`。

### 1.3 披露时机：compose 时定模式，**每次 prompt 装配重算**，不是每 step 增减

- `wireSchemas(scope)` 注册为 system prompt 的 tools provider —— [015] `.../index.ts:825`：
  `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`
- 每次 step 的 prompt 装配调用它 —— [015] `packages/core/agent-loop/src/agent.ts:245`：
  `const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`
- 对同一 scope，可见集与 mode 不变时输出稳定；**内核没有**「按上下文逐步收敛 schema」的机制。

### 1.4 内核唯一的运行期动态来源：MCP 工具列表变更

- `syncTools` 两阶段（fetch 下一代 → swap 注册/注销），失败保留上一代 —— [015] `packages/mcp/mcp-client/src/tools.ts:150-192`。
- 收到 MCP `notifications/tools/list_changed` 时 re-sync —— [015] `packages/mcp/mcp-client/src/connection.ts:257-270`。
- 注册表变化 emit `tools/change` —— [015] `packages/core/tools/src/index.ts:806`。

### 1.5 模型如何得知？tools 数组每请求重算，**变化时打断 request series**

- `toolsChanged()` 用 header 相等比较上一份 `request/header` —— [015] `packages/core/agent-loop/src/agent.ts:262-266`。
- `startsRequestSeries = ... || this.toolsChanged(assembly.tools)` —— [015] `agent.ts:363-369`；schema 变化 → 新 request series → `systemPrompt.project(..., {startsSeries:true})` + 记 `request/header` —— [015] `agent.ts:562-582`。
- 文档明文：「A step starts a series when … **visible tool schemas changed**」 —— [015] `packages/core/agent-loop/README.md:121`。

### 1.6 PTC 折叠：仍可见但禁止直调；被拒错误形状

- **不可见**（未注册/被 restriction 滤掉）直接调用 → `ToolNotFoundError`，code `UNKNOWN_TOOL`，message `unknown tool "<name>"` —— [015] `packages/core/tools/src/index.ts:487-503`。
- **PTC 折叠**（仍可见但禁止直调）→ 同一个 `ToolNotFoundError`，但带 `reachableFrom`（教模型改走 run_code）—— [015] `.../index.ts:1413-1433`：
  `only run_code is callable directly — call <name> from inside a run_code program instead`
- 谓词：`collapses(name, scope, nested) = !nested && modeFor(scope)==='ptc' && name !== RUN_CODE_NAME` —— [015] `.../index.ts:1314-1316`（`nested` = run_code 子调用，**永不被折叠**）。
- 折叠在 pre-execute / approval / guard **之前**就终止：「policy listeners must never observe a call that can only fail」 —— [015] `.../index.ts:1363-1369`。
- 提示词侧用**同一谓词**渲染 `PTC_ONLY_INSTRUCTION` —— [015] `.../index.ts:847-855`（注释解释为何需要它：`.../index.ts:838-842`）。

### 1.7 内核没有内建 deferred-tools；pi-ai 兼容门三个字段全部 withhold

- pi-ai 兼容门用一个显式二值：`type CompatDisposition = 'offer' | 'withhold'` —— [015] `packages/llm/llm-pi-ai/src/catalog.ts:224`。
- 三个「延迟/按需工具」相关字段全部 **withhold**：
  - `deferredToolsMode: 'withhold'` —— [015] `catalog.ts:256`
  - `supportsAdditionalTools: 'withhold'`、`supportsToolSearch: 'withhold'` —— [015] `catalog.ts:268-269`
  - [013] 同形 —— `catalog.ts:240`、:251-252。
- **解读纠正（第 1 版此处误判）**：这三个字段是 *pi-ai provider 兼容开关的透传门*（`COMPLETIONS_COMPAT_GATE` / `RESPONSES_COMPAT_GATE`，注释见 `catalog.ts:218-230`），只说明「DSH 的 pi-ai 适配层不向用户透传 deferred-tools / tool-search 这类 vendor 协议开关」，**不等于** DSH 不支持渐进式披露。官方给出的自建配方见 §1.7b。

### 1.7b 官方 cookbook 的渐进式披露配方：**替换 scoped `ctx.tools.restrict()` 注册**

- 产品功能表逐字 —— [015] `docs/cookbook/extension-cookbook.md:116`（中文 [015] `docs/cookbook/extension-cookbook.zh.md:120`；[013] `docs/cookbook/extension-cookbook.md:116` 同文）：
  > `ToolSearch / progressive disclosure | replace a scoped ctx.tools.restrict() registration as the visible set changes; the registry keeps presentation, lookup, and execution aligned`
- 同一文档 :102 选型建议：需要在「展示 / 查找 / 执行」之间保持对齐的工具过滤，**优先 `ctx.tools.restrict()`**，不要改 `system-prompt/assemble`。
- 另一拦截点（更弱、不推荐）：「工具过滤（ToolSearch / 渐进式披露）是一次 assembly 重写」 —— [015] `.agents/notes/archived/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md:14`；`docs/subsystems/system-prompt.md:28` 定义 `ToolProviderResult.schemas` = 当前装配的模型可见集、`knownNames` = 过滤前名字宇宙。

### 1.7c `restrict()` 的注册点 / 时机 / 对齐 / 拒绝形状（逐条）

- 签名与语义 —— [015] `packages/core/tools/src/index.ts:1054-1088`（文档同文 `docs/subsystems/tools.md:506-513`）：
  - **scoped-only**：全局上下文调用报错「tools.restrict() requires a scoped context」 —— :1063-1064；
  - `allow`/`deny` 至少一个，空 filter 报错 —— :1068-1069；
  - **拒绝命名保留传输 `run_code`** —— :1075-1076；
  - 命名未知全局工具报错，并列出 `known global tools` —— :1078-1081；
  - 落到 `ToolLayer.restrictions`（:709），经 `ScopedLayers.effect` 注册并返回**精确 disposer** —— :1083-1088。因此 cookbook 说的「replace a scoped registration」= **dispose 旧注册 + 注册新的**，运行期可随可见集变化而替换。
- **对齐由单一 resolver `view()` 保证** —— [015] `index.ts:1142-1183`：同一次 `visible` 映射喂给 wire schema、`get()` 查找与 dispatch 执行；`run_code` 传输在能力过滤**之外**最后插入（:1174-1181）。
- **注册表变化广播** —— `ScopedLayers` 的 onChange 回调 `() => this.ctx.emit('tools/change')` —— [015] `index.ts:804-807`。
- **披露时机**：`wireSchemas(scope)` 是 system prompt 的 tools provider（:825），每次装配调用（`agent.ts:245`）→ restrict 一变，**下一次装配**就是新可见集。
- **模型如何得知**：`toolsChanged()`（`agent.ts:262-266`）→ `startsRequestSeries`（`agent.ts:363-369`）→ 新 request series（`agent.ts:562-582`）。没有内建 `tool_search` 工具，也没有 deferred 标记——模型**只从新的 `tools` 数组得知**。
- **未披露工具的拒绝形状**：被 restrict 掉的名字对 `get()` **读作不存在**（`docs/subsystems/tools.md:527-536`）→ dispatch 走「未知工具」路径 → `UNKNOWN_TOOL`，message `unknown tool "<name>"`（`index.ts:487-503`）。**注意**：该路径刻意留在 dispatch 阶段，**policy listeners 仍会看到这个名字**（`index.ts:1363-1369` 注释：An unknown tool keeps the historical dispatch-stage UNKNOWN_TOOL path so policy listeners still see every name that reaches the registry.）。
- 与 PTC 折叠的区别：折叠的名字**仍可见**、拒绝带 `reachableFrom`、且在 policy 之前终止；restrict 的名字**不可见**、拒绝是裸 `UNKNOWN_TOOL`、且在 policy 阶段。二者都不可执行。

### 1.7d 另一个「按需披露」先例：skill（披露的是指令，不是工具）

- skill 系统自述就是 "progressive disclosure instructions for agents" —— [015] `.agents/notes/archived/feature/2026-07-05-skill-system.md:1`；「把完整正文塞进每个 system prompt」被明确否决（:36）。
- 正文在调用 `skill(name)` 时才读文件注入，**不做正文缓存/哈希/预热** —— [015] `.agents/notes/archived/feature/2026-07-27-skill-catalog-hot-refresh.md:26`。即：**目录常驻、正文按需**。

### 1.8 DSH 自己的 KV-cache 口径（与我们探针互证）

- 「Append-only only while **system text, schemas, and earlier history remain byte-identical** under the same provider and model route. … **A schema or composition change invalidates reuse from the first altered request token.**」 —— [015] `packages/core/agent-loop/README.md:160`。
- 「A later header with changed config or schemas may invalidate reuse from its **first difference**; a prompt change that replaces surface node 0 invalidates reuse from the **first token**」 —— [015] `packages/core/session/README.md:174`。
- header 比较是逐字段 + tools **按位 JSON.stringify 相等** —— [015] `packages/core/session/src/request-header.ts:21-52`。即 DSH 的「变化」判据是语义相等，但**供给商的 cache 是字节前缀**（与 §3 探针一致）。

### 1.9 环境变化登记（本次必须记下）

- 内建 preset key = `standard` / `ptc` / `minimal` / `cordis` —— [015] `packages/preset/agent-presets/src/display.ts:42-47`；[013] 同目录同键。preset 目录名同 —— [015] `.../presets/`（本 session 复核 `ls` 得 `cordis minimal ptc standard`）。
- `presets/ptc/preset.yml` 自述 `name: PTC 模式`。
- **旧名 `code` 的残留（漂移证据）**：
  - 仓库外插件 `/src/dsh_plugins/celes-worker-spawn/README.md:68` 仍写 `| code | PTC 模式 |`。
  - 本 session 注入的 `spawn_worker` schema 描述也仍写 `code（PTC）`。
  - → **宿主内建 key 已是 `ptc`，插件文档/工具描述滞后**。任何映射必须用 `ptc`；本引擎契约层**永不出现** `agentPreset`（沿用 `docs/modes-standard-vs-execution.md` M14 门禁）。
- 与本 session 实际安装树相比的偏差：无法核实（`/opt/dsh` root-only）。**待验证** U6。

---

## 2. 对我们的映射：可复用 seam + 最小新缝

### 2.1 既有 seam（实读）

| seam | 位置 | 复用方式 |
|---|---|---|
| `exposedRegistry(inner, {hidden, guidance})` | `packages/tools/src/exposure.ts:159-161` | 动态披露的落点：把 `hidden` 从常量改为「按 step 读取的不可变快照」 |
| `ExposedRegistry.schemas()/dispatch()` | 同文件 :144-151 | `schemas()` 过滤、`dispatch()` 对 hidden 名**执行前**返回 `folded()`（不执行） |
| `innerRegistry` getter | 同文件 :122-125 | `run_code` handle 绑内层 → 子调用放行 |
| `executionExposure` / `faceForMode` | 同文件 :78-104 | 模式基线折叠（standard 11 / execution 6） |
| 装配点 | `apps/studio/src/runtime/engine-plugins.ts:190-197` | `ctx.provide(TOOL_REGISTRY_SERVICE, exposed)` |
| loop 读面 | `packages/agent-loop/src/loop.ts:178` | 每 step `buildRequest` 里 `seams.registry.schemas()` |
| `{{tools}}` 渲染 | `apps/studio/src/handlers/config-shape.ts:224-234`、`apps/studio/src/runtime/real-runtime-adapter.ts:346-349` | 见 §2.4 裁决 |
| 只读读者 | `GET /api/tools?session=`（`handlers/health.ts:22`） | P0 沿用，不加端点 |
| 排序 | `packages/tools/src/registry.ts:61-63` `schemas()` **按 name 升序**；`packages/core/src/tool.ts:62-66` 注释「Sorted by name … a deterministic order keeps the prompt prefix stable」 | 见 §2.2：动态新增会**插入中段** |

### 2.2 最小新缝 S1：让 `hidden` 可动态求值

把 `ExposureOptions.hidden` 扩成 `readonly string[] | (() => readonly string[])`；`schemas()` 与 `dispatch()` 各自向同一个读取函数取一次快照；既有调用点（`executionExposure` 传数组）**不破**。需要 copy-on-write：`schemas()` 与 `dispatch()` 必须读到**同一份**快照，否则出现「已从 schemas 隐藏但 dispatch 仍放行」的竞态（§6 第 2 条）。我们每会话单 loop 串行，host 在每个 step 的 `buildRequest` 之前原子替换快照即可。

### 2.3 最小新缝 S2：cache 友好的 wire 顺序（**必须**）

现状 `schemas()` 按 name 排序（`registry.ts:62`），新披露工具会按字母插入中段，直接踩中 §3 的最坏情形。

建议 wire order = `baseline(mode 固定基线，内部按 name 排序) ++ added(本会话新增披露，按首次披露顺序)`：只增 → 永远尾部追加。代价：对所有 session 改变现有顺序 → **一次性**前缀失效（**待量化** U4）；`core/tool.ts` 的注释需同步，但**契约（name 集）不变**（顺序不在 `contracts/tools.json` 里）。

### 2.4 最小新缝 S3：`{{tools}}` 与 face 的口径裁决（**必须显式决定**）

现状 M9 要求 `{{tools}}` 渲染名集 == `GET /api/tools?session=` == 该会话 `schemas()`。动态披露会让「当前 face」每 turn 变：

- 若 `{{tools}}` 跟 face 实时变 → **系统提示词每 turn 变 → 比改 tools 数组更贵**（system 在 tools 之前，改首段命中可到 0%）。
- **建议**：`{{tools}}` 固定渲染**模式基线的可披露全集**（静态），并在 `tool_access` 段加一句「部分工具按需披露」。M9 放宽为「`{{tools}}` 的集合 == 该模式**可披露全集**」，另立断言「任一已披露工具 ∈ 全集」。

### 2.5 DSH `restrict()` ↔ 我们 `exposedRegistry.hidden`（逐项对照）

| 维度 | DSH `ctx.tools.restrict()` | 本仓 `exposedRegistry.hidden` | 差距是否要抹平 |
|---|---|---|---|
| 所在层 | host-plane 工具注册表的 scope restriction（[015] `index.ts:709,1054-1088`） | 装饰器 `ExposedRegistry`（`exposure.ts:111-152`） | 等价角色，不必 |
| 决定什么 | wire schema + `get()` 查找 + dispatch 执行（三合一，单一 resolver `view()`） | `schemas()` 展示 + `dispatch()` 直调 | 等价 |
| 披露时机 | 可运行期**替换**（dispose+append），一变即下次装配生效 | 构造时定死（`exposure.ts:112-119`），无替换入口 | **要补**（S1） |
| 未披露直调 | 读作不存在 → 裸 `UNKNOWN_TOOL`，**policy 可见** | hidden 命中 → `tool_unavailable_in_mode` `deny`，**执行前拒绝、policy 不可见**（`exposure.ts:148-151`、`:106-109`） | **保持我们的更强语义**（安全） |
| 子调用（run_code 内） | **受同一 restriction 约束**（对齐的另一面） | **放行**：handle 绑内层 registry（`exposure.ts:17-21`、`plugin.ts`） | **刻意不对齐**，见 §4 |
| 保留名 | 拒绝 `run_code`（:1075-1076） | `EXECUTION_TOOL_NAMES` 显式含 `run_code`（`exposure.ts:45-52`） | 一致 |
| 顺序 | `NamedEntries` / `AnonymousEntries` 插入序（无 name 排序） | `schemas()` 按 name 升序（`registry.ts:62`） | **要补**（S2） |

**结论 2.5**：DSH 给的是「**可替换的 scoped 过滤器 + 单一 resolver 对齐**」这一模式，我们已有同构的 seam（`exposedRegistry`）；要借鉴的是**可替换性**（S1）与 **stable order**（S2），而**不**借鉴「子调用也受限」——我们的设计选择是「模型直调受限、程序内可达」。

---

## 3. 缓存影响（重点，全部量化）

### 3.1 上游事实：按**token 字节前缀**判缓存

探针环境：`http://127.0.0.1:3001/v1/chat/completions`，`deepseek-flash`，key 只从活进程 env 读、**未打印/未落盘**；脚本用完删除。所有请求串行 + 间隔。`prompt_cache_hit_tokens` 即 `cache_read`。

**探针 A（合成 10 工具，上一轮）**

| 请求 | prompt | hit | 命中率 | 结论 |
|---|---|---|---|---|
| R1 冷启动 | 5748 | 0 | 0% | 首写 |
| R2 完全相同 | 5748 | 5504 | **95.8%** | 同前缀稳定命中 |
| R3 尾部追加 1 工具 | 5835 | 5632 | 96.5% | 追加不打断已有前缀（hit 反升） |
| R5 交换第 3/4 工具 | 5748 | 4864 | 84.6% | 从**首个变动工具**起失效 |
| R6 删除第 5 工具 | 5661 | 5120 | 90.4% | 同上 |
| R7 系统尾部改一句 | 5757 | 4480 | 77.8% | 从系统改动点起失效 |

**探针 B（合成，上一轮）**

| 请求 | prompt | hit | 命中率 | 结论 |
|---|---|---|---|---|
| P0 只有 system（无 tools） | 4667 | 4480 | 96.0% | **system ≈ 4480 token，在最前** |
| P1 只有 tools（system=hi） | 1123 | 0 | 0% | 10 合成工具 ≈ 1000 token |
| P2 base（system+tools+user） | 5748 | 5504 | 95.8% | ≈ 4480 + 1024 + tail |
| P4 **改系统首句** | 5754 | 0 | **0%** | **system 是全前缀第 0 段** |
| P6 在 tools **头部**插入工具 | 5835 | 4608 | 79.0% | hit 只剩 system(4480)+128 → **已有工具全部失效** |
| P8 **从尾部裁掉 4 个工具** | 5400 | 5120 | 94.8% | 保留的前缀仍命中 |
| P10 尾部追加 2 工具 | 5922 | 5760 | 97.3% | 已有前缀全保 + 新工具首块也进 cache |

**结论 L1**：请求序列化顺序 = **system → tools → messages**（P0/P1/P2 拆分 + P4 改首句→0%）。
**结论 L2**：tools 数组不变时前缀稳定（R2/P3 95.8%；H2 97.1%；本轮 A2 97.5%）。

### 3.2 用**我们真实的 11 个工具**测量（`contracts/tools.json` 原样，上一轮）

| 请求 | prompt | hit | 命中率 | 说明 |
|---|---|---|---|---|
| V0 无工具 | 940 | 0 | — | 基线 |
| V1 全 11 工具（冷） | 5269 | 896 | 17.0% | |
| V2 全 11 工具（热） | 5269 | 5120 | **97.2%** | 稳定态 |
| V3 把**首工具**移到**尾部** | 5269 | 896 | **17.0%** | 顺序变化 → 工具段几乎全失效 |
| V5 隐藏中段 `http_request` | 4878 | 1664 | 34.1% | 从被隐藏工具起失效 |

**数字**：
- 我们 11 个工具的 wire 成本 = **4329 prompt token**（V1−V0 = 5269−940），占精简请求 **82%**；单个 `http_request` = **391 token**（V1−V5）。
- 交叉校验（本轮实测）：`contracts/tools.json` 11 个 spec 的 JSON 共 **15355 字节**（最大 `ask_user_question` 3104 字节、最小 `read_file` 484 字节），按 4329 token 折算约 **3.55 字节/token**，量级一致。
- 即：**tools 数组本身就是最大的可缓存块之一**，它的稳定性决定命中率。

### 3.3 决定性探针：改 tools 会不会打断**整段对话历史**？

**上一轮 H 组**（带 16 轮历史，base prompt 8434）——因为 tools 在 messages **之前**，答案是**会**：

| 请求 | prompt | hit | 命中率 | 相对稳定态损失 |
|---|---|---|---|---|
| H1 冷 | 8434 | 0 | 0% | |
| H2 热（稳定态） | 8434 | 8192 | **97.1%** | 基准 |
| H3 **尾部追加 1 工具** | 8486 | 4480 | **52.8%** | −3712 cached token |
| H4 追加后再次（热） | 8486 | 8320 | **98.0%** | **一步重热即恢复** |
| H6 **首工具移到尾** | 8434 | 384 | **4.6%** | **−7808 cached token** |
| H8 **中段隐藏 1 工具** | 8043 | 1152 | **14.3%** | −7040 cached token |

**本轮独立复核 A 组（2026-09-16 第 2 版，同一上游/模型；真实 11 工具 + 合成尾部工具 + 16 轮历史）**：

| 请求 | prompt | hit | 命中率 | 与稳定态差 |
|---|---|---|---|---|
| A1 冷 11 工具 | 8795 | 0 | 0% | 首写 |
| A2 热 11 工具（稳定态） | 8795 | 8576 | **97.5%** | 基准 |
| A3 尾部追加 1 工具（12 个） | 9077 | 6144 | **67.7%** | **−2432 cached token** |
| A4 改回 11 工具（原顺序） | 8795 | 8576 | **97.5%** | **完全回到 A2 的 cache** |
| A5 首工具移到尾部 | 8795 | 2048 | **23.3%** | **−6528 cached token** |
| A6 中段删 `process_control`（10 个） | 8515 | 3200 | **37.6%** | **−5376 cached token** |
| A7 再跑 A6（热） | 8515 | 8320 | **97.7%** | **一次性重热后恢复** |

**重派复核 W 组（2026-09-16 重派 W802，独立前缀 12808 prompt；11 真实工具 wire 形态 `{type:"function",function:{...}}` + 合成尾部工具 + 16 轮历史；assistant 段带 `reasoning_content` 以满足 thinking 模式；7 次串行、间隔 1.5s）**：

| 请求 | prompt | hit | 命中率 | 与稳定态差 |
|---|---|---|---|---|
| W1 冷 11 工具 | 12808 | 0 | 0% | 首写 |
| W2 热 11 工具（稳定态） | 12808 | 12672 | **98.9%** | 基准 |
| W3 尾部追加 1 工具（12 个） | 13048 | 7424 | **56.9%** | **−5248 cached token** |
| W4 改回 11 工具（原顺序） | 12808 | 12672 | **98.9%** | 完全回到 W2 的 cache |
| W5 首工具移到尾部 | 12808 | 3328 | **26.0%** | **−9344 cached token** |
| W6 中段删 `process_control`（10 个） | 12528 | 4480 | **35.8%** | **−8192 cached token** |
| W7 再跑 W6（热） | 12528 | 12288 | **98.1%** | 一次性重热后恢复 |

W 组与 A 组绝对 token 不同（前缀更长、历史占比更高），但**方向与结论逐条一致**：W3 在**尾部**追加仍打掉其后**全部历史**（−5248），W5/W6 从首个变动工具起失效，W4 可命中**旧的** cache，W7 一次重热即恢复。**上游判据 = 严格 token 字节前缀**由此得到第二次独立确认（两次探针使用不同 nonce 前缀，互不共享缓存）。

**结论 L3（核心）**：**tools 数组的任何变化都会让它之后的所有 token（含整个对话历史）从变动点起失效。** 本轮 A3 是关键证据：**只往尾部追加一个新工具（+282 prompt token），也把已缓存的 2432 token 历史打掉**——若上游是「按段独立缓存」，追加尾部不应影响 messages 段。**上游判据 = 严格 token 字节前缀，不是按段缓存**（与 DSH `README.md:160` 的「byte-identical」口径一致）。
**结论 L4**：失效是**一次性重热**——改动后同一 tools 的下一次请求立刻回到 97–98%（A7=97.7%，H4=98.0%）；改回原样还能命中**旧的** cache（A4=97.5%）。
**结论 L5**：不动 tools 就不受影响。生产账本 `/var/lib/celestea-agent/usage-ledger.jsonl`（本轮 2026-09-16 重算）：
- `kind:"ok"` 且 `model=deepseek-flash` 的 **103 步**：`prompt 1,058,273 / cache_read 836,224 = 79.02%`；
- `turn_total` 桶 **39 条**（该桶不带 `model` 字段）：`prompt 1,041,680 / cache_read 824,448 = 79.15%`；
- 最近 20 步：`142,208 / 155,192 = 91.63%`。
- **任务给的 76.8%**：与本机账本任何窗口都不精确相等（79.02% / 79.15% / 91.63%）。**76.8% 来自任务简报口径，本机账本无法复现该窗口，待验证**（第 1 版记录的「turn_total 31 条」是更早的账本快照，已按本轮重算更正）。

### 3.4 哪些动态策略**不会**破坏前缀 / 会

| 策略 | 是否破坏前缀 | 依据 |
|---|---|---|
| tools 数组**完全不变**（模式基线，静态披露） | **不破坏** | L2/L5，现状命中 79% |
| **只增** + 新工具**追加尾部**（stable disclosure order） | 已有 system+tools 段保住；**其后的整段历史要一次重热** | A3（97.5%→67.7%）、R3/P10/H3 |
| **只删尾部**（从后往前撤） | 保留段不动，被撤段之后重热 | P8 |
| **中段插入/删除**、**任何重排** | **破坏**，从首个变动工具起（可到整段历史） | A5（→23.3%）、A6（→37.6%）、R5/R6/P6/H6/H8 |
| 把披露写进**系统提示词**（如 `{{tools}}` 实时变） | **最坏**：system 在第 0 段 | P4（→0%） |
| **每 step** 改 tools | **每 step 一次全历史重热** | A3/A5/A6 + A7 |
| **每 turn 改 1 次**、turn 内保持不变 | 每 turn 只重热 1 次 | A7 外推 |

**上游判据**：**严格 token 字节前缀**。证据：A3 在**尾部**追加仍让**历史**失效（按段缓存则不应）；A5/A6 从首个变动工具起失效（整流重算则 A3 也应从头部失效）。

### 3.5 带数字的取舍建议

以一个真实会话模型（prompt 40k、tools 4329、system ≈ 3800、history ≈ 32k，静态命中 76.8%）：

- **静态（今天）**：每步 cache_read ≈ 30.7k，miss ≈ 9.3k。
- **每 step 都改 tools**：命中回落到 ≈ system（3.8k，约 **9.5%**）→ miss ≈ 36.2k，**每步多付 ≈ 26.9k 全价输入 token（miss +289%）**（模型估算）。
- **每 turn 改 1 次、turn 内 5 step 不变**：5 步里 1 步重热、4 步回到静态 → 惩罚 ≈ **1/5**。
- **只增 + 尾部追加**：用本轮 A3 校准，一次「追加 1 工具」的**实测代价 ≈ prompt 的 27.6%**（2432/8795）需重算；**重排的代价 ≈ 74.2%**（6528/8795）、**中段删 ≈ 61.1%**（5376/8795）。因此「只增 + 尾部」是三种里最省的，但仍不是免费。
- **W 组交叉校验（同一取向下历史占比更高）**：W3 追加 ≈ **41.0%**（5248/12808）、W5 重排 ≈ **72.9%**（9344/12808）、W6 中段删 ≈ **63.9%**（8192/12808）。A 组与 W 组的重排/中段删比例接近（74.2% vs 72.9%、61.1% vs 63.9%），而**追加代价从 27.6% 升到 41.0%**——因为追加一个工具会把它之后**全部已缓存历史**变成 miss，历史越长，追加越贵。**结论：追加式披露的代价随会话长度增长，长会话里「省下的 tools token」可能抵不过「打掉的历史 token」。**

**建议（P0 硬约束）**：
1. **只在 turn 边界**改变披露集（不每 step）；
2. **单调只增**（本 turn 披露后不回撤；要回撤必须从尾部并接受一次重热）；
3. **baseline ++ added 顺序**（禁止按 name 插中段）；
4. **系统提示词绝不随披露变化**。

**金额结论**：本仓账本对 deepseek-flash 记 `priced_by:"unpriced"`（无价格行），故本轮**只给 token 与命中率，不给金额**；金额需 price 行（**待验证** U2）。

---

## 4. 与双模式折叠的关系（取代还是叠加）

**叠加，不取代。**

- `exposure.ts` 继续承担**模式基线折叠**：`standard` 14 面 / `execution` 8 面（`EXECUTION_TOOL_NAMES`；W884 起 `load_skill` 也在保留名单里）。
- 动态披露是**第二层 hidden**：
  ~~~text
  effectiveHidden = modeBaselineHidden(mode) ∪ notYetDisclosed(session, turn)
  schemas()  = inner.schemas() 过滤 effectiveHidden（按 stable disclosure order 排列）
  dispatch() = effectiveHidden 命中 → tool_unavailable_in_mode，执行前拒绝
  ~~~
- `faceForMode`（compose 期读面，`real-runtime-adapter.ts:346-349`）改为「模式基线 + **初始**披露集」；初始披露集建议 = 模式基线。
- **`run_code` 子调用放行语义保持不变**：`run_code` 的 `RegistryHandle` 绑**内层** registry（`packages/tools/src/plugin.ts`、`engine-plugins.ts:190-197`），`ExposedRegistry` 只过滤 Context face；子调用既不经 `schemas()` 也不经 `dispatch` 的 hidden 检查。
- **与 DSH 的刻意分歧**（§2.5）：DSH `restrict()` 的对齐语义会**连带限制 run_code 子调用**；我们**不学**这一点——本仓的设计选择是「模型直调受限、程序内可达」。若要学，等于把 execution 模式的 `run_code` 逃生通道关掉，属于产品语义变更（**待裁决** Q7）。
- 语义澄清：动态披露是「模型可见性」，模式折叠是「模型直调性」，两者都在同一个 `ExposedRegistry` 上表达，但**拒绝理由必须保持可区分**（**待裁决** Q4）。

---

## 5. 契约与门禁成本

| 项 | P0（推荐） | P1 | P2（若上 tool_search） |
|---|---|---|---|
| `API_ENDPOINT_COUNT`（`apps/studio/src/routes.ts:54`，现 51） | **51 不变** | 51（沿用 `GET /api/tools?session=`） | 或 52（新端点） |
| `contracts/tools.json`（`count: 11`） | **11 不变** | 11 | **12**（`tool_search`）→ `tests/contracts.test.ts`、`tests/lib/tool-parity.ts`、`fixtures/live/tools.json`、`/api/tools` note「11 tools」全改 |
| `packages/core` 类型 | **不改**（`ExposureOptions` 在 `packages/tools`） | 不改 | 不改 |
| `packages/core/src/tool.ts:62-66` 注释「sorted by name」 | 改措辞为 stable disclosure order（顺序不在契约里） | — | — |
| `{{tools}}` / M9 | 口径放宽为「可披露全集」（§2.4） | — | — |
| golden fixtures / 对拍 | `fixtures/live/tools.json`、`reports/replay-e2e.*`、`reports/replay-diff.*`、`contracts/route-table.snapshot.json` | 需确认对拍是否断言 tools 数组字节（**待验证** U1） | 同步改 |

**结论**：P0 **零新端点、零新工具、零 core 类型改动**；只改 `packages/tools` 与 `apps/studio` 装配/策略，外加测试。`tool_search` 把一个成本从「策略」变成「契约级连环改动」，**不建议 P0/P1**。

---

## 6. 安全

1. **披露 ≠ 授权**。`ExposedRegistry` 只改 model-visible face；`get/register/addGuard` 全透传（`exposure.ts:132-142`），grants / sandbox / guard 链完全不变。一个已披露工具仍要过 grants/sandbox/guard 才能执行。
2. **未披露工具的直接调用仍必须被拒**。`ExposedRegistry.dispatch` 的 hidden 检查在**调用 inner 之前**返回 `folded()`（`exposure.ts:148-151`、`:106-109`），**不执行**。动态 hidden 集必须被 `schemas()` 与 `dispatch()` 从**同一份不可变快照**读取，防竞态（§2.2 copy-on-write）。
3. **不得绕过 hidden 折叠语义**：模式折叠与动态披露取**并集**，任一命中即拒；不得因为「动态披露想放行」而跳过模式基线。
4. **`run_code` 子调用边界**：子调用走内层 pipeline 的同一 guard 链；动态披露不能把「程序内可调用未授权工具」当后门——它本来就受同一 guard 约束。
5. **提示词与运行时不得互相撒谎**：`{{tools}}`（静态全集）与运行时 face（动态子集）的差异必须在提示词里显式说明，否则模型会对「刚声明却不给调」的工具产生 `UNKNOWN_TOOL` 式困惑（DSH `index.ts:838-842` 正是为此加 `PTC_ONLY_INSTRUCTION`）。
6. **与 DSH restrict 的语义差是安全优势，不要抹平**：DSH 的 restrict 掉的名字在 dispatch 阶段才拒（policy 可见）；我们的 hidden 在**执行前**就 `deny`（policy 不可见，见 `exposure.ts:13-16` 不变量 1）。保持这一更强语义。

---

## 7. 分期、风险与开放问题

### 7.1 分期

**P0 —— 最小、cache 安全（建议先做）**
- S1：`ExposureOptions.hidden` 支持动态 provider（`packages/tools`）。
- S2：stable disclosure order（`baseline ++ added`）。
- 策略：披露集**只在 turn 边界**、**单调只增**；初始 = 模式基线。
- 触发示例（纯函数 policy，**待裁决** Q1）：上一轮出现 `tool_unavailable_in_mode` 的被拒名 → 下一 turn 披露它（「被拒后披露」，不是「提前全量」）。
- S3：`{{tools}}` 固定渲染可披露全集 + 一句说明。
- **零新端点、零新工具、51/11 不变**。
- 验收：单测动态 hidden（schemas 与 dispatch 一致、`tool_unavailable_in_mode` 不变、`run_code` 子调用仍放行）；账本/探针对比披露前后 `cache_read/prompt`（要求 turn 内命中不降）。

**P1 —— 懒披露与可观测**
- 复用已披露面（如 `run_code` 读到可披露清单）或加一个**已披露**的控制路径让模型能「请求更多工具」；**不**引入 `tool_search`。
- `GET /api/tools?session=` 增加「已披露 / 未披露」标记（响应字段，**不加端点**）。
- 度量器 `scripts/disclosure-ab.ts`：同一批任务在「静态」与「按需披露」下对比 `cache_read/prompt` 与 token。

**P2 —— 上下文感知披露 + tool_search 评估**
- 按任务类型/上下文自动披露；评估 `tool_search` 的契约成本（§5）与收益。
- A/B 门槛：披露带来的 token 节省必须 > 重热成本（用实测 `cache_read/prompt` 与 miss token 计算）。

### 7.2 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | **每 step churn 打断前缀**（实测可到 23.3%） | 只允许 turn 边界；P0 硬约束 §3.5 |
| R2 | **name-sorted 顺序**使新增工具插中段 | 必须上 S2 stable disclosure order |
| R3 | `{{tools}}` 与 face 漂移（M9） | S3 显式口径 + 断言「已披露 ⊆ 全集」 |
| R4 | 与模式折叠的并集语义被写错 | `effectiveHidden` = 并集；单测两模式 × 动态 |
| R5 | 动态 hidden 与 dispatch 竞态 | 每 step 原子替换不可变快照（copy-on-write） |
| R6 | DSH `code→ptc` 漂移被抄错 | 映射用 `ptc`；本引擎契约无 `agentPreset` |
| R7 | 对拍 golden 因 tools 变化变红 | U1 先确认；必要时按披露状态分桶 |
| R8 | 收益被夸大 | 金额不给（账本 unpriced）；token/命中率给实测 |
| R9 | 照抄 DSH「对齐」而误伤 run_code 逃生通道 | §2.5/§4 显式声明分歧；Q7 待裁决 |

### 7.3 开放问题（需用户裁决）

- **Q1 触发**：披露由「被拒后自动」/「模型显式请求」/「用户切换」中的哪一种驱动？
- **Q2 撤销**：是否允许 re-hide？允许的话是否限制「仅从尾部撤」？
- **Q3 重排**：是否接受为 S2 做一次性全量顺序变更（换取后续 append-only）？
- **Q4 拒绝文案**：动态披露的拒绝是否复用 `tool_unavailable_in_mode`，还是新增 reason 前缀以区分「模式折叠」与「上下文未披露」？
- **Q5 tool_search**：是否值得为它付 `contracts/tools.json` 11→12 + parity/fixtures 的连环改动？
- **Q6 适用模式**：动态披露是 `execution` 专属，还是 `standard` 也开？（standard 是 11 面，披露面更大、缓存影响更大）
- **Q7 子调用语义**：是否要学 DSH 的对齐（restrict 同时限制 `run_code` 子调用）？本设计默认**不学**（保持子调用放行）。

### 7.4 待验证清单（本轮未实测）

| ID | 项 | 影响 |
|---|---|---|
| U1 | `reports/replay-e2e.*` / `replay-diff.*` 是否断言 tools 数组字节 | 决定 golden/对拍成本 |
| U2 | deepseek-flash 的 `cache_read` 单价（账本 `priced_by=unpriced`） | 金额结论 |
| U3 | 真实生产会话（3777）每 step/每 turn 改 tools 的实测命中率 | 本轮只做合成/契约工具探针，未动生产会话 |
| U4 | `schemas()` 改序后既有会话的一次性前缀失效幅度 | 一次成本估计 |
| U5 | 上游 cache 是否按 API key 隔离 / 多 worker 是否共享 | 影响并发 worker 命中 |
| U6 | `/opt/dsh/profiles/web`（本 session 实际安装树，PID 2917694）与 [015] 的偏差 | 仍 root-only 不可读，需更高权限复核 |
| U7 | 76.8% 的确切统计窗口 | 本机账本无法复现，出处待确认 |
| U8 | 是否真的存在官方 `tool_search` 实现（本轮 grep 仅见 compat 门字段与 cookbook 条目） | 若存在则 D1 需再修 |

---

## 8. 本轮边界与未做的事

- 只改 `docs/feature-dynamic-tool-disclosure.md`；不改代码/contracts/tests/fixtures；不新增依赖；不重启服务。
- 探针只读上游 `http://127.0.0.1:3001/v1`；**未触碰生产 3777 的会话**；API key 只从活进程 env 读、未打印/未落盘；临时脚本 `/tmp/w802-recheck.mjs` / `/tmp/w802-draft.md` 用完删除。
- 不做真实生产会话 A/B；不给金额；DSH 事实来自可读源码副本而非本 session 安装树。
- 本轮未跑 `pnpm check`（纯 doc 改动）。

