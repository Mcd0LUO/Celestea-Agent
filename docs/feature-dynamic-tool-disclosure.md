# 特性设计 · 动态工具披露（借鉴 DSH，落地 Celestea 引擎）

> 状态：**只调研与设计（W802，2026-09-16）**。本文不落地任何代码；所有「现状」标注 `文件:行号`；
> 所有 DSH 事实标注 `文件:行号` 与来源树；所有实测数字来自本轮探针或既有账本，**未实测项一律标注「待验证」**。
> 范围：只新增本文；不改 contracts / tests / fixtures / 产品代码；不新增依赖；不重启服务。
> 前置阅读：`docs/modes-standard-vs-execution.md`（双模式折叠 W729/W791）、`packages/tools/src/exposure.ts`、`docs/feature-session-grants.md`（会话级配置先例）。

---

## 0. 结论速览

| # | 议题 | 裁决 |
|---|---|---|
| D1 | DSH 的「动态工具披露」到底是什么 | **不是**延迟披露 / tool search / 按 step 收敛 schema。它是**按 agent 作用域（agent preset）分层组装注册表** + 一个 per-scope 的**呈现模式开关** `native \| ptc \| both`；披露在 **compose 时按 preset 固定**，每次 prompt 装配重算，但同一 scope 输出稳定。运行期的「动态」只有 MCP 工具列表变更一条来源。 |
| D2 | 我们对它的正确映射 | **在现有模式基线之上叠加一层「按需披露」**：`effectiveHidden = modeBaselineHidden ∪ notYetDisclosed`。复用 `exposedRegistry` seam，把它从「compose 时定死」改为「按 step 读取一份不可变快照」。 |
| D3 | 缓存（本设计的关键约束） | 我们 11 个工具 = **4329 prompt token**，tools 数组排在 system **之后**、messages **之前**。**任何 tools 数组变化都会让它后面的全部 token（含整段对话历史）从变动点起失效**；实测：追加尾部工具 97.1%→52.8%，首工具移到尾 97.1%→**4.6%**，中段隐藏 97.1%→14.3%。**因此动态披露必须只在 turn 边界、且单调只增、且新工具追加在数组尾部。** |
| D4 | 与双模式折叠的关系 | **叠加，不取代**。`exposure.ts` 继续做模式基线折叠；动态披露是第二层。`run_code` 子调用放行语义**天然不变**（handle 绑内层 registry）。 |
| D5 | 契约 | P0 **零新端点、零新工具**：`API_ENDPOINT_COUNT` 保持 **51**，`contracts/tools.json` 保持 **11**。新工具 `tool_search` 仅在 P2 评估（+1 工具，触发 tools.json / parity / fixtures / 「11 tools」文案连环改动）。 |
| D6 | 安全 | 披露 = **可用性**，不是授权。动态 hidden 集只能让模型「看不到/直调不了」，不得绕过 grants/sandbox/guard；未披露工具的直接调用仍必须被拒（`tool_unavailable_in_mode`，执行前拒绝）。 |
| D7 | 唯一不可回避的成本 | 每次披露变化 = **一次全历史前缀重热**（实测 H3/H4：改动步 52.8%，下一步恢复 98.0%）。所以披露频率必须是「每 turn ≤1 次」，不能每 step。 |

---

## 1. DSH 侧事实（逐条出处）

### 1.0 来源标注（重要）

本 session 的 DSH 实际安装树 **root-only 不可读**：

~~~text
$ ls -la /opt/dsh/profiles/web/
ls: cannot open file '/opt/dsh/profiles/web/': Permission denied
$ ls /opt/dsh
ls: cannot open directory '/opt/dsh': Permission denied
~~~

因此本文全部 DSH 事实来自**同机可读的源码副本**，如实标注为副本（W790/W793 的做法）：

| 代号 | 路径 | 版本（`package.json`） |
|---|---|---|
| **[015]** | `/opt/dsh-src-015/` | `0.1.5-alpha.1` |
| **[013]** | `/opt/dsh-src-013/` | `0.1.3-alpha.1` |

