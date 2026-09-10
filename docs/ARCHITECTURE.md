# celestea_studio-ts 架构契约

> 建立于 W273（P0）。本文是**规则正文**，`eslint.config.js` 与 `.dependency-cruiser.cjs` 是它的机械实现。
> 违反本文的代码会在 `pnpm check` 阶段被拦下——**这是构建门槛，不是 review 建议**。
>
> 一句话目标：**高内聚、低耦合、职责分明、可扩展、一切皆插件**。

---

## 0. 一页红线

1. **依赖只能向下**：`core ← session / llm / tools / agent-loop / workers ← runtime ← apps/studio`。反向依赖、同层横向依赖、跨层上跳都是错误。
2. **跨包只走包入口**：只允许 `import ... from "@celestea/<pkg>"`；`@celestea/<pkg>/src/...`（深层导入）和 `../../other/src/x.js`（相对路径跨包）一律拒绝。
3. **公开 API 收口在 `src/index.ts`**：包外能看到的只有该包入口导出的符号。
4. **规模硬线**：单文件 ≤ 400 行（建议 ≤ 300）、单函数 ≤ 80 行、控制流嵌套 ≤ 4 层、形参 ≤ 5 个、回调嵌套 ≤ 4 层。
5. **一切皆插件**：新能力 = 新增 seam 实现 + 在 compose 处注册。禁止在 `core` 里写 `if (provider === "x")` 这类分支。
6. **注释与空行不计入行数**——写注释永远不亏。
7. **例外只能登记**在 `eslint.config.js` 的 `ARCH_EXCEPTIONS` 与本文 §5 表中，逐条写明「原因 / 拆分方案 / 移除阶段」；**禁止就地 `// eslint-disable`**。

---

## 1. 分层与依赖方向

### 1.1 层级表

| 层 | 包 | 允许依赖 | 说明 |
|---|---|---|---|
| **L0** | `packages/core` | **无**（仅 `node:` 标准库） | 语义内核：契约类型 + seam 定义。零 `@celestea/*` 依赖 |
| **L1** | `packages/session`、`packages/llm`、`packages/tools`、`packages/agent-loop`、`packages/workers` | `core` | 每个包实现 core 的一组 seam；**彼此之间不得互相依赖** |
| **L2** | `packages/runtime` | `core` + 全部 L1 | 装配层：把插件挂进 `Context`，对外只给「已装配的引擎」 |
| **L3** | `apps/studio` | 任意 `packages/*` | 宿主应用：Hono 路由 / 进程入口 / 输出渲染 |
| 旁路 | `scripts/`、`tests/` | 任意 | 工具链与验证，不构成产品依赖，不受分层约束 |

### 1.2 依赖方向图

```
                apps/studio            （L3 宿主，只有它能同时看见所有包）
                     │
                  runtime              （L2 装配：compose → Context）
        ┌────────┬────┴────┬────────┬────────┐
     session    llm      tools  agent-loop  workers     （L1 实现，互不依赖）
        └────────┴─────────┴────────┴────────┘
                     │
                    core              （L0 零依赖：类型 + seam）
```

### 1.3 明令禁止的六类依赖

| # | 禁止 | 反例 | 为什么 |
|---|---|---|---|
| D1 | **反向依赖**（packages → apps） | `packages/tools` 里 `import { routes } from "@celestea/studio"` | 库不能依赖宿主；否则库无法被第二个宿主复用，测试也得拖起整个 app |
| D2 | **同层横向依赖**（L1 ↔ L1） | `packages/llm` 里 `import { parseTsv } from "@celestea/workers"` | 横向依赖会形成隐式耦合网；需要共享的能力应下沉到 `core` 的 seam |
| D3 | **跨层上跳**（L1 → L2/L3） | `packages/session` 里 `import { compose } from "@celestea/runtime"` | 实现包不该知道装配顺序 |
| D4 | **跨包深层导入** | `import { json } from "@celestea/core/src/json.js"` | 绕过公开 API 收口，内部重构即破坏下游 |
| D5 | **相对路径跨包** | `import { x } from "../../core/src/json.js"` | 同上，且别名解析更能被检查器可靠识别 |
| D6 | **循环依赖**（任意粒度） | `a.ts → b.ts → a.ts` | 环让分层失效、增量构建与测试互相牵连 |

