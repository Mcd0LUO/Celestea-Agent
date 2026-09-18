# Celestea Studio · 开发文档（权威入口）

> 📦 **W781（2026-09-14）**：旧前端仓 Celestea-Studio（并入前位于同级的 `celestea_studio` 目录）已全量并入本仓，前端 = `apps/web/`，
> 运行数据迁到 `/var/lib/celestea-agent/`。本页所述路径以**并入前**的旧两仓布局为准（历史参考），
> 现役口径见 [`README.md`](./README-frontend.md) 与 [`../README.md`](../README.md)。


> 🧭 **仓库角色（2026-09-11）**：本仓现役 = **线上前端（`frontend/`）+ 共享数据文件**（`workspaces.json` / `providers.json` / `prompts.json` / `sessions/`）。
> 本文描述的是**并入前的旧 Studio 后端**（架构 / 构建 / 测试），属**历史参考**。
> **后端开发请看 [`/src/celestea_studio-ts/docs/README.md`](/src/celestea_studio-ts/docs/README.md)**（TypeScript 后端，生产）；本仓 `docs/` 索引见 [`README.md`](./README.md)。

> 本文是 Celestea Studio 的**开发者入口文档**，内容全部来自对 `/src/celestea_studio-ts` 实际代码的核对（文件:行号可回溯）。
> 契约字段名 / 代码标识符保留英文原文，其余以中文叙述。
> 拿不准的地方一律标 `TODO` / `UNCLEAR`，不臆测。
>
> 代码基线：`main` @ `937fe63`（W263「状态栏真实化 + 引擎用量/缓存命中率」已落地）。
> 校对期间工作区仍在推进，行号/测试数可能随后续提交漂移——每个结论都给了**符号名**，以符号名为准。
> 校对范围：`src/*.rs`（8726 行）、`frontend/src/**`、`scripts/run-studio.sh`、systemd 单元、nginx 站点配置。

---

## 0. 文档地图

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| **本文 `docs/DEVELOPMENT.md`** | 架构总览、模块职责、关键机制、工作流、测试现状、文档索引 | 第一次上手；改任何东西之前 |
| [`docs/README.md`](./README.md) | **`docs/` 全量索引**：状态（当前 / 设计 / 历史）、一句话、权威入口 | 找文档时先看它 |
| [`docs/data-files.md`](./data-files.md) | `workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json` 的 schema 与格式 | 改持久化、迁移、回放 |
| [`docs/pitfalls.md`](./pitfalls.md) | **踩坑档案**：每一条都来自真实修复（症状 / 根因 / 正确做法 / 代码位置） | 动 providers、compact、SSE、前端渲染之前**必读** |
| [`apps/web/FRONTEND-RULES.md`](../apps/web/FRONTEND-RULES.md) | 前端渲染**铁律**（验收硬性标准） | 写任何前端 UI 之前 |

**一句话职责边界（旧口径）**：后端是唯一真源（状态、文件、引擎代际都在后端进程里）；前端只是"渲染 + 转发"，不持有业务真值。
> 2026-09-11 起后端已换为 TypeScript（`celestea-studio-ts`），该边界仍然成立，只是"后端进程"指 TS 服务。

---

## 1. 这是什么

Celestea Studio 是架在 **celestea-runtime 引擎**之上的本地 Web 工作台：

- 一个**单进程后端**（`celestea-studio`），监听 `127.0.0.1:3777`；
- 它把引擎的一次 `Runtime::run_turn` 变成前端可见的 **SSE 事件流**；
- 它把引擎的会话（`cli-main.jsonl`）、模型提供商（`providers.json`）、提示词段（`prompts.json`）、工作区（`workspaces.json`）做成可管理的 HTTP 面；
- 前端是 **无框架 TypeScript + Vite** 构建产物，由后端从磁盘静态服务。

引擎本身（参照实现 `/src/celestea_harness/crates/*`，该仓已于 2026-09-11 删除）**不因 Studio 而改**：Studio 通过 `CELESTEA_SESSION_DIR` + `Runtime::compose` 复用引擎的持久化与工具注册表，这是全仓最重要的设计约束（`src/workspaces.rs:17-26`、`src/main.rs:18-23`）。

### 1.1 快速开始（本机）

```bash
# 前端
cd frontend
pnpm install                                # 首次
pnpm build                                  # tsc --noEmit && vite build -> frontend/dist/
```

访问 `http://127.0.0.1:3777`（本机）或经 nginx 的 `https://studio.celestea.top`（basic auth，见 `docs/archive/deployment.md`）。

### 1.2 改动生效方式（**最容易踩的一条**）

| 改了什么 | 需要做什么 | 需要重启服务吗 |
|---|---|---|
| `frontend/src/**`、`frontend/index.html`、样式 | `cd frontend && pnpm build` | **不需要**。`get_static` 每次请求都从磁盘读 `frontend/dist/`（`src/main.rs:741-783`） |
| 后端源码 | 重编 + 重启 systemd 单元 | **需要** |
| `celestea.toml`（模型/网关） | 重启服务（或走 `POST /api/config` 热改） | 需要 |
| `providers.json` / `prompts.json` | 走 API 写入即可热生效；手工改文件后建议重启 | 视情况 |
| `docs/**` | 什么都不用做 | 不需要 |