**这不是本 session 实际安装树**；能读到实际安装树时应复核。除特别标注外，行号取自 [015]。

### 1.1 注册点：per-agent-scope 的分层注册表（host-plane 服务 + agent-plane 层）

- 工具服务 `ctx.tools` 的每个 scope 有一个 `ToolLayer`，由 `ScopedLayers` 管理；可见集由「全局层 + scope 链」一次遍历导出 —— [015] `packages/core/tools/src/index.ts:707-760`（`ToolLayer`）、:800-812（`layers` / `defaultMode`）。
- agent preset 是一份 `agent.cordis.yml`，它携带的插件行注册进**该 scope** 的 layer —— [015] `packages/preset/agent-presets/presets/`（`standard/` `ptc/` `minimal/` `cordis/` 各一份）。
- 模块头注释明说：**注册表留在 host plane，preset 只拥有 presentation**；`ctx.tools.presentAs()` 为 mounting scope 声明呈现 —— [015] `packages/core/agent-tool-presentation/src/index.ts:1-20`。

**结论**：DSH 的「按 agent/preset 动态组装注册表」= **compose 时的作用域分层**，不是运行期按 step 重算。

### 1.2 呈现模式 `native | ptc | both`：披露的真正旋钮

- 类型定义 —— [015] `packages/core/tools/src/index.ts:644`：
  `export type ToolPresentationMode = 'native' | 'ptc' | 'both'`
- 语义（`Config.mode` 文档，[015] `.../index.ts:645-660`）：`native` 发全部可见 schema；`ptc` **只发 `run_code`** + 一段生成的 SDK prompt，并把 executor 折叠成同一个面（模型直调只能叫 `run_code`，`run_code` 内子调用仍可到所有可见工具）；`both` 两者都发。
- 折叠实现 —— [015] `.../index.ts:972-995`（`wireSchemas`）：
  ~~~ts
  if (mode === 'ptc') {
    return { schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME), knownNames: [RUN_CODE_NAME] }
  }
  ~~~
- 选择点：`presentAs(mode)` per scope —— [015] `.../index.ts:938-965`；`modeFor(scope)` 沿 scope 链就近取胜 —— [015] `.../index.ts:892-903`。
- preset 侧声明 —— [015] `packages/preset/agent-presets/presets/ptc/agent.cordis.yml:269-272`：
  ~~~yaml
  - id: tool-presentation
    name: '@deepseek-ai/dsh-agent-tool-presentation'
    config:
      mode: ptc
  ~~~

### 1.3 披露时机：compose 时定模式，**每次 prompt 装配重算**，不是每 step 增减

- `wireSchemas(scope)` 注册为 system prompt 的 tools provider —— [015] `packages/core/tools/src/index.ts:825`：
  `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`
- 每次 step 的 prompt 装配调用它 —— [015] `packages/core/agent-loop/src/agent.ts:245`：
  `const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`
- 对同一 scope，可见集与 mode 不变时输出稳定；**没有**「按上下文逐步收敛 schema」的机制。

### 1.4 唯一的运行期动态来源：MCP 工具列表变更

- `syncTools` 两阶段（fetch 下一代 → swap 注册/注销），失败保留上一代 —— [015] `packages/mcp/mcp-client/src/tools.ts:150-192`。
- 收到 MCP `notifications/tools/list_changed` 时 re-sync —— [015] `packages/mcp/mcp-client/src/connection.ts:258-274`。
- 注册表变化 emit `tools/change` —— [015] `packages/core/tools/src/index.ts:806`。

### 1.5 模型如何得知？tools 数组每请求重算，**变化时打断 request series**

- `toolsChanged()` 用 header 相等比较上一份 `request/header` —— [015] `packages/core/agent-loop/src/agent.ts:262-266`。
- `startsSeries = ... || this.toolsChanged(assembly.tools)` —— [015] `agent.ts:363-368`；schema 变化 → 新 request series → `systemPrompt.project(..., {startsSeries:true})` + 记 `request/header` —— [015] `agent.ts:369-379`、:557-583。
- 文档明文：「A step starts a series when … **visible tool schemas changed**」 —— [015] `packages/core/agent-loop/README.md:121`。