### 1.4 需要横向能力时怎么办（唯一合法出口）

按优先级三选一：

1. **把契约提到 `core`**（首选）：在 `core` 定义一个 seam 接口（如 `Llm`、`SessionLog`），双方都只依赖这个接口。`core` 永远不知道实现是谁。
2. **走 `Context` 服务解析**：装配期由 `runtime` 把实现 `provide` 进 `Context`，消费方按类型取，编译期不产生包依赖。
3. **显式登记依赖矩阵**（最后手段）：同时改三处——`eslint.config.js` 的 `TIER1` 分组、`.dependency-cruiser.cjs` 的 `tier1-no-peer-deps-*` 规则、本文档 §1.1 表格，并在评审说明理由与撤除条件。**三处缺一视为未登记**。

### 1.5 检查器落点

| 规则 | ESLint（`pnpm lint`） | dependency-cruiser（`pnpm lint:arch`） |
|---|---|---|
| D1 反向依赖 | `arch/no-packages-to-apps` | `no-packages-to-apps` |
| D2 同层横向 | `arch/tier1-no-peer-deps` | `tier1-no-peer-deps-<pkg>`（逐包生成） |
| D3 跨层上跳 | 同上（L1 禁 runtime） | 同上 |
| D4 深层导入 | `arch/import-boundary`（`@celestea/*/*`） | `entry-only-<pkg>`（逐包生成，只允许 `src/index.ts`） |
| D5 相对跨包 | `arch/import-boundary`（`../../*`） | `no-relative-into-<pkg>`（逐包生成，按 `aliased-tsconfig-paths` 区分别名） |
| D6 循环依赖 | —（ESLint 不做图分析） | `no-circular` |
| L0 零依赖 | `arch/core-is-leaf` | `core-is-leaf` |

---

## 2. 包职责与公开 API 收口

### 2.1 每包一句话职责

| 包 | 一句话职责 | 对应 Rust | 公开入口 |
|---|---|---|---|
| `packages/core` | 冻结契约类型 + 六个 seam 定义 + 事件总线 + JSON/脱敏/路径工具；**零实现、零依赖** | `crates/core` | `src/index.ts` |
| `packages/session` | `SessionLog` 的实现（内存/JSONL 持久化）、日志回放与修复、`turn-<n>` 单调计数、两套消息投影 | `crates/session` | `src/index.ts` |
| `packages/llm` | `Llm` 的实现：OpenAI 兼容传输、SSE 帧解析、usage 归一、三档超时、provider profile 解析 | `crates/llm` | `src/index.ts` |
| `packages/tools` | `Tool` 与 `ToolGuard` 的实现与注册表：工具 spec、guard 链、dispatch | `crates/tools`、`crates/workers/src/tools.rs` | `src/index.ts` |
| `packages/agent-loop` | `AgentLoop` 的实现：turn/step 驱动、上下文裁剪、协作式取消、五态 outcome | `crates/agent-loop` | `src/index.ts` |
| `packages/workers` | worker 注册表（`registry.tsv` 解析/序列化）、worker 驱动与看门狗插件 | `crates/workers` | `src/index.ts` |
| `packages/runtime` | 装配层：按 profile `compose` 出 `Context`（LLM 注册表、会话日志、工具注册表、agent loop、worker 接线） | `crates/runtime/src/compose.rs` | `src/index.ts` |
| `apps/studio` | 宿主应用：Hono 应用与 39 端点路由、进程入口、profile 解析 | `studio/src/main.rs` | `src/index.ts` |

### 2.2 公开 API 收口规则