> 后端改动必须重编后重启 `celestea-studio.service`；前端改动**只**需要 `pnpm build`——但 `dist/` 被 `.gitignore` 忽略，别指望它进版本库。

---

## 2. 架构总览

### 2.1 进程与路由

`src/main.rs` 是唯一入口（`#[tokio::main] async fn main()`，`src/main.rs:1191-1394`），启动顺序：

1. `load_dotenv()`（`src/main.rs:1193`）；
2. 加载工作区注册表 `workspaces.json`（`CELESTEA_WORKSPACES_FILE` 可覆盖，`src/main.rs:1199-1214`）；文件缺失时执行一次性 legacy 迁移（`src/workspaces.rs:400-419`）；
3. **恢复活动会话**：把 `CELESTEA_SESSION_DIR` 指向活动会话目录，再 compose（`src/main.rs:1219-1254`）。这一步保证"重启后仍在原会话里"；
4. `resolve_profile` 读 `celestea.toml`（`src/main.rs:1255-1266`），并把 `max_steps` 抬到 `MIN_STEPS = 4096`（`src/main.rs:1267-1271`）；
5. 加载 `providers.json`（`CELESTEA_PROVIDERS_FILE` 可覆盖，`src/main.rs:1278-1290`），`apply_startup_default` 用持久化的 `default_model` 覆盖 `celestea.toml` 的 model（`src/main.rs:1291-1295`、`src/providers.rs:594-616`）；
6. `build_gen` 组装第一个引擎代际（`src/main.rs:1301-1307`）；
7. 构建 `AppState`，按需启动 autowake 循环（`src/main.rs:1309-1331`）；
8. 注册路由（`src/main.rs:1333-1377`）并绑定 `STUDIO_BIND`（默认 `127.0.0.1:3777`，`src/main.rs:1379-1393`）。

路由共 **38 条 `route()` 声明（43 个 method+path 组合，其中 `/api/config`、`/api/sessions`、`/api/workspaces`、`/api/providers`、`/api/prompts` 各挂 GET+POST）+ 1 条 fallback**（fallback 也走 `get_static`，未知 `/api/*` 由 `get_static` 内部返回 404 JSON，`src/main.rs:1333-1376`、`744-750`）。

### 2.2 `AppState` / `Gen` / `swap_gen`：代际模型（核心抽象）

```
AppState (Arc<AppState>)                       src/main.rs:474-495
├── gen: RwLock<Gen>          当前引擎代际（热换的最小单位）
├── bcast: broadcast::Sender<BusEvent>   SSE 总线（容量 512）
├── busy: Arc<Mutex<Option<watch::Sender<bool>>>>  单轮并发 + 取消通道
├── next_turn / seq: AtomicU64 轮号 / 全局事件序号
├── status: Arc<StatusTracker> steps + tokens_per_sec 滑窗
├── providers: Arc<ProvidersStore>          providers.json
├── workspaces: Arc<WorkspaceRegistry>      workspaces.json
└── gen_epoch: watch::Sender<u64>           代际纪元（autowake 重绑用）

Gen                                          src/main.rs:355-364
├── runtime: Arc<Runtime>      引擎（含 session log / tool registry / workers / usage）
├── profile: Profile           引擎剖面（已写入装配后的 system_prompt）
├── model / base_url / reasoning_effort
└── config_json: Value         消毒后的 GET /api/config 响应体
```

**代际（generation）是"读到的配置与引擎永远一致"的保证**：`Gen` 的每个字段都来自同一次 `Profile`，读者不会看到"模型来自这次 compose、会话来自上次"的混合状态（`src/main.rs:352-354`）。

`build_gen` → `prepare_gen` → `swap_gen` → `build_and_swap` 是热换的四段式：

| 函数 | 位置 | 职责 |
|---|---|---|
| `build_gen(profile, store)` | `src/main.rs:369-406` | 装配 system_prompt（prompts 注册表）→ `Runtime::compose` → 生成 `Gen` |
| `prepare_gen(pj, api_key, store)` | `src/main.rs:413-423` | `merge_profile` 合并部分覆盖；`api_key` 只写进进程 env（`env[api_key_env]`），**不落盘、不打日志** |
| `swap_gen(st, gen)` | `src/main.rs:429-462` | 写锁替换；替换前把旧代际 mailbox 里待投递的 worker 回执**迁移到新代际**；`gen_epoch += 1` |
| `build_and_swap(st, pj, key)` | `src/main.rs:465-472` | 上面两步的组合，`POST /api/config` 与 provider 默认模型的尾巴 |

**调用 `swap_gen` 的入口**（全部走同一条尾部，语义一致）：
`POST /api/config`（`src/api.rs:361`）、`POST /api/providers/default`（`src/providers.rs:665`）、`POST /api/sessions/{id}/activate`（`src/workspaces.rs:1367`）、active 会话 rename（`src/workspaces.rs:1430`）、active 工作区 rename（`src/workspaces.rs:941`）、`POST /api/sessions/{id}/compact`（`src/compact.rs:474`）、prompts 三个写端点（`src/prompts.rs:658-666`）。