### 1.6 未披露工具能否被调用？被拒时错误形状

- **不可见**（未注册/被 restriction 滤掉）直接调用 → `ToolNotFoundError`，code `UNKNOWN_TOOL`，message `unknown tool "<name>"` —— [015] `packages/core/tools/src/index.ts:483-500`。
- **PTC 折叠**（仍可见但禁止直调）→ 同一个 `ToolNotFoundError`，但带 `reachableFrom`（教模型改走 run_code）—— [015] `.../index.ts:1418-1430`：
  `only `run_code` is callable directly — call `<name>` from inside a `run_code` program instead`
- 谓词：`collapses(name, scope, nested) = !nested && modeFor(scope)==='ptc' && name !== RUN_CODE_NAME` —— [015] `.../index.ts:1314-1316`（`nested` = run_code 子调用，**永不被折叠**）。
- 折叠在 pre-execute / approval / guard **之前**就终止：「policy listeners must never observe a call that can only fail」 —— [015] `.../index.ts:1358-1368`。
- 提示词侧用**同一谓词**渲染 `PTC_ONLY_INSTRUCTION` —— [015] `.../index.ts:845-856`。

### 1.7 DSH 明确**不做**延迟披露 / tool search / 按需加载

- pi-ai 兼容门用一个显式二值：`type CompatDisposition = 'offer' | 'withhold'` —— [015] `packages/llm/llm-pi-ai/src/catalog.ts:224`。
- 三个相关字段全部 **withhold**：
  - `deferredToolsMode: 'withhold'` —— [015] `catalog.ts:256`
  - `supportsAdditionalTools: 'withhold'`、`supportsToolSearch: 'withhold'` —— [015] `catalog.ts:268-269`
- docs 全树 grep `deferred tool | tool search | on-demand tool | lazy tool` **无命中**（命令输出为空）。
- [013] `catalog.ts` 同形（同一兼容门）。

### 1.8 DSH 自己的 KV-cache 口径（与我们探针互证）

- 「Append-only only while **system text, schemas, and earlier history remain byte-identical** under the same provider and model route. … **A schema or composition change invalidates reuse from the first altered request token.**」 —— [015] `packages/core/agent-loop/README.md:160`。
- 「A later header with changed config or schemas may invalidate reuse from its **first difference**; a prompt change that replaces surface node 0 invalidates reuse from the **first token**」 —— [015] `packages/core/session/README.md:174`。
- header 比较是逐字段 + tools **按位 `JSON.stringify` 相等** —— [015] `packages/core/session/src/request-header.ts:26-53`。即 DSH 的「变化」判据是语义相等，但**供给商的 cache 是字节前缀**（与本轮探针一致）。

### 1.9 环境变化登记（本次必须记下）

- 内建 preset key = `standard` / `ptc` / `minimal` / `cordis` —— [015] `packages/preset/agent-presets/src/display.ts:42-47`；[013] 同文件同键。preset 目录名同 —— [015] `.../presets/`。
- `presets/ptc/preset.yml` 自述 `name: PTC 模式`。
- **旧名 `code` 的残留（漂移证据）**：
  - 仓库外插件 `/src/dsh_plugins/celes-worker-spawn/README.md:68` 仍写 `| code | PTC 模式 |`。
  - 本 session 注入的 `spawn_worker` schema 描述也仍写 `code（PTC）`。
  - → **宿主内建 key 已是 `ptc`，插件文档/工具描述滞后**。任何映射必须用 `ptc`；本引擎契约层**永不出现** `agentPreset`（沿用 `docs/modes-standard-vs-execution.md` M14 门禁）。
- 与本 session 实际安装树相比的偏差：无法核实（`/opt/dsh` root-only）。**待验证**。

---

## 2. 对我们的映射：可复用 seam + 最小新缝

### 2.1 既有 seam（实读）