1. **唯一公开面 = `<pkg>/src/index.ts`**。`package.json#exports` 只暴露 `"."`；包外引用内部模块在 `lint:arch` 里是错误（`entry-only-<pkg>`）。
2. **内部模块随便拆**，公开面不受目录结构影响。拆目录（`log/memory.ts`、`log/file.ts`）不构成破坏性变更；**改 `index.ts` 的导出才是**。
3. **`index.ts` 必须带 module map 注释**：逐行列出内部模块 → 职责 → 对应 Rust 文件（现状已如此，新包照做）。
4. **`export *` 只在同包内聚合时使用**，且被聚合模块的导出即公开 API；新增导出前先问一句：**这是 seam（契约）还是实现？实现不进公开面。**
5. **公开面只导出两类东西**：seam 类型/接口，以及经由 seam 类型表达的工厂（`createXxx`）与插件（`xxxPlugin`）。具体实现类（如内部 SSE 解析器）默认不导出。
6. **跨包引用必须用别名**（`@celestea/<pkg>`），包内相对引用必须带 `.js` 后缀（NodeNext + `verbatimModuleSyntax`），纯类型引用用 `import type`。

---

## 3. 一切皆插件（seam 契约 ↔ Rust `crates/core`）

设计原点与 `/src/celestea_harness/crates/core/src/lib.rs` 一一对应：
**该 crate 只有 seam 定义与 re-export，没有任何具体实现**；具体 provider 住在兄弟 crate，在 compose 期挂载。
TS 侧保持同一形状：`packages/core` 只放接口与容器，实现全在 L1 包里。

### 3.1 seam 清单

| seam | TS 落点（`packages/core/src/`） | Rust 契约 | TS 形状 | 语义要点 |
|---|---|---|---|---|
| **Plugin** | `plugin.ts` | `plugin.rs` | `interface Plugin { name: string; mount(ctx: Context): void }` | 插件唯一的自我安装方式：往 `Context` 里 provide 服务、往注册表里 insert 行 |
| **Context** | `context.ts` | `context.rs` | 类型键服务容器 `provide / get / scoped` | 后注册覆盖先注册（patch 语义）；`scoped()` 给每个 agent 一层子作用域，查不到回退父级 |
| **EventBus** | `event-bus.ts` | `event_bus.rs` | `on / emit`、`bail / runBail`、`waterfall / runWaterfall` | 三种派发模式分别存放，互不干扰：广播=观察；bail=首个 `Some` 短路；waterfall=按序折叠变换 |
| **SessionLog** | `session-log.ts` | `session_log.rs` | `append / events / deriveMessages / clear / nextTurnId` | **append-only 日志是唯一真源**；模型可见历史是派生物，绝不另存一份；`turn-<n>` 计数器归日志所有（重启后从磁盘最大值恢复，不复用 id） |
| **Llm** | `llm.ts` | `llm.rs` | `interface Llm { generate(req): Promise<LlmStream> }` + `LlmRegistry` | 生成返回**流**而非字符串；注册表按名字注册，**last-wins**（同名后注册覆盖先注册），compose 期注册一次 |
| **ToolGuard** | `tool.ts` | `tool.rs` | `check(input) → Allow / Deny(reason) / Ask(reason)` | guard 链是 waterfall/intercept：按注册顺序跑，**首个非 Allow 短路**；判定是结果的一等字段（`decision`），不是错误字符串 |
| （配套）**Tool** | `tool.ts` | `tool.rs` | `spec() / execute(args) / executeWith(input)` | 规范值与人类可读渲染分离（`value` vs `render`）；工具错误进结果字段，**不抛异常** |
| （配套）**AgentLoop** | `agent.ts` | `agent.rs` | `interface AgentLoop` + `AgentConfig` | 一轮 = 若干 step；预算耗尽（`step_limit`）**不算完成**；取消是协作式的 |

### 3.2 插件如何注册 / 发现 / 排序

**注册（只有一个时机：compose）**

```
apps/studio → runtime.compose(profile)
                 ├─ new Context()
                 ├─ plugin.mount(ctx)   // 每个插件把自己的服务 provide 进去
                 │     └─ ctx.provide(SessionService) / ctx.provide(LlmRegistryService) / ...
                 └─ 返回已装配的 Runtime（ctx + 各 seam 的句柄）
```

- 插件不得在运行期自我注册；运行期只允许**替换**（同一类型再 `provide` 一次，后注册胜出）。
- 插件不得 `new` 另一个包的实现类：**要别的能力就 `ctx.get(...)`**。

**发现**

- 按类型：`ctx.get(SessionService)`、`ctx.get(ToolRegistryService)`——类型即契约，编译期可查。
- 按名字：`LlmRegistry.resolve("deepseek")`、命名注册表 `get(name)`——**last-wins**，用于多 provider / 多后端。