> **约束**：除 prompts 写端点外，所有会 `swap_gen` 的路径都会先抢 `busy` 槽并在 turn 进行中返回 **409**——mid-turn 换代会丢掉运行中 runtime 之后追加的事件（`src/api.rs:218-234`）。

### 2.3 模块职责表

**后端（`src/`）**

| 文件 | 行数 | 职责 | 关键符号 |
|---|---|---|---|
| `main.rs` | 1911 | 进程装配、路由、`AppState`/`Gen`/`swap_gen`、SSE 总线与 `execute_turn`、autowake 循环、静态文件服务、statusline 计算 | `DEFAULT_BIND` `MIN_STEPS` `CONTEXT_WINDOW` `STATUS_TICK` `AVAILABLE_MODELS` `AVAILABLE_EFFORTS` `available_json` `sanitized_config` `profile_to_json` `statusline_of` `emit` `loop_event_to_json` `execute_turn` `autowake_loop` `get_static` |
| `api.rs` | 594 | 引擎面端点：tools / config（GET+POST）/ status / worker 三端点；**共享** `session_event_to_message` + `parse_session_jsonl` + `validate_model_name` | `get_tools` `get_config` `post_config` `get_status` `post_worker_spawn` `post_worker_send` `get_worker_status` `parse_effort` |
| `workspaces.rs` | 2416 | 工作区注册表 + 会话目录（列出/创建/激活/重命名/分支/归档/删除/清空）、会话消息回放、`fs/browse`、legacy 迁移、路径安全 | `WorkspaceRegistry` `RegistryData` `resolve_session_dir` `session_dir_for` `sanitize_component` `scan_session_dirs` `session_meta` `write_session_meta` `move_session_dir` |
| `providers.rs` | 1318 | `providers.json`（0600 明文 key）、`public_view` 消毒、上游 `/models` 探测、keyless 同源借用引擎 key、默认模型热应用 | `ProvidersStore` `Provider` `ProviderModel` `public_view` `probe_models` `engine_self_key` `apply_startup_default` `apply_default_model` |
| `prompts.rs` | 1608 | 提示词**段注册表**（builtin/global/workspace/session 四级）+ compose 时装配 + `{{var}}` 插值 + 内存 `user_override` 旁路 | `BUILTIN_SECTIONS` `assemble_system_prompt` `effective_sections` `interpolate` `PROMPT_VARS` `resolve_prompt` `set_user_override` `persist_and_hot_apply` |
| `compact.rs` | 879 | `/compact` 上下文压缩：切完整轮、摘要轮 + 最近 K=4 轮重编号、原子写 + `.precompact` 备份、引擎重绑、SSE `compact` 事件 | `COMPACT_THRESHOLD=8` `COMPACT_KEEP_TURNS=4` `split_complete_turns` `plan_compaction` `rewrite_atomic` `claim_compact_slot` `COMPACT_SYSTEM_PROMPT` |

**前端（`frontend/src/`）**

| 文件 | 行数 | 职责 |
|---|---|---|
| `main.ts` | 85 | 引导与装配：主题 → 侧栏 → statusline → 面板 → 聊天循环 → SSE。只做初始化 |
| `api.ts` | 166 | **唯一 fetch 出处**：所有 REST 调用、`ApiError`、会话 id 一律 `encodeURIComponent` |
| `sse.ts` | 129 | `/api/events` 的 `EventSource` 封装：解析 `{turn,seq,payload}` 信封并分发；不做状态归并 |
| `state.ts` | 31 | 当前 turn 的全局 UI 状态（纯数据、无 DOM） |
| `types.ts` | 409 | 前后端共享类型契约（SSE 载荷、各端点响应） |
| `chat.ts` | 366 | turn 生命周期编排：SSE 事件 → 状态 → 消息/工具卡/状态栏；发送与取消 |
| `statusline.ts` | 430 | 两行状态条：上下文环 / 模型 / 思考强度 / tokens/s / 缓存命中率 / step |
| `theme.ts` | 66 | 主题切换；**当前只有 `mono` 单主题** |
| `ui/sessions.ts` | 986 | 左侧工作区/会话树（折叠、搜索、排序、批量操作、Worker 组） |
| `ui/providers.ts` | 970 | 设置页「模型提供商」：列表 + 编辑器 + 获取模型二级勾选窗 |
| `ui/rail.ts` | 489 | 灵动消息选择条 v3（锚定聊天区左侧留白带） |
| `ui/prompts.ts` | 373 | 设置页「提示词」：全局/工作区 scope、段覆盖编辑器 |
| `ui/restore.ts` | 352 | 启动/切换会话时恢复历史（最近 N=200 条 + 折叠提示 + SSE 去重衔接） |
| `ui/messages.ts` | 302 | 消息流：按事件真实顺序渲染用户/思考/文本/工具卡 |
| `ui/config.ts` | 320 | 「通用设置」页（热调表单 / 工具清单 / 会话管理） |
| `ui/toolcards.ts` | 174 | 工具调用卡（折叠态即显示粗略内容） |
| `ui/sidebar.ts` / `ui/inputbar.ts` / `ui/statusbar.ts` / `ui/tools.ts` / `ui/confirm.ts` / `ui/view.ts` | 29-110 | 侧栏布局 / 输入栏 / 底部状态栏 / 工具表格 / 二次确认 / 视图句柄合同 |
| `utils/dom.ts` / `utils/hljs.ts` / `utils/overlays.ts` | 50-108 | DOM 与格式化 / highlight.js 精简语言集 / **浮层 Esc 层级栈**（Esc 唯一入口） |
| `version.ts` | 45 | 构建期注入的版本标签（`versionLabel` / `describeLabel`）；真源 = git tag（`scripts/version.mjs` 经 vite `define` 注入），**不再手写**（W887） |