| seam | 位置 | 复用方式 |
|---|---|---|
| `exposedRegistry(inner, {hidden, guidance})` | `packages/tools/src/exposure.ts:35-160` | 动态披露的落点：把 `hidden` 从常量改为「按 step 读取的不可变快照」 |
| `ExposedRegistry.schemas()/dispatch()` | 同文件 :120-153 | `schemas()` 过滤、`dispatch()` 对 hidden 名**执行前**返回 `folded()`（不执行） |
| `innerRegistry` getter | 同文件 :129-131 | `run_code` handle 绑内层 → 子调用放行 |
| `executionExposure` / `faceForMode` | 同文件 :78-105 | 模式基线折叠（standard 11 / execution 6） |
| 装配点 | `apps/studio/src/runtime/engine-plugins.ts:194-195` | `ctx.provide(TOOL_REGISTRY_SERVICE, exposed)` |
| loop 读面 | `packages/agent-loop/src/loop.ts:178` | 每 step `buildRequest` 里 `seams.registry.schemas()` |
| `{{tools}}` 渲染 | `apps/studio/src/handlers/config-shape.ts:225-233`、`apps/studio/src/runtime/real-runtime-adapter.ts:343-349` | 见 §2.3 裁决 |
| 只读读者 | `GET /api/tools?session=`（`handlers/health.ts`） | P0 沿用，不加端点 |
| 排序 | `packages/tools/src/registry.ts:61-63` `schemas()` **按 name 升序**；`packages/core/src/tool.ts:61-68` 注释「Sorted by name … a deterministic order keeps the prompt prefix stable」 | 见 §2.2：动态新增会**插入中段** |

### 2.2 最小新缝 S1：让 `hidden` 可动态求值

**改动面（仅 `packages/tools`）**：把 `ExposureOptions.hidden` 扩成 `readonly string[] | (() => readonly string[])`；`ExposedRegistry` 的 `schemas()` 与 `dispatch()` 各自向同一个读取函数取一次快照。既有调用点（`executionExposure` 传数组）**不破**。

- 需要保证 `schemas()` 与 `dispatch()` 读到**同一份**快照（copy-on-write），否则会出现「已从 schemas 隐藏但 dispatch 仍放行」的竞态（见 §6）。
- 我们每会话单 loop 串行，host 在**每个 step 的 `buildRequest` 之前**原子替换快照即可；不需要在 loop 里加新回调（最小做法：policy 对象持有 `current`，decorator 持 `() => policy.current`）。

### 2.3 最小新缝 S2：cache 友好的 wire 顺序（**必须**，否则 §3 的收益全丢）

现状 `schemas()` 按 name 排序（`registry.ts:62`），所以**新披露的工具会按字母插入中段**，直接踩中 §3 实测的最坏情形。

**建议**：把「可披露面」的 wire 顺序改成 **stable disclosure order**：

~~~text
wire order = baseline(mode 的固定基线，内部按 name 排序) ++ added(本会话新增披露，按首次披露顺序)
~~~

- 只增 → 新工具永远在**尾部追加** → 前缀（system + baseline 工具 + 已有 added）不动，代价被限制在「新工具 + 其后的历史」一次重热。
- 撤销（re-hide）只有**从尾部撤**才 cache 安全；中段撤会打断（§3 L3）。
- 代价：对所有 session 改变现有 tools 数组顺序 → **一次性**前缀失效（可接受；先发生比后发生好）。`core/tool.ts` 的「sorted by name」注释需同步为「stable disclosure order」，但**契约（name 集）不变**，顺序不在 `contracts/tools.json` 里。

### 2.4 最小新缝 S3：`{{tools}}` 与 face 的口径裁决（**必须显式决定**）

现状 M9 要求 `{{tools}}` 渲染名集 == `GET /api/tools?session=` == 该会话 `schemas()`（`docs/modes-standard-vs-execution.md` M9；`config-shape.ts` 注释 :225-233）。动态披露会让「当前 face」每 turn 变，于是：

- 若 `{{tools}}` 跟 face 实时变 → **系统提示词每 turn 变 → 比改 tools 数组更贵**（系统在 tools 之前；探针 P4：改系统首句命中 **0%**，P0：系统本身约 4480 token 是全前缀最前段）。
- **建议**：`{{tools}}` 固定渲染**模式基线的可披露全集**（静态），并在 `tool_access` 段加一句「部分工具按需披露，未列出时先尝试直调或按需申请」。M9 放宽为「`{{tools}}` 的集合 == 该模式**可披露全集**」，另立断言「任一已披露工具 ∈ 全集」。

