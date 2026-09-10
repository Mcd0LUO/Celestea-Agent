# celestea_studio-ts

Celestea Studio 后端的 **TypeScript 全量重构**（W268 评估报告 §10 场景 B）。
本仓当前处于 **P0：契约冻结 + 骨架 + 黄金样本对拍工具链**。

> 依据：`/src/celestea_studio/docs/backend-ts-rewrite-eval.md` §10 P0、§13.2 三条不可妥协前置。
> 本仓是**独立 git 仓**（无 remote）。P0 不触碰生产：`/src/celestea_studio` 与 `/src/celestea_harness` 全程只读。

---

## 1. 快速开始

```bash
cd /src/celestea_studio-ts
pnpm install            # Node 24 + pnpm 11
pnpm typecheck          # tsc --noEmit（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）
pnpm test               # vitest（58 passed）

# 契约与实机对拍（只读 :3777）
pnpm contracts:verify   # 20 端点抽样 + 8 SSE 事件名 + 10 工具，写 contracts/probe-evidence.json
pnpm golden:export      # 导出 fixtures/（只读现有会话日志 + 只读 /api/events）
pnpm replay:compare     # TS 侧回放 → reports/replay-diff.md（--strict 时 golden 分歧即退出码 1）
```

一次跑完：`pnpm check`（typecheck + lint + lint:arch + test，见 §7）。

端口约定：Rust 生产 `:3777` 保持不变；TS 开发实例预留 `:3778`（`pnpm --filter @celestea/studio start`，**P0 不启动任何常驻服务**）。

---

## 2. 目录职责

| 路径 | 职责 | 对应 Rust |
|---|---|---|
| `packages/core` | 类型/seam/契约加载/事件总线/脱敏：`SessionEvent`、`TurnOutcome`、SSE 信封、`EventBus`(512 + lagged) | `celestea_harness/crates/core` + `studio/src/main.rs` 的信封部分 |
| `packages/session` | `cli-main.jsonl` 解析（撕裂尾）/序列化/`turn-<n>` 归属/两套消息投影/回放统计 | 引擎 `session_log.rs` + `studio/src/api.rs:94-153` |
| `packages/llm` | LLM seam 占位：usage 三键名、三档超时、`reasoning_effort` 自由字符串直通 | `crates/llm`（P2 实现） |
| `packages/tools` | 10 工具注册表（从 `contracts/tools.json` 构建）+ guard seam | `crates/tools`、`crates/workers/src/tools.rs`（P2 实现） |
| `packages/agent-loop` | `LoopEvent → SSE` 映射、五态 outcome、协作式取消信号、`MIN_STEPS=4096` | `crates/agent-loop`（P1 实现） |
| `packages/workers` | `registry.tsv` 解析/序列化/k=v token/summarize（含 `by_state`） | `crates/workers/src/{types,registry}.rs` |
| `packages/runtime` | compose 15 步、profile 12 键、key 三路解析枚举 | `crates/runtime` + `studio/src/main.rs:1191-1394`（P3 实现） |
| `apps/studio` | Hono 应用：39 端点全部注册（P0 只有 health/status/events 有实现，其余 501 并点名契约 id） | `studio/src/main.rs` 路由表 + handlers（P4 实现） |
| `contracts/` | **机器可读契约（冻结数据）** | 见 §3 |
| `scripts/` | 导出器 / 对拍器 / 实机校验器 | — |
| `fixtures/` | 黄金样本（导出产物，入库） | — |
| `reports/` | 对拍与校验报告（导出产物，入库） | — |

---

## 3. 契约清单（`contracts/`）

| 文件 | 内容 | 数量 | 校验方式 |
|---|---|---|---|
| `endpoints.json` | 39 端点：method/path/请求字段/响应字段/错误码原文/只读探针结果 | **39** | `tests/contracts.test.ts` + `pnpm contracts:verify` |
| `rust-route-table.snapshot.json` | 从 `src/main.rs:1333-1376` 提取的路由表快照 | 38 条声明 = **43** method+path（39 API + 4 静态） | 测试断言 39 API 与契约逐条相等 |
| `sse-events.json` | 8 个 SSE 事件名 + 信封 `{turn,seq,payload}` + `lagged` 语义 + 512 容量 | **8** | 测试 + 实机 content-type 探针 |
| `session-event.schema.json` | `SessionEvent` 7 变体 + `TurnOutcome` 5 态 + `turn-<n>` 单调规则 + 两套投影 | 7 / 5 | 测试 + 回放 |
| `tools.json` | 10 个工具 spec（描述取自运行中的引擎 `/api/tools`，parameters 逐字转写自 Rust `ToolSpec`） | **10** | 测试 + 实机工具名集合比对 |
| `data-files/*.schema.json` | `workspaces.json`(v2) / `providers.json`(+public_view 不含 key) / `prompts.json` / `session.json` / `cli-main.jsonl` / `cli-main.jsonl.precompact` / `registry.tsv` + `index.json` | **8** | 测试（含"无 version 字段"与 round-trip 要求） |
| `probe-evidence.json` | `pnpm contracts:verify` 的实机证据 | 25 checks | 生成 |