### 2.4 一次 turn 的完整时序

```
前端                       后端                                        引擎
 |  POST /api/turn {input}  |
 |------------------------->| post_turn                       src/main.rs:983-1027
 |                          |  - input 为空 -> 400
 |                          |  - busy 占用 -> 409
 |  202 {turn,status}       |  - 抢 busy 槽、status.reset()、emit status:start
 |<-------------------------|  - spawn execute_turn
 |  GET /api/events (SSE)   |
 |<=========================| execute_turn                    src/main.rs:902-981
 |                          |  - EventSink: LoopEvent -> SSE（带 {turn,seq,payload}）
 |                          |  - 每 STATUS_TICK=2s emit status:progress
 |                          |  - runtime.run_turn(input, cancel_rx, sink) -> TurnOutcome
 |                          |  - emit status:completed|cancelled|error|step_limit|interrupted
 |                          |  - 释放 busy 槽（永远最后一步）
 |  POST /api/cancel        | post_cancel                     src/main.rs:1028-1037
 |------------------------->|  - watch::Sender<bool>.send(true)，协作式取消
```

关键细节：

- **单并发**：同一时刻只允许一个 turn（`busy` 槽，`src/main.rs:991-1000`）。
- **取消是协作式**：引擎在每个可中断点检查 `watch` 信号（`src/main.rs:998`、`execute_turn` 的 `cancel_rx`）。
- **状态栏有两个通道**：SSE `status` 事件（增量）+ `GET /api/status`（兜底快照，`src/api.rs:79-83`）。
- **busy 槽释放顺序是契约**：`execute_turn` 结尾（`src/main.rs:975-978`）、`compact` handler 结尾（`src/compact.rs:513-514`）——任何新路径都必须遵守。

### 2.5 SSE 总线与信封

```jsonc
// 每个事件的 data 都是这个信封（src/main.rs:644-659）
{ "turn": 7, "seq": 128, "payload": { /* 事件自有字段 */ } }
```

事件名与载荷（`src/main.rs:25-33` 的头部注释**已过期**，以代码为准）：

| event | payload | 产生位置 |
|---|---|---|
| `text` | `{"delta": string}` | `LoopEvent::Text`（`src/main.rs:668`） |
| `thinking` | `{"delta": string}` | `LoopEvent::Thinking`（`src/main.rs:669`） |
| `tool` | `{"id","name","args"}` | `LoopEvent::ToolCall`（`src/main.rs:670-672`） |
| `tool_result` | `{"id","ok","value","render","error","decision"}`，`decision ∈ allow\|deny\|ask\|null` | `LoopEvent::ToolResult`（`src/main.rs:673-691`） |
| `turn_end` | `{"outcome","error"}`，`outcome ∈ completed\|cancelled\|error\|step_limit\|interrupted` | `LoopEvent::TurnEnd`（`src/main.rs:692-695`、`716-732`） |
| `done` | `{"text","tool_calls":[{"id","name","args"}]}` | `LoopEvent::Done`（`src/main.rs:696-710`） |
| `status` | `{"phase":"start\|progress\|completed\|cancelled\|error\|step_limit\|interrupted\|lagged","statusline":{...},"error"?,"source"?:"autowake"}` | `execute_turn` / `post_turn` / 慢客户端降级（`src/main.rs:883-892`、`951-973`、`1005-1011`、`1172-1178`） |
| `compact` | `{"session","kept_turns","note","rebound"}`（`turn` 字段恒为 `0`） | `src/compact.rs:480-491` |

**前端监听的事件名**：`status / text / thinking / tool / tool_result / done / context / compact`（`frontend/src/sse.ts:34-43`）。其中 `context` **后端从不发送**（全仓无 `emit(..., "context", ...)`），属于前端预留/死监听——见 §8.4 与 `docs/pitfalls.md`。

总线容量 512（`src/main.rs:1311`）；慢客户端被丢弃时收到 `status:lagged` 并自行重连（`src/main.rs:876-894`）。

### 2.6 autowake：worker 回执自动唤醒宿主

`spawn_autowake` 在启动时拉起一个常驻循环（`CELESTEA_AUTOWAKE=0/off/false/no` 关闭，`src/main.rs:1044-1049`）。语义（`src/main.rs:1057-1187`）：

- 每轮重新绑定**当前代际**的 `cli-main` mailbox，park 在 `recv()`；
- `swap_gen` 递增 `gen_epoch` → 唤醒 park 的 `select!` → 丢弃旧订阅并重绑；若消息已从旧 mailbox 弹出，则**重新投递到新代际**（`src/main.rs:1116-1126`）；
- 若 turn 正在跑，消息原样退回队列，250ms 后重试（`src/main.rs:1128-1135`）；
- 唤醒后**一次 drain 全部待投递消息**，拼成一段 input（`[from <label>] <content>`），抢 busy 槽，跑一个普通 turn（SSE 与手动 turn 完全一致）；
- 硬错误只 `eprintln` + 500ms backoff，永不 panic、永不空转。