---

## 3. 缓存影响（重点，全部量化）

### 3.1 上游事实：按**token 字节前缀**判缓存

探针环境：`http://127.0.0.1:3001/v1/chat/completions`，`deepseek-flash`，key 只从活进程 env 读、**未打印/未落盘**；脚本用完删除。所有请求串行 + 1.2s 间隔。`prompt_cache_hit_tokens` 即 `cache_read`。

**探针 A —— 顺序与首段（合成 10 工具）**

| 请求 | prompt | hit | 命中率 | 结论 |
|---|---|---|---|---|
| R1 冷启动 | 5748 | 0 | 0% | 首写 |
| R2 完全相同 | 5748 | 5504 | **95.8%** | 同前缀稳定命中 |
| R3 尾部追加 1 工具 | 5835 | 5632 | 96.5% | **追加不打断已有前缀**（hit 反升） |
| R5 交换第 3/4 工具 | 5748 | 4864 | 84.6% | 从**首个变动工具**起失效 |
| R6 删除第 5 工具 | 5661 | 5120 | 90.4% | 同上 |
| R7 系统尾部改一句 | 5757 | 4480 | 77.8% | 从系统改动点起失效 |

**探针 B —— 定序（合成）**

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
**结论 L2**：tools 数组不变时前缀稳定（R2/P3 95.8%；H2 97.1%）。

### 3.2 用**我们真实的 11 个工具**测量（`contracts/tools.json` 原样）

| 请求 | prompt | hit | 命中率 | 说明 |
|---|---|---|---|---|
| V0 无工具 | 940 | 0 | — | 基线 |
| V1 全 11 工具（冷） | 5269 | 896 | 17.0% | |
| V2 全 11 工具（热） | 5269 | 5120 | **97.2%** | 稳定态 |
| V3 把**首工具**移到**尾部** | 5269 | 896 | **17.0%** | 顺序变化 → 工具段几乎全失效 |
| V5 隐藏中段 `http_request` | 4878 | 1664 | 34.1% | 从被隐藏工具起失效 |

**数字**：
- 我们 11 个工具的 wire 成本 = **4329 prompt token**（V1−V0 = 5269−940），占精简请求 **82%**；单个 `http_request` = **391 token**（V1−V5）。
- 即：**tools 数组本身就是最大的可缓存块之一**，它的稳定性决定命中率。

### 3.3 决定性探针：改 tools 会不会打断**整段对话历史**？

带 16 轮历史（base prompt 8434）—— 因为 tools 在 messages **之前**，答案是**会**：

| 请求 | prompt | hit | 命中率 | 相对稳定态损失 |
|---|---|---|---|---|
| H1 冷 | 8434 | 0 | 0% | |
| H2 热（稳定态） | 8434 | 8192 | **97.1%** | 基准 |
| H3 **尾部追加 1 工具** | 8486 | 4480 | **52.8%** | −3712 cached token |
| H4 追加后再次（热） | 8486 | 8320 | **98.0%** | **一步重热即恢复** |
| H6 **首工具移到尾** | 8434 | 384 | **4.6%** | **−7808 cached token** |
| H8 **中段隐藏 1 工具** | 8043 | 1152 | **14.3%** | −7040 cached token |

**结论 L3（核心）**：**任何 tools 数组变化都会让它之后的所有 token（含整个对话历史）从变动点起失效**。追加在**尾部**最省（只失效新工具之后的历史，仍要一次重热）；中段插入/删除/重排最贵（本探针首工具移尾 → 命中率从 97.1% 掉到 **4.6%**）。
**结论 L4**：失效是**一次性重热**——改动后同一 tools 的下一次请求立刻回到 97–98%（H4=98.0%）；改回原样也命中原始 cache（H5/H7/H9=97.1%）。
**结论 L5**：不动 tools 就不受影响——生产账本 `/var/lib/celestea-agent/usage-ledger.jsonl` 里 `kind:"ok"` 且 `model=deepseek-flash` 的 **103 步**：`prompt 1,058,273 / cache_read 836,224 = 79.02%`；`turn_total`（deepseek-flash）31 条：`1,037,903 / 824,448 = 79.43%`。任务给的 **76.8%** 与此同量级（窗口不同；**以同一窗口重算即可复现，待验证**）。