**实机校验抽样**：12 个 GET 端点（health/status/tools/config/sessions/sessions-id-messages/workspaces/providers/prompts/fs-browse/worker-status + events 头）+ 8 个只读安全错误分支 = **20 个端点**，全部通过。错误分支的"不可写"性在 Rust 源码中逐条举证（见 `reports/contract-probe.md` 末表）。

---

## 4. 黄金样本（`fixtures/`）

导出器：`scripts/export-golden.ts`。**只读**：GET + 被动连接 `/api/events` + 直接读会话日志；**绝不** POST `/api/turn`（那会往生产 `cli-main.jsonl` 追加）。

| 来源会话 | 角色 | 事件 | 轮数 | 悬空 tool_call | run_code 子调用 | outcome |
|---|---|---|---|---|---|---|
| `celestea_harness/harness架构哥-…` | 悬空 tool_call + run_code parent_id | 606 | 17 | **3** | 11 | cancelled / error |
| `server-center/center-架构师-…` | 普通多轮 | 967 | 7 | 0 | 0 | error |
| `CelesteaTeamAPI/test-…` | run_code parent_id + 普通多轮 | 53 | 6 | 0 | 11 | — |
| `CelesteaTeamAPI/scratch-cancel-e2e-…` | cancelled outcome | 6 | 1 | 0 | 0 | cancelled |
| `CelesteaTeamAPI/scratch-timeout-…` | error outcome | 3 | 1 | 0 | 0 | error |

每个会话导出：`cli-main.jsonl`（脱敏原文）、`messages-expected.json`（**Rust 实机** `GET …/messages`）、`derive-messages-expected.json`（TS 推导，标注 derived）、`sse-transcript-derived.jsonl`、`meta.json`。
另有：`sse/live-capture.*`（被动抓取的真实 SSE 帧 + 头）、`workers/registry.tsv` + 解析结果、`providers/public-view.json`、`workspaces/*`、`live/*`（10 个 GET 快照）、`redaction-audit.json`、`index.json`（含每个文件的 sha256）。

### 脱敏做法