**排序（顺序即语义，必须显式）**

| 场景 | 顺序规则 | 约束 |
|---|---|---|
| `EventBus.on/emit` | 按注册顺序依次调用 | 观察者之间不得有顺序依赖 |
| `EventBus.bail/runBail` | 按注册顺序，**首个返回值者短路** | 鉴权/守卫类监听器必须最先注册，并在 compose 处注释说明 |
| `EventBus.waterfall/runWaterfall` | 按注册顺序逐层变换初始值 | 变换必须可结合、无副作用 |
| `ToolGuard` 链 | 按注册顺序，首个非 `Allow` 短路 | guard 顺序是安全语义的一部分：compose 处必须写明「谁在前、为什么」 |
| 插件挂载顺序 | compose 内的显式顺序 | 调整顺序属于**行为变更**，需在 compose 处附注释与测试 |

### 3.3 反模式（会被 review 直接打回）

- 在 `core` 或 L1 包内 `switch (providerName)` / `if (backend === "x")` → 应改为「注册表 + 多实现文件」。
- 在插件里 `import` 另一个 L1 包 → 见 §1.4。
- 在 `apps/studio` 里手写业务逻辑（投影、解析、重试）→ 应下沉到对应 L1 包，app 只做路由与 I/O。
- 绕过 `Context` 直接 `new` 出一个持久化实现 → 测试无法替换，装配顺序失真。

---

## 4. 规模政策与拆分范式

### 4.1 硬线（全部由 `pnpm lint` 机械检查）

| 指标 | 上限 | 建议 | ESLint 规则 | 备注 |
|---|---|---|---|---|
| 单文件行数 | **400** | ≤ 300 | `max-lines` | `skipBlankLines + skipComments`：空行、注释不计费 |
| 单函数行数 | **80** | ≤ 50 | `max-lines-per-function` | 同样跳过空行与注释；**测试文件放宽到 150**（见下） |
| 控制流嵌套 | **4** | ≤ 3 | `max-depth` | if/for/while/switch/try 的嵌套层数 |
| 形参个数 | **5** | ≤ 3 | `max-params` | 参数过多通常说明该抽配置对象或该拆函数 |
| 回调嵌套 | **4** | ≤ 2 | `max-nested-callbacks` | 回调金字塔是异步代码的头号可读性杀手 |

> 规模的目的是**可读与可替换**，不是数字本身。把 5 个函数压成一行、或把所有参数塞进一个 `any` 对象去绕过 `max-params`，都视为违规。
>
> **测试文件的唯一放宽**：单条用例（`it(...)` 的回调）是线性的 arrange-act-assert，块上限放宽到 **150 行**（`arch/size-tests`）。
> 文件级 400 行、嵌套深度、参数个数、回调嵌套对测试**同样生效**；超过 150 行的用例应拆成多条 `it()`，而不是把断言堆在一起。

### 4.2 超限时的四种拆分范式（按优先级）

1. **按职责拆目录 + 子模块**（首选）
   范例：`packages/session/src/log/` —— `memory.ts`（内存实现）/ `file.ts`（文件回放与命名）/ `persistent.ts`（持久化实现）/ `derive.ts`（消息投影）。
   每拆一个子模块：**单一职责、可单测、由 `index.ts` 统一收口**。
2. **数据表外提**：把规则表、清单、映射、正则集合提到模块级 `const`（`DEFAULT_RULES`、`CREDENTIAL_CONTEXTS`），函数体只留流程。
3. **按阶段拆函数**：`parse → validate → project → emit` 各成一个 ≤80 行函数，主函数只做编排（`scripts/export-golden.ts` 的 `main()` 就该这么治）。
4. **按 seam 拆实现**：出现「如果 A 就…，如果 B 就…」时，抽出接口 + 每个分支一个实现文件 + 一个注册表。

### 4.3 拆分后的纪律

- 新子模块**不得**被包外直接引用（`entry-only-<pkg>` 会拦）。
- 子模块之间不得形成环（`no-circular` 会拦）。
- 每个子模块配自己的 `*.test.ts`，测试与被测文件同级。
- 拆分不得改变公开面；如果必须改 `index.ts` 导出，那是**契约变更**，需同步 `contracts/` 与对拍。