### 3.4 哪些动态策略**不会**破坏前缀 / 会

| 策略 | 是否破坏前缀 | 依据 |
|---|---|---|
| tools 数组**完全不变**（模式基线，静态披露） | **不破坏** | L2/L5，79% 现状 |
| **只增** + 新工具**追加尾部**（stable disclosure order） | **不破坏已有一段**，但新工具之后的历史要**一次重热** | R3/P10/H3 |
| **只删尾部**（从后往前撤） | 保留段不动，被撤段之后重热 | P8 |
| **中段插入/删除**、**任何重排** | **破坏**，从首个变动工具起（可到整段历史） | R5/R6/P6/H6/H8 |
| 把披露写进**系统提示词**（如 `{{tools}}` 实时变） | **最坏**：system 在第 0 段，改首部命中 0% | P4/P0 |
| **每 step** 改 tools | **每 step 一次全历史重热** | H3+H4 |
| **每 turn 改 1 次**、turn 内保持不变 | 每 turn 只重热 1 次 | H4 外推 |

**上游判据**：**严格 token 字节前缀**，不是「按段独立缓存」。证据：H3 在**尾部**追加工具仍让**历史**失效（若按段缓存，历史应独立命中）；R5/R6 从首个变动工具起失效（若整流重算，R3 也应从头部失效）。

### 3.5 带数字的取舍建议

以一个真实会话模型（prompt 40k、tools 4329、system ≈ 3800、history ≈ 32k，静态命中 76.8%）：

- **静态（今天）**：每步 cache_read ≈ 30.7k，miss ≈ 9.3k。
- **每 step 都改 tools**：命中回落到 ≈ system（3.8k，约 **9.5%**）→ miss ≈ 36.2k，**每步多付 ≈ 26.9k 全价输入 token（miss +289%）**。
- **每 turn 改 1 次、turn 内 5 step 不变**：5 步里 1 步重热、4 步回到 76.8% → 惩罚 ≈ **1/5**。
- **只增 + 尾部追加**：每次披露的重热范围被限制在「新工具 + 其后的历史」，**不因重排放大**；若新工具追加在 tail 且该 turn 历史不长，重热量可小到几十~几百 token（探针 R3/P10 显示追加本身几乎免费，历史重热是主项）。

**建议（P0 硬约束）**：
1. **只在 turn 边界**改变披露集（不每 step）；
2. **单调只增**（本 turn 披露后不回撤；要回撤必须从尾部并接受一次重热）；
3. **baseline ++ added 顺序**（禁止按 name 插中段）；
4. **系统提示词绝不随披露变化**。

**金额结论**：本仓账本对 deepseek-flash 记 `priced_by:"unpriced"`（无价格行），故本轮**只给 token 与命中率，不给金额**；金额需 price 行（**待验证**）。

---

## 4. 与双模式折叠的关系（取代还是叠加）

**叠加，不取代。**

- `exposure.ts` 继续承担**模式基线折叠**：`standard` 11 面 / `execution` 6 面（`EXECUTION_TOOL_NAMES`，:35-43）。
- 动态披露是**第二层 hidden**：
  ~~~text
  effectiveHidden = modeBaselineHidden(mode) ∪ notYetDisclosed(session, turn)
  schemas()  = inner.schemas() 过滤 effectiveHidden（按 stable disclosure order 排列）
  dispatch() = effectiveHidden 命中 → tool_unavailable_in_mode，执行前拒绝
  ~~~