Worker 侧入口是 `POST /api/worker/spawn`（`report_to` 指向 `cli-main` 时回执会唤醒宿主）。

### 2.7 提示词装配（compose 时）

`build_gen` 在 `Runtime::compose` **之前**决定 `profile.system_prompt`（`src/main.rs:379-397`）：

```
user_override() 有值（POST /api/config 传了 system_prompt）
    → 直接用它（内存旁路，绕过注册表）
否则
    → assemble_system_prompt(profile, base_url)
        builtin 段（代码常量 BUILTIN_SECTIONS，10 段）
          ← 全局 prompts.json 覆盖
          ← 工作区 <CELESTEA_HOME>/workspaces/<ws>/prompts.json 覆盖
          ← 会话绑定的 prompt.section_overrides（session.json 的 "prompt" 字段）
        按 (order, id) 排序 → {{var}} 插值 → 空段丢弃 → 截断到 8192 字节
    → 装配失败时回退 default_system_prompt()
```

因此**每次代际切换（热切模型 / 激活会话 / 改提示词）都会重新装配**——这是"改了 prompts.json 立即生效"的原因，也是"装配结果绝不会被误当成用户覆盖"的原因（只有内存槽算覆盖，`src/main.rs:384-396`）。细节见 `docs/data-files.md` §3。

### 2.8 statusline

后端计算，两个通道下发（`src/main.rs:519-571`）：

```jsonc
{
  "model": "...", "reasoning_effort": "max"|null,
  "steps": 12, "tokens_per_sec": 42.31,
  "context_usage": {"used": 12345, "window": 1000000, "ratio": 0.0123,
                    "estimated": false, "method": "usage_prompt_tokens"},
  "usage": { "prompt_tokens":..., "completion_tokens":..., "total_tokens":...,
             "cache_read":..., "cache_hit_ratio":..., "reasoning_tokens":...,
             "total": { /* 同上，累计值 */ } },
  "session": "<ws>/<session>"|null        // 仅 GET /api/status（src/api.rs:81）
}
```

- `steps`：`tool` / `tool_result` 事件计数（`src/main.rs:283-286`）。
- `tokens_per_sec`：`text` / `thinking` 增量字符数的 5 秒滑窗速率（`src/main.rs:297-335`）。
- `context_usage`：优先用引擎 `UsageTracker.latest().prompt_tokens`（`estimated:false`, `method:"usage_prompt_tokens"`）；无 usage 帧时退回会话日志字符估算（`estimated:true`, `method:"session_event_chars"`，`src/main.rs:545-562`）。
- `window` 取 `profile.context_window_tokens`，为 0 时用契约默认 `CONTEXT_WINDOW = 1_000_000`（`src/main.rs:89-90`、`539-544`）。
- `cache_hit_ratio = cache_read / prompt_tokens`，clamp 到 `[0,1]`，4 位小数（`src/main.rs:575-581`）。

---

## 3. 构建与运行

```bash
# ---- 前端（改动后只需 build，无需重启后端）----
cd frontend
pnpm install                                # 首次
pnpm typecheck                              # tsc --noEmit（strict）
pnpm build                                  # tsc --noEmit && vite build -> frontend/dist/
```

- 静态根是 `frontend/dist`（`STATIC_ROOT`，`src/main.rs:83`）；`dist/` 不存在时返回"先构建前端"提示页（`src/main.rs:826-847`）。
- `dist/` 与 `node_modules/` 都在 `.gitignore` 里，**不要提交构建产物**。
- `pnpm build` 是 `tsc --noEmit && vite build`（`frontend/package.json:8`），`tsconfig.json` 开了 `strict` / `noUnusedLocals` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax`。
- 版本号（W887）：**单一真源 = git tag**。`scripts/version.mjs` 的 `computeVersion()` 跑 `git describe --tags --always --dirty`（无 git / 无 tag 回落 `apps/web/package.json` 的 `version`），`apps/web/vite.config.ts` 经 `define` 注入 `__APP_VERSION__` / `__APP_COMMITS__` / `__APP_SHA__` / `__APP_DIRTY__` / `__BUILD_TIME__`，`apps/web/src/version.ts` 只读注入值（裸 vite 未注入时回落 `'dev'`）。后端 `GET /api/health.version` 用同一个脚本计算。防漂移门禁见 `tests/w887-version.test.ts`；`pnpm version:sync` 可把 `apps/web/package.json` 的 `version` 写回派生值（**刻意不挂进 `pnpm check`**，门禁不应依赖工作树 git 状态）。
- 主题：**只有 `mono` 单主题**（`frontend/src/theme.ts:12-14`）；旧 `localStorage` 里的已删主题 id 会自动回落 `mono`。

部署（systemd / nginx / 环境变量 / 重启命令）的旧后端文档已于 W881 清理出公开仓；TS 部署见 [`scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh)。

---

## 4. HTTP API 索引