---

## 5. 例外清单（唯一真源：`eslint.config.js` 的 `ARCH_EXCEPTIONS`）

**复核命令**：`ARCH_STRICT=1 pnpm lint` —— 忽略全部例外，输出即「例外清零后的真实违规」。
本节表格与配置文件必须逐条一致；**新增例外要同时改两处**（配置 + 本表），并在交付报告里说明。

| ID | 文件 | 超限项（实测） | 原因 | 拆分方案 | 移除阶段 |
|---|---|---|---|---|---|
| EX-01 | `packages/core/src/redact.ts` | `createRedactor` 81 行（限 80）；`discover()` 与 `collectKnownSecrets()` 嵌套 5 层（限 4） | P0 遗留代码：脱敏规则表与凭据上下文直接内联在函数体内 | 把 `DEFAULT_RULES` / `CREDENTIAL_CONTEXTS` / 环境变量名单提到模块级常量表，并抽出 `collectProviderKeys()`；两个函数即可回到 ≤80 行 / ≤4 层 | P1（core 收口时；`packages/core` 归 W271 领地） |
| EX-02 | `scripts/export-golden.ts` | `main()` 249 行（限 80）；嵌套 5 层（限 4） | P0 一次性黄金样本导出脚本：探针清单 → 拉取 → 脱敏 → 写盘全在一个线性 `main()` 里 | 拆 `scripts/golden/{probe,fetch,redact,write}.ts`，`main()` 只保留步骤编排 | P1 工具链整理 |
| EX-03 | `scripts/verify-contracts.ts` | `main()` 162 行（限 80） | P0 校验脚本：20 端点 × 断言的线性探针清单 | 探针清单抽成数据表（数组字面量）+ `runProbe()` 循环 | P1 工具链整理 |
| EX-04 | `scripts/compare-replay.ts` | `main()` 115 行（限 80） | P0 对拍脚本：依次跑 A–E 五组对比并汇总写报告 | 每组对比抽成独立 `compareX()`，`main()` 只做调度与汇总 | P1 工具链整理 |

**当前状态**：`ARCH_STRICT=1 pnpm lint` 的输出恰好是上表 4 个文件、8 条错误——**没有隐藏例外**。
除上述之外，全部文件在当前配置下 0 error（`tests/fixtures.test.ts` 有 1 条 `reportUnusedDisableDirectives` warning，属待清理的陈旧 `eslint-disable` 注释，不影响门禁）。

**例外的三条纪律**

1. 只放宽**被点名文件的被点名规则**，不许用通配符、不许放宽整目录。
2. 必须写清「原因 / 拆分方案 / 移除阶段」，缺一不予登记。
3. `// eslint-disable` 不是例外机制：`reportUnusedDisableDirectives` 已开启，就地禁用会在检查输出里留痕。

---

## 6. 命名 / 错误处理 / 日志 / 测试约定

### 6.1 命名