1. 注册已知密钥：`providers.json` 的 `api_key`、`~/.npmrc` 的 `_authToken`、`CELESTEA_API_KEY` 等 env 值（`collectKnownSecrets`，**只读取、不打印**）。
2. 形状规则：`sk-*`、`npm_*`、`ghp_*`、`Bearer <token>`、`Authorization`/`api_key` JSON 值、`*_API_KEY=`/`*_TOKEN=` 赋值、`AKIA*`、`Cookie:`/`Set-Cookie:` 值、`-auth-<token>`。
   - 这些规则**故意不加前导 `\b`**：会话日志里的 `\n` 是字面转义，前面是字母 `n`（词字符），加 `\b` 会漏掉真实密钥——这是本次实测发现并修掉的一个真实泄漏。
   - 值字符类排除 `\`：否则会把 JSON 转义反斜杠一起吃掉，破坏 JSON 结构。
3. **凭据发现 + 全局传播**：凡出现在凭据上下文（`Cookie:` / `Authorization:` / `Bearer` / `*token=*` / `sk-*` / `-auth-*` / `npm_*`）里的 16+ 字符 token，会被登记为"动态密钥"并在**整份导出**中全局替换——因此 `T=<cookie 值>` 这类别名同样会被抹掉（这是本次实测发现的第二个真实泄漏）。
4. 每个写出的文件都重扫（注册密钥 + 动态密钥 + 形状规则）；`redaction-audit.json` 给出结论 `clean`，发现任何残留直接退出码 1。
5. 本次导出：**63 处替换 / 0 泄漏**；已逐项确认 provider key、npm token、`dsh-auth-*`、`dsh_token` cookie 值、会话日志里的 `sk-*` 均不在 `fixtures/` 中。

---

## 5. 回放对拍（`scripts/compare-replay.ts`）

读 `fixtures/` → TS 侧重放 → 结构化 diff → `reports/replay-diff.{md,json}`。

| 对比项 | 是否 golden | 说明 |
|---|---|---|
| A. Studio `messages` 投影 | **是（来自运行中的 Rust）** | `GET /api/sessions/{id}/messages` 为真源 |
| B. 引擎 `derive_messages` | 否（自洽） | 引擎无 HTTP 面；P1 用 Rust 单测把它变成 golden |
| C. SSE transcript | 否（自洽） | `seq` 是进程全局计数器，无法从日志还原 |
| D. `public_view` | **是** | 断言不含 `api_key` 键 |
| E. `registry.tsv` | **是** | `serialize(parse(x)) === x` 字节级 round-trip |

P0 实测结果：**5 个真实会话、1531 条消息投影、golden 分歧 0**（`pnpm replay:compare --strict` 通过）。B/C 为自洽对比，P0 只保证工具链跑通与确定性；分歧非空时报告照样输出（不掩盖）。

---

## 6. 与 Rust 实现的对应关系（P1–P4 入口）

| Rust | TS 落点 | 阶段 | 验收线 |
|---|---|---|---|
| `crates/core`（类型/seam/EventBus） | `packages/core` | P1 | 类型 1:1 + 回放对拍 100% |
| `crates/session`（JSONL/derive_messages/mailbox） | `packages/session` | **P1 入口** | §7.2 第 1 条：3 真实 + ≥15 合成 fixture |
| `crates/agent-loop`（turn/step/裁剪/取消） | `packages/agent-loop` | P1 | 镜像 Rust 纯逻辑单测 ≈150–190 |
| `crates/llm`（裸 SSE/usage/三档超时） | `packages/llm` | P2 | 录制帧回放 + timeout 分类 |
| `crates/tools` + `crates/workers/src/tools.rs` | `packages/tools` | P2 | 沙箱矩阵 ≥20 + guard 16 条 + SSRF fail-closed |
| `crates/runtime` + `crates/workers` | `packages/runtime`、`packages/workers` | P3 | compose 15 步、registry 互读互写 |
| `studio/src/*.rs`（38 路由/handlers） | `apps/studio` | P4 | 39 端点契约测试全绿（`apps/studio` 已把 39 条路由全部注册，P0 用 501 点名） |

**P1 入口**：`packages/session` 与 `packages/agent-loop`。当前 `packages/session` 已完成 JSONL 解析/序列化、`turn-<n>` 单调归属、两套投影与回放统计，并且 Studio 投影已与 Rust 实机 100% 对齐——P1 直接在其上补 mailbox / 上下文裁剪 / 取消语义，并把 `derive_messages` 与 SSE transcript 升格为 golden 对比。

---

## 7. 架构规则与检查（W273，机械强制）

**规则正文**：`docs/ARCHITECTURE.md`；**机械实现**：`eslint.config.js`（规模 + 导入边界）与 `.dependency-cruiser.cjs`（包依赖图）。
违反架构规则会在 `pnpm check` 阶段直接失败——这是构建门槛，不是 review 建议。

```bash
pnpm lint           # ESLint：单文件规模（≤400 行 / 函数 ≤80 行 / 嵌套 ≤4 / 参数 ≤5）+ 跨包导入字面量
pnpm lint:arch      # dependency-cruiser：分层方向、同层横向依赖、循环依赖、深层导入、不可解析导入
pnpm typecheck      # tsc --noEmit（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）
pnpm test           # vitest（契约 / 回放 / 单元）
pnpm check          # = 以上四者之和，本地提交前与 CI 的唯一门禁

ARCH_STRICT=1 pnpm lint   # 忽略全部例外，用于复核 docs/ARCHITECTURE.md §5 的例外清单是否还有必要
```

CI / 新环境：

```bash
pnpm install --frozen-lockfile
pnpm check
```

### 新代码红线（摘要，全文见 `docs/ARCHITECTURE.md`）

1. **依赖只能向下**：`core ← session / llm / tools / agent-loop / workers ← runtime ← apps/studio`；反向依赖、L1 同层横向依赖、跨层上跳一律拒绝。
2. **跨包只走包入口**：只能 `import ... from "@celestea/<pkg>"`；`@celestea/<pkg>/src/...` 与 `../../other/src/x.js` 都是错误。
3. **公开 API 收口在 `src/index.ts`**：拆目录不构成破坏性变更，改 `index.ts` 导出才是。
4. **规模硬线**：单文件 ≤400 行（建议 ≤300）、单函数 ≤80 行、嵌套 ≤4、参数 ≤5；空行与注释不计费。
5. **一切皆插件**：新能力 = 新增 seam 实现 + 在 `runtime/compose` 注册；禁止在 `core` 里写 `if (provider === "x")`。
6. **例外只能登记**在 `eslint.config.js` 的 `ARCH_EXCEPTIONS` 与 `docs/ARCHITECTURE.md` §5（原因 / 拆分方案 / 移除阶段三件套齐全）；禁止就地 `// eslint-disable`。

新增包时必须同时改三处：`tsconfig.json` 的 paths、`.dependency-cruiser.cjs` 的 `PACKAGES` 数组、`docs/ARCHITECTURE.md` §1 层级表——否则新包没有边界保护。

---

## 8. P0 范围与非目标

- ✅ 契约冻结（39 端点 / 8 SSE / 7+5 SessionEvent / 10 工具 / 8 数据文件）
- ✅ pnpm workspace 骨架（7 packages + apps/studio，Node 24 + Hono + strict TS + vitest）
- ✅ 黄金样本导出器（只读、脱敏、可复现）与回放对拍脚本骨架
- ✅ 实机契约校验（20 端点抽样，只读）
- ❌ 不含真实业务实现（LLM 调用、沙箱、agent loop、HTTP handler 行为）——P1–P4
- ❌ 不启动任何服务、不改 systemd/nginx、不写任何生产数据文件