完整契约（请求体字段、响应体字段、**每个错误分支的 status + error 原文**）的真源是 [`contracts/endpoints.json`](../contracts/endpoints.json)；旧后端的归档契约已于 W881 清理出公开仓。这里只给总表。

| 分组 | 端点 |
|---|---|
| 健康/状态 | `GET /api/health`、`GET /api/status`、`GET /api/tools` |
| 对话 | `GET /api/events`（SSE）、`POST /api/turn`、`POST /api/cancel`、`POST /api/clear` |
| 配置 | `GET /api/config`、`POST /api/config` |
| 会话 | `GET|POST /api/sessions`、`GET /api/sessions/{id}/messages`、`POST /api/sessions/{id}/{activate,rename,branch,compact,archive,unarchive}`、`POST /api/sessions/batch-archive`、`POST /api/sessions/batch-delete` |
| 工作区 | `GET|POST /api/workspaces`、`POST /api/workspaces/{name}/{rename,delete}`、`POST /api/workspaces/batch-delete` |
| 文件系统 | `GET /api/fs/browse?path=` |
| 提供商 | `GET|POST /api/providers`、`POST /api/providers/{id}/delete`、`POST /api/providers/test`、`POST /api/providers/{id}/models/fetch`、`POST /api/providers/default` |
| 提示词 | `GET|POST /api/prompts`、`POST /api/prompts/{id}/delete`、`POST /api/prompts/{id}/default` |
| Worker | `POST /api/worker/spawn`、`POST /api/worker/send`、`GET /api/worker/status` |
| 静态 | `GET /`、`GET /index.html`、`GET /assets/{*path}`、`GET /favicon.ico`、fallback（SPA 路由） |

**Session id 形态（必记）**：`"<workspace>/<session>"`，其中 `<workspace>` 是注册路径的**文件夹 basename**，`<session>` 是会话目录名。因为含 `/`，**URL 路径里必须 `%2F` 编码**（`GET /api/sessions/server-center%2Fmy-session/messages`）；路由层会把 `{id}` 解码回带斜杠的字符串。前端统一用 `encodeURIComponent`（`frontend/src/api.ts:90,111,117,121,123,126,129`）。第三种 id `worker:<sid>` 只在 `GET /api/sessions/{id}/messages` 里被识别。

---

## 5. 数据文件索引

完整 schema、迁移规则与格式说明在 [`docs/data-files.md`](./data-files.md)。

| 文件 | 位置（默认） | 权限 | 内容 |
|---|---|---|---|
| `workspaces.json` | `<cwd>/workspaces.json`（`CELESTEA_WORKSPACES_FILE`） | 普通 | `{"workspaces":[{"path"}],"active_session"}`（无 `version` 字段；"v2" 是命名约定） |
| `providers.json` | `<cwd>/providers.json`（`CELESTEA_PROVIDERS_FILE`） | **0600** | `{"providers":[{id,name,note,base_url,request_format,api_key,models[]}],"default_model"}`；`api_key` 明文、**永不外泄** |
| `prompts.json` | `<cwd>/prompts.json`（`CELESTEA_PROMPTS_FILE`） | 普通 | `{"sections":[],"prompts":[],"default_prompt"}`；工作区级是 `<CELESTEA_HOME>/workspaces/<ws>/prompts.json`（W880） |
| `celestea.toml` | `<cwd>/celestea.toml` | 普通 | 引擎剖面（model / base_url / api_key_env…），**不含 key** |
| 会话目录 | `<CELESTEA_HOME>/workspaces/<ws>/sessions/<session dir>/`（W880；legacy `<workspace path>/<session dir>/` 只读兼容） | 普通 | `cli-main.jsonl`（引擎 v1 `SessionEvent` 逐行 JSON）+ 可选 `session.json`（`{"model","prompt"}`） |
| 压缩备份 | 同上目录 | 普通 | `cli-main.jsonl.precompact`（**单副本、覆盖式**，人工回滚通道） |
| 归档/回收站 | `<CELESTEA_HOME>/workspaces/<ws>/archive/`、`<CELESTEA_HOME>/workspaces/<ws>/trash/`（W880；legacy `<ws>/.celestea-archived/`、`<ws>/.celestea-trash/` 只读兼容） | 普通 | 归档保持原名（可 unarchive）；回收站加 `-<ts>` 后缀（**不可再按 id 寻址**） |

`.gitignore` 已排除 `providers.json` / `workspaces.json` / `sessions/` / `frontend/dist/` / `target/`（`.gitignore:1-14`）。

---

## 6. 踩坑档案

**所有条目都来自真实修复**，完整版在 [`docs/pitfalls.md`](./pitfalls.md)。摘要：