| 对象 | 规约 | 示例 |
|---|---|---|
| 文件名 | `kebab-case.ts` | `event-bus.ts`、`registry-tsv.ts` |
| 测试文件 | 与被测文件同名 + `.test.ts` | `usage.test.ts` |
| 类型 / 接口 / 枚举 | `PascalCase`，**接口不加 `I` 前缀** | `Llm`、`SessionLog`、`ToolGuard` |
| 函数 / 变量 | `camelCase` | `deriveMessages`、`nextTurnId` |
| 模块级常量 | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUTS`、`MAX_STEPS` |
| 布尔 | `is` / `has` / `should` 前缀 | `isTimeoutError`、`hasFixtures` |
| 插件工厂 | `createXxx` / `xxxPlugin` | `createDeepSeekLlm`、`inMemorySessionLogPlugin` |
| 事件名 | `snake_case`（契约冻结，不随实现变） | `turn_start`、`tool_call` |
| 服务 newtype | `<Seam>Service` | `SessionService`、`ToolRegistryService` |

### 6.2 错误处理

1. **不抛裸字符串**；抛 `Error` 子类（`core/errors.ts` 或包内 `errors.ts`）。
2. **机器可读错误必须带 `kind`**（如 `LlmError.kind = "timeout" | "stream"`、`TIMEOUT_ERROR_PREFIX`），人读文案只是附带；调用方按 `kind` 分支，绝不解析文案。
3. **seam 边界不泄漏实现异常**：工具执行失败进结果的 `error` / `decision` 字段（captured, not thrown）；LLM 失败进 `LlmError`。
4. **不许空 `catch`**：要么转换成领域错误，要么 `throw` 出去；`useUnknownInCatchVariables` 已开，捕获值按 `unknown` 处理。
5. **终态必须显式**：一轮 turn 结束只允许落在五态之一（`completed / cancelled / error / step_limit / interrupted`）；预算耗尽、流撕裂**不得**报成 `completed`。

### 6.3 日志与脱敏

1. 产品代码**不直接 `console.log`**（`scripts/`、测试与 CLI 入口例外）；诊断信息走 `EventBus` 事件或结构化 sink，由 `apps/studio` 决定输出形态。
2. **出口统一脱敏**：任何写往 fixtures / reports / 日志的内容必须过 `core/redact.ts`；导出物必须 `redaction clean`（发现残留即退出码 1）。
3. 事件与日志**不得**包含密钥、cookie、`Authorization` 值；已知密钥集合从环境与配置文件读取，**只读不打印**。
4. 日志里出现「阶段名」时用契约里的固定枚举（`connect` / `response_header` / `stream_idle`…），不要自造同义词。

### 6.4 测试

1. **位置**：单元测试与被测文件同级（`packages/<pkg>/src/*.test.ts`）；跨包契约测试、端到端回放放 `tests/`。
2. **命名**：`describe(<被测单元>)` + `it(<可观察行为>)`；不写"应该"式散文。
3. **每条 seam 契约必须有测试**；纯逻辑优先镜像 Rust 单测，实现与参考实现用 fixture 对拍。
4. **测试也受规模规则约束**（同为 `SOURCE_GLOBS`），但允许 `import` 自己被测的包（`*.test.ts` 豁免横向导入限制）。
5. **不要 mock 掉被验证的 seam 本身**；要 mock 的是 HTTP、进程、时钟、文件系统这类外部边界。
6. 金标准来源优先级：**运行中的 Rust 实机 > Rust 单测 > TS 自洽**。前两者产出的 fixture 入库；自洽对比必须在报告里标注 `derived`。

---

## 7. 扩展点清单（加东西到底动哪些文件）

> 共同铁律：**改 `core` 的既有类型 = 改冻结契约 = 必须同步 `contracts/` 与回放对拍**。新能力优先"新增 seam 实现"，而不是"给已有类型加字段"。

### 7.1 加一个工具（Tool）

| 步骤 | 文件 |
|---|---|
| 1. 实现 `Tool`（`spec()` + `execute()`；需要 call_id / 自定义 render 时覆写 `executeWith()`） | `packages/tools/src/<tool-name>.ts` |
| 2. 注册进注册表 | `packages/tools/src/index.ts`（或 compose 期由 `runtime` 注册） |
| 3. 补 spec 契约 | `contracts/tools.json` |
| 4. 测试 | `packages/tools/src/<tool-name>.test.ts`（spec 快照 + guard 矩阵 + 失败路径） |
| 5. 需要新 guard 时 | 新增 `packages/tools/src/guard-<name>.ts` 并在 compose 处**显式决定链序** |
| 6. 文档 | 本文 §2.1 若改了职责；根 `README.md` 的工具表 |

**禁止**：在 `core` 里加工具名常量；在 `agent-loop` 里特判工具名。

### 7.2 加一个 LLM provider

| 步骤 | 文件 |
|---|---|
| 1. 实现 `Llm.generate()`（返回流，不是字符串） | `packages/llm/src/<provider>.ts` |
| 2. 工厂 + 命名注册 | `createXxxLlm()`；`LlmRegistry.register("<name>", impl)`（last-wins） |
| 3. 导出 | `packages/llm/src/index.ts` |
| 4. profile / env 解析（base_url、api_key、超时档位） | `packages/llm/src/profile.ts`（key 只从 env 读） |
| 5. 录制帧回放 + timeout 分类测试 | `packages/llm/src/<provider>.test.ts` |
| 6. 装配 | `packages/runtime/src/compose.ts` 按 profile 注册名字 |

**apps 不改一行**：路由按名字解析 provider，不按 provider 分支。

### 7.3 加一个 worker 后端

| 步骤 | 文件 |
|---|---|
| 1. 实现后端（启动 / 观察 / 停止 / 汇报） | `packages/workers/src/<backend>.ts` |
| 2. 注册与选择 | `packages/workers/src/index.ts` + compose 期注入 |
| 3. 注册表契约（若新增列/键） | `contracts/data-files/registry-tsv.schema.json` + 解析器 round-trip 测试 |
| 4. 测试 | `packages/workers/src/<backend>.test.ts`（含进程生命周期与清理路径） |
| 5. 看门狗 | 若需存活判定，注册为独立插件（参考 Rust `WatchdogPlugin`），不要塞进后端实现里 |

### 7.4 加一个新 seam（慎重：这会动 `core`）

| 步骤 | 文件 |
|---|---|
| 1. 定义接口 + 服务 newtype + 注册表语义 | `packages/core/src/<seam>.ts` |
| 2. 收口导出 | `packages/core/src/index.ts`（补 module map 注释） |
| 3. 实现 | L1 包内，或新建 `packages/<new>/`（需在 §1.1 表格与两份检查器配置里登记层级） |
| 4. 装配 | `packages/runtime/src/compose.ts` |
| 5. 文档 | 本文 §3.1 补一行；说明注册/发现/排序语义 |
| 6. 测试 | 契约测试 + 至少一个假实现（fake）验证 seam 可替换 |

### 7.5 加一个 SSE 事件或端点

`contracts/sse-events.json` 或 `contracts/endpoints.json` → `apps/studio/src/routes.ts` → `tests/contracts.test.ts`；
若是事件，同时更新 `packages/core/src/types.ts` 的事件联合与 `session-event.schema.json`（契约变更需对拍）。

---

## 8. 机械强制：怎么跑、检查器配置要点

### 8.1 四条命令

| 命令 | 检查什么 | 配置真源 | 失败怎么办 |
|---|---|---|---|
| `pnpm typecheck` | 类型正确性（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`） | `tsconfig.base.json` / `tsconfig.json` | 修类型，不要 `any` 绕过 |
| `pnpm lint` | 规模 + 导入边界（单文件粒度） | `eslint.config.js` | 按 §4.2 拆分，或按 §5 登记例外 |
| `pnpm lint:arch` | 分层方向 / 同层横向 / 循环 / 深层导入 / 不可解析 | `.dependency-cruiser.cjs` | 按 §1.4 三选一 |
| `pnpm test` | 契约与回放回归 | `vitest.config.ts` | 修实现；若契约真变了，先改 `contracts/` 并说明 |
| **`pnpm check`** | **以上四者之和**（typecheck → lint → lint:arch → test） | 上述全部 | 本地提交前的唯一门禁 |

CI / 本地：

```bash
pnpm install --frozen-lockfile
pnpm check          # 合并请求与本地提交前都必须绿
ARCH_STRICT=1 pnpm lint   # 复核例外清单是否还有必要（见 §5）
```

### 8.2 检查器配置要点（改配置前先读这段）

1. **`max-lines` / `max-lines-per-function` 都开 `skipBlankLines + skipComments`**：注释免费，鼓励写文档注释。
2. **ESLint 的规则配置是"整块覆盖"而不是"按模式合并"**：多个 `files` 块命中同一文件时，**最后一个块整体胜出**。所以每个边界块都自带完整模式清单（见 `boundaryPatterns()`），且 `arch/core-is-leaf` 必须排在通用块之后。
3. **例外是白名单**：`ARCH_EXCEPTIONS` 是唯一真源，通过 `ARCH_STRICT=1` 可以整表关闭用于复核；配置里不做目录级放宽。
4. **dependency-cruiser 必须挂 `tsConfig.fileName`**：否则 `@celestea/<pkg>` 别名解析不出来，所有边界规则会静默失效（这是最危险的失败模式——规则看着在，其实什么都没查）。
5. **公开面规则按包生成**（`entry-only-<pkg>`、`no-relative-into-<pkg>`）：新增包时必须在 `.dependency-cruiser.cjs` 的 `PACKAGES` 数组里加名字，否则新包没有边界保护。
6. **`no-orphans-in-packages` 是 warning**：`packages/*/src` 下除 `index.ts` 外不该有无人引用的模块（职责漂浮的信号），不阻断构建但要在 review 里问一句。
7. **`not-to-unresolvable` 必须开**：别名写错时先在这里报错，否则边界规则会静默放过。

### 8.3 违反时的症状速查

| 症状 | 大概率原因 | 正确做法 |
|---|---|---|
| `could not be resolved` | 忘了 `.js` 后缀 / 别名拼错 / 新包没进 tsconfig paths | 补后缀或别名映射 |
| `entry-only-<pkg>` | 从别的包深穿了内部模块 | 改从 `@celestea/<pkg>` 导入，或把该符号加进对方 `index.ts` |
| `tier1-no-peer-deps-<pkg>` | L1 包之间互相 import | 下沉契约到 `core` 或走 `Context`（§1.4） |
| `core-is-leaf` | `core` 里 import 了别的包 | 把实现挪到 L1 包；`core` 只留接口 |
| `no-circular` | 两个模块互相引用 | 抽出第三方模块承载共享部分（通常是类型/纯函数） |
| `max-lines` / `max-lines-per-function` | 文件或函数职责过多 | 按 §4.2 四范式拆分，不要就地 disable |

---

## 附录 A：与 Rust `crates/core` 的对应关系（迁移期口径）

| Rust | TS | 迁移口径 |
|---|---|---|
| `crates/core`（只有 seam + re-export，无实现） | `packages/core` | 类型 1:1；TS 侧同样"零实现、零依赖" |
| `crates/<impl>` 各自 `impl Plugin`，在 `crates/runtime/src/compose.rs` 挂载 | `packages/<impl>` + `packages/runtime/src/compose.ts` | 装配顺序即语义顺序，注释与测试对齐 |
| `Context` 的 TypeId 键控服务表 + parent 链 | `Context` 类型键服务表 + `scoped()` | TS 用类型作为键（无 TypeId），语义相同 |
| `EventBus` 三模式（on/bail/waterfall） | `EventBus` 同名三模式 | 顺序语义严格对齐 |
| `NamedRegistry` last-wins（patch 语义） | 命名注册表 / `LlmRegistry` | 后注册覆盖先注册，不报错 |
| 会话日志是唯一真源，`derive_messages` 是派生 | 同左 | TS 侧禁止另存一份历史 |

**迁移期唯一放宽**：P1–P3 期间，若 TS 侧某 seam 的形状与 Rust 有出入，以 `contracts/` 与对拍结果为准，并在本文 §3.1 表格里标注差异与收敛阶段；**不允许在实现包里私自定义第二套语义**。

## 附录 B：规则 ↔ 检查器 ↔ 出处

| 规则 | 检查器 | 规则名 |
|---|---|---|
| 单文件 ≤400 行 | ESLint | `max-lines` |
| 单函数 ≤80 行 | ESLint | `max-lines-per-function` |
| 嵌套 ≤4 | ESLint | `max-depth` |
| 参数 ≤5 | ESLint | `max-params` |
| 回调嵌套 ≤4 | ESLint | `max-nested-callbacks` |
| 跨包只能走入口 / 禁相对深穿 | ESLint + dep-cruiser | `arch/import-boundary`、`arch/core-is-leaf`、`arch/no-packages-to-apps`、`arch/tier1-no-peer-deps`；`entry-only-*`、`no-relative-into-*` |
| core 零依赖 | ESLint + dep-cruiser | `arch/core-is-leaf` / `core-is-leaf` |
| packages 不依赖 apps | ESLint + dep-cruiser | `arch/no-packages-to-apps` / `no-packages-to-apps` |
| 同层不横向依赖 | ESLint + dep-cruiser | `arch/tier1-no-peer-deps` / `tier1-no-peer-deps-*` |
| 禁循环依赖 | dep-cruiser | `no-circular` |
| 导入必须可解析 | dep-cruiser | `not-to-unresolvable` |
| 包内无漂浮模块 | dep-cruiser（warning） | `no-orphans-in-packages` |