- `faceForMode`（compose 期读面，`real-runtime-adapter.ts:343-349`）改为「模式基线 + **初始**披露集」；初始披露集建议 = 模式基线，避免首次装配就与运行态不一致。
- **`run_code` 子调用放行语义保持不变**：`run_code` 的 `RegistryHandle` 绑**内层** registry（`packages/tools/src/plugin.ts`、`engine-plugins.ts:194-195` 注释「关键机关」），`ExposedRegistry` 只过滤 Context face；子调用既不经 `schemas()` 也不经 `dispatch` 的 hidden 检查。**动态披露不得改变这一点**：未披露工具在程序内**仍必须可达**，只有**模型直调**被拒。
- 语义澄清：动态披露是「模型可见性」，模式折叠是「模型直调性」，两者都在同一个 `ExposedRegistry` 上表达，但**拒绝理由必须保持可区分**（模式折叠用现文案；披露拒绝可复用同一 `tool_unavailable_in_mode` 或新增 reason 前缀，**待裁决** Q4）。

---

## 5. 契约与门禁成本

| 项 | P0（推荐） | P1 | P2（若上 tool_search） |
|---|---|---|---|
| `API_ENDPOINT_COUNT`（`apps/studio/src/routes.ts:54`，现 51） | **51 不变** | 51（沿用 `GET /api/tools?session=`） | 或 52（新端点） |
| `contracts/tools.json`（`count: 11`） | **11 不变** | 11 | **12**（`tool_search`）→ `tests/contracts.test.ts:117-129`、`tests/lib/tool-parity.ts`、`fixtures/live/tools.json`、`/api/tools` note「11 tools」全改 |
| `packages/core` 类型 | **不改**（`ExposureOptions` 在 `packages/tools`） | 不改 | 不改 |
| `packages/core/src/tool.ts` 注释「sorted by name」 | 改措辞为 stable disclosure order（顺序不在契约里） | — | — |
| `{{tools}}` / M9 | 口径放宽为「可披露全集」（§2.4） | — | — |
| golden fixtures / 对拍 | `fixtures/live/tools.json`（10 工具冻结）、`reports/replay-e2e.*`、`reports/replay-diff.*`、`contracts/route-table.snapshot.json` | 需确认对拍是否断言 tools 数组字节（**待验证** U1） | 同步改 |

**结论**：P0 **零新端点、零新工具、零 core 类型改动**；只改 `packages/tools`（`exposure.ts` + 可能的 `index.ts` 导出）与 `apps/studio` 装配/策略，外加测试。`tool_search` 把一个成本从「策略」变成「契约级连环改动」，**不建议 P0/P1**。

---

## 6. 安全