| # | 坑 | 一句话结论 |
|---|---|---|
| P1 | 提供商**身份** | `id` 是身份，`name` 只是显示名；编辑器必须沿用 `originalId`，否则热编辑会按名称造出重复记录 |
| P2 | 无 key 的同源 provider | `base_url` 归一化后等于引擎自身网关时，探测模型**借用引擎 key**（请求级、不落盘、不回显） |
| P3 | 获取模型流程 | 先**保存表单** → 拉上游 `/models` → 二级勾选窗（默认不勾、确认才填）；空模型行在前端 `buildPayload` 里跳过 |
| P4 | 数值字段 | 前端支持 `k`/`m` 后缀（`1m = 1000000`）；**后端只收 JSON number** |
| P5 | `reasoning_effort` | **自由字符串**，Studio 不得折叠/重命名（`max` 就是 `max`）；空串/`off` 表示清除 |
| P6 | `/compact` | 409 守卫 → 摘要轮 + 最近 K=4 轮重编号 → 原子写 + `.precompact` → 引擎重绑；重绑失败不回滚日志 |
| P7 | SSE 信封 | `turn` 字段必须随事件传递（`sse.ts` 只发 payload 会丢 `turn`） |
| P8 | 主题/版本 | 只有 `mono` 单主题；版本号 W887 起由 git tag 构建期派生（`scripts/version.mjs`），`version.ts` 不再手写 |
| P9 | 前端铁律 | 见 `apps/web/FRONTEND-RULES.md`：禁止"先清空后加载"、禁止整树 `innerHTML` 重建、切换必须防竞态 |
| P10 | session id 编码 | 路径参数里的 `/` 必须 `%2F`，否则会被当成两段路径 → 404 |

---

## 7. 开发者工作流

### 7.1 本地起一个临时实例（做 e2e）

**永远不要动 3777 上的生产实例**（用户正在用）。用独立端口 + 独立数据文件起临时实例：

```bash
cd /src/celestea_studio-ts

TMP=$(mktemp -d)
mkdir -p "$TMP/sessions/scratch"
: > "$TMP/sessions/scratch/cli-main.jsonl"

# 端口避开 3777；数据文件全部指到临时目录
STUDIO_BIND=127.0.0.1:3799 \
CELESTEA_WORKSPACES_FILE="$TMP/workspaces.json" \
CELESTEA_PROVIDERS_FILE="$TMP/providers.json" \
CELESTEA_PROMPTS_FILE="$TMP/prompts.json" \
CELESTEA_SESSION_DIR="$TMP/sessions/scratch" \
CELESTEA_AUTOWAKE=0 \
CELESTEA_API_KEY="$CELESTEA_API_KEY" \
./target/release/celestea-studio
```

要点：
- `STUDIO_BIND` 覆盖绑定地址（`src/main.rs:1379`），**必须**避开 3777；
- `CELESTEA_AUTOWAKE=0` 关掉自动唤醒循环，避免测试期间被 worker 回执打断（`src/main.rs:1044-1049`）；
- `CELESTEA_WORKSPACES_FILE` 指向不存在的文件会触发 bootstrap 迁移，但迁移源是 `<cwd>/sessions`——**临时实例的 cwd 不要放在生产仓库根**，或者先手工写好临时 `workspaces.json`（`{"workspaces":[{"path":"<tmp>/sessions"}],"active_session":"sessions/scratch"}`）；
- 用 `curl` 打端点、用 `curl -N` 看 SSE：
  ```bash
  curl -s http://127.0.0.1:3799/api/health
  curl -N http://127.0.0.1:3799/api/events &      # SSE
  curl -s -X POST http://127.0.0.1:3799/api/turn -H 'content-type: application/json' \
       -d '{"input":"ping"}'
  ```

### 7.2 scratch 会话 e2e 的安全做法（对着生产实例验证 UI/契约）

当必须在真实实例上验证（例如复现前端 bug）时：

1. **只创建 scratch 会话，绝不激活**：`POST /api/sessions {"workspace":"<某个 ws>","title":"scratch-e2e-<ts>"}`；
2. 需要读历史时用 **URL 编码**的 id：`GET /api/sessions/<ws>%2F<dir>/messages`；
3. **不要** `activate`/`rename`/`archive`/`batch-delete` 用户的活动会话——active 会话被这些端点保护（400），但 `rename` 非 active 会话也会真移目录，别碰；
4. 跑完**删掉 scratch**：`POST /api/sessions/batch-delete {"ids":["<ws>/scratch-e2e-<ts>"]}`（进 `<CELESTEA_HOME>/workspaces/<ws>/trash/`，可恢复）；
5. 结束时确认用户活动会话没被改：`GET /api/status` 的 `session` 字段应与开工前一致；`GET /api/workspaces` 的 `active_session` 同理；
6. **禁止**在生产实例上跑 `POST /api/clear`（它没有 409 守卫、没有备份，会直接截断活动会话日志，`src/workspaces.rs:1506-1511`）。

### 7.3 改动的自检清单

- 后端：改动后重编 + 测试全绿；新端点要在 `docs/archive/api-contract.md` 补一行。
- 前端：`pnpm typecheck` + `pnpm build` 通过；对照 `apps/web/FRONTEND-RULES.md` 逐条自查（空白帧 / 整树闪动 / 旧结果覆盖新状态 任一出现即不合格）。
- 改了 `AppState` / `swap_gen` / busy 槽：确认**所有**释放路径（成功、取消、错误、409 前置返回）都不漏。
- 改了 provider / prompts / 会话写盘：确认"先判 409 再落盘"的顺序没有被破坏（否则会出现"返回 409 但已经写盘"）。
- 提交前：`git status` 只包含你改的文件；**禁止 `git add -A` / `commit -am` / `push`**。

---

## 8. 测试现状