1. **披露 ≠ 授权**。`ExposedRegistry` 只改 model-visible face；`get/register/addGuard` 全透传（`exposure.ts:133-143`），grants / sandbox / guard 链完全不变。一个已披露工具仍要过 grants/sandbox/guard 才能执行。
2. **未披露工具的直接调用仍必须被拒**。`ExposedRegistry.dispatch` 的 hidden 检查在**调用 tool 之前**返回 `folded()`（`exposure.ts:145-148`、:106-108`），**不执行**。动态 hidden 集必须被 `schemas()` 与 `dispatch()` 从**同一份不可变快照**读取，防止「schemas 已隐藏、dispatch 还放行」的竞态（§2.2 的 copy-on-write）。
3. **不得绕过 hidden 折叠语义**：模式折叠与动态披露取**并集**，任一命中即拒；不得因为「动态披露想放行」而跳过模式基线。
4. **`run_code` 子调用边界**：子调用走内层 pipeline 的同一 guard 链；动态披露**不能**把「程序内可调用未授权工具」当成后门——它本来就受同一 guard 约束。
5. **提示词与运行时不得互相撒谎**：`{{tools}}`（静态全集）与运行时 face（动态子集）的差异必须在提示词里显式说明，否则模型会对「刚声明却不给调」的工具产生 `UNKNOWN_TOOL` 式困惑（DSH `.../index.ts:840` 正是为此加 `PTC_ONLY_INSTRUCTION`）。

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
- 验收：单测动态 hidden（schemas 与 dispatch 一致、`tool_unavailable_in_mode` 不变、run_code 子调用仍放行）；账本/探针对比披露前后 `cache_read/prompt`（要求 turn 内命中不降）。

**P1 —— 懒披露与可观测**
- 让模型能「请求更多工具」：复用已披露面（如 `run_code` 读到可披露清单）或加一个**已披露**的控制路径；**不**引入 `tool_search`。
- `GET /api/tools?session=` 增加「已披露 / 未披露」标记（响应字段，**不加端点**）。
- 度量器 `scripts/disclosure-ab.ts`：同一批任务在「静态」与「按需披露」下对比 `cache_read/prompt` 与 token。

**P2 —— 上下文感知披露 + tool_search 评估**
- 按任务类型/上下文自动披露；评估 `tool_search` 的契约成本（§5）与收益。
- A/B 门槛：披露带来的 token 节省必须 > 重热成本（用实测 `cache_read/prompt` 与 miss token 计算）。

### 7.2 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | **每 step churn 打断前缀**（实测可到 4.6%） | 只允许 turn 边界；P0 硬约束 §3.5 |
| R2 | **name-sorted 顺序**使新增工具插中段 | 必须上 S2 stable disclosure order |
| R3 | `{{tools}}` 与 face 漂移（M9） | S3 显式口径 + 断言「已披露 ⊆ 全集」 |
| R4 | 与模式折叠的并集语义被写错 | effectiveHidden = 并集；单测两模式 × 动态 |
| R5 | 动态 hidden 与 dispatch 竞态 | 每 step 原子替换不可变快照（copy-on-write） |
| R6 | DSH `code→ptc` 漂移被抄错 | 映射用 `ptc`；本引擎契约无 `agentPreset` |
| R7 | 对拍 golden 因 tools 变化变红 | U1 先确认；必要时按披露状态分桶 |
| R8 | 收益被夸大 | 金额不给（账本 unpriced）；token/命中率给实测 |

### 7.3 开放问题（需用户裁决）

- **Q1 触发**：披露由「被拒后自动」/「模型显式请求」/「用户切换」中的哪一种驱动？
- **Q2 撤销**：是否允许 re-hide？允许的话是否限制「仅从尾部撤」？
- **Q3 重排**：是否接受为 S2 做一次性全量顺序变更（换取后续 append-only）？
- **Q4 拒绝文案**：动态披露的拒绝是否复用 `tool_unavailable_in_mode`，还是新增 reason 前缀以区分「模式折叠」与「上下文未披露」？
- **Q5 tool_search**：是否值得为它付 `contracts/tools.json` 11→12 + parity/fixtures 的连环改动？
- **Q6 适用模式**：动态披露是 `execution` 专属，还是 `standard` 也开？（standard 是 11 面，披露面更大、缓存影响更大）

### 7.4 待验证清单（本轮未实测）

| ID | 项 | 影响 |
|---|---|---|
| U1 | `reports/replay-e2e.*` / `replay-diff.*` 是否断言 tools 数组字节 | 决定 golden/对拍成本 |
| U2 | deepseek-flash 的 `cache_read` 单价（账本 `priced_by=unpriced`） | 金额结论 |
| U3 | 真实生产会话（3777）每 step/每 turn 改 tools 的实测命中率 | 本轮只做合成探针，未动生产会话 |
| U4 | `schemas()` 改序后既有会话的一次性前缀失效幅度 | 一次成本估计 |
| U5 | 上游 cache 是否按 API key 隔离 / 多 worker 是否共享 | 会影响并发 worker 的命中 |
| U6 | `/opt/dsh/profiles/web`（本 session 实际安装树）与 [015] 的偏差 | 若可读需复核 preset 与 pi-ai 门 |

---

## 8. 本轮边界与未做的事

- 只新增 `docs/feature-dynamic-tool-disclosure.md`；不改代码/contracts/tests/fixtures；不新增依赖；不重启服务。
- 探针只读上游 `http://127.0.0.1:3001/v1`；**未触碰生产 3777 的会话**；API key 只从活进程 env 读、未打印/未落盘；临时脚本 `/tmp/w802-cache-probe*.mjs` 用完删除。
- 不做真实生产会话 A/B；不给金额；DSH 事实来自可读源码副本而非本 session 安装树。