### 8.2 前端：`pnpm build` = `tsc --noEmit`（strict）+ `vite build`

没有单元测试框架；前端质量门 = **strict 类型检查 + 铁律人工核对**（`apps/web/FRONTEND-RULES.md`）。`pnpm typecheck` 单独跑类型检查更快。

### 8.3 如何加测试

- 后端：在对应模块底部加 `#[cfg(test)] mod tests`（现有模块都这么组织）。要驱动完整 compose 时用 `FakeLlm` 模式（`src/main.rs:1433-1437`）；要驱动 handler 时构造 `Shared`（参考 `src/providers.rs:1126` 的 `probe_state`、`src/prompts.rs:1201` 的 `handler_state`）。
- 涉及全局 env 的测试**必须**套 `COMPOSE_ENV_LOCK`，并在结束时恢复 env。
- 前端：目前没有测试框架，不要擅自引入；逻辑尽量下沉到 `state.ts` / 纯函数，用 `pnpm typecheck` 兜住。

### 8.4 已知与代码不一致 / 待修（本次核对发现）

> 这些是**文档 vs 代码**或**注释 vs 代码**的偏差，不影响当前运行行为，但会误导后来人。建议后续单独提交修正（本任务只写文档，不改代码）。

1. **`README.md` 已过期**：写"frontend (embedded at compile time)"，实际 W218 起是从磁盘读 `frontend/dist/`（`src/main.rs:8-10`、`741-783`）；API 列表也缺绝大多数端点。
2. **`src/api.rs:87-93` 注释过期**：声称"thinking 不可能出现、tool 事件用 `name(args)` 摘要作 content"，实际 `ThinkingDelta` → `{"role":"thinking"}`（`src/api.rs:103-105`），tool 事件是结构化字段、**没有 `content`**（`src/api.rs:106-133`）。
3. **`src/main.rs:25-33` SSE 事件清单不完整**：漏了 `turn_end`（`src/main.rs:693`）与 `compact`（`src/compact.rs:484`）。
4. **前端监听了一个后端从不发送的事件**：`sse.ts` 的 `EVENT_NAMES` 含 `context`，但全仓无 `emit(..., "context", ...)`（`frontend/src/sse.ts:34-43`）。
5. **`src/api.rs:193-195`、`src/main.rs:121-124`、`360` 的 effort 注释过期**：仍写"max → engine High / 接受 medium"，实际 W260 起是**自由字符串直通**（`src/api.rs:207-216`）。
6. **`src/providers.rs:338-340` 注释与实现不符**：注释说"每个出现的字段生效"，实际**只有 `api_key` 是缺省保留**；`models`/`note`/`request_format` 缺省会被**清空/重置**（`src/providers.rs:351-358`、`376-381`）——这是真陷阱，见 `docs/pitfalls.md` P1 补充。
7. **`src/main.rs:1196-1200` 注释与代码不符**：注释说默认工作区名是「默认」、active 是「默认/cli-main」，代码用的是默认根的 **basename**（`<cwd>/sessions` → `sessions/cli-main`，`src/workspaces.rs:402-409`）。
8. **`frontend/src/types.ts` 的 `SessionsResp` 是超集**：含 `events/live/file/archived`，后端 `GET /api/sessions` 不产出这些键（`src/workspaces.rs:1112-1120`）；`MessagesResp` 缺 `tool_parent_id`（后端会带，`src/api.rs:116-118`）。
9. **`/api/clear` 无备份、无 409 守卫**（`src/workspaces.rs:1506-1511`）——前端有二次确认，但 API 层没有保护。
10. **`compact` 的日志重写先于引擎重绑**：重绑失败（400/500）时磁盘已是压缩后日志，唯一回滚通道是 `cli-main.jsonl.precompact`（`src/compact.rs:441-476`）。
11. **`activate` compose 失败时 `CELESTEA_SESSION_DIR` 已被改写且不回滚**（`src/workspaces.rs:1353-1359`）。
12. **`providers.json` / `workspaces.json` 都没有 `version` 字段**：所谓 v2 只是命名约定，靠字段形态与 `normalize_registry` 判定，不是显式版本号。
13. **`session.json` 只在 `POST /api/sessions` 时写入**：`POST /api/config` 改模型**不会**回写会话级 model，会话级模型只在创建时决定（`src/workspaces.rs:1206-1218`）。
14. **本文校对期间代码在动**：W263（statusline 真实化 / 引擎 usage / 缓存命中率）在本文撰写过程中从"未提交"变为已提交（`937fe63`），测试数也从 65 变到 69。凡"数量/行号"类结论都可能随后续提交漂移；**契约与机制结论不受影响**，且都标了符号名。

---

## 9. 文档维护约定

- 端点增删 → 同步 `docs/archive/api-contract.md` 的总表 + 明细；数据文件字段变化 → 同步 `docs/data-files.md`。
- 修掉一个 bug → 在 `docs/pitfalls.md` 追加/更新条目（**必须写根因与代码位置**），不要只写"已修复"。
- 本文档里的行号以当前代码为准；大规模重构后行号会漂移，**以符号名为准**（每个结论都给了函数名）。
- 不在文档里写任何 API key、token、真实密钥（只用环境变量名与文件路径）。
