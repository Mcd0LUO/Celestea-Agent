# Celestea Studio · HTTP API 契约

> 📦 历史文档（2026-09-11 归档）：描述的是已退役 Rust 后端（axum，39 端点）的 HTTP 契约。当前权威入口见 [/src/celestea_studio-ts/contracts/endpoints.json](/src/celestea_studio-ts/contracts/endpoints.json)（43 端点）与 [/src/celestea_studio-ts/docs/README.md](/src/celestea_studio-ts/docs/README.md)。

> 权威来源：`src/main.rs` 路由表（`src/main.rs:1333-1376`）+ 各 handler 实现。
> 所有 `error` 字符串都是**代码原文**（可直接 grep）。契约字段名保留英文。
> 默认绑定 `127.0.0.1:3777`（`STUDIO_BIND` 可覆盖，`src/main.rs:1379`）。

## 0. 通用约定

| 约定 | 说明 |
|---|---|
| 响应体 | 一律 JSON（`Content-Type: application/json`），SSE 与静态文件除外 |
| 错误体 | `{"ok": false, "error": "<原文>"}`（`workspaces.rs:770-772`、`compact.rs:395-397` 各有一份同形实现）；少数 handler 只返回 `{"error": ...}` |
| 请求体 | `POST` 端点若声明了 `Json<T>` 提取器，**缺 body / 非 JSON / 缺必填字段** 由 axum 0.8 直接拒绝（415 / 400 / 422），不进 handler |
| 无 body 的 POST | 前端仍会发 `{}`（`frontend/src/api.ts:70-76`），后端忽略 |
| session id | `"<workspace>/<session>"`；路径参数里的 `/` **必须 `%2F` 编码**（`src/main.rs:1345-1348`）；另有 `worker:<sid>` 仅在 messages 端点生效 |
| 工作区名 | 注册路径的文件夹 basename（`Path::file_name`）；路径参数同样 `encodeURIComponent` |
| 单并发 | 所有会换引擎代际（`swap_gen`）或压缩的写端点都会抢 `busy` 槽；turn 进行中返回 **409** |
| key 安全 | 任何响应都不含 `api_key`；`POST /api/config` 的 `api_key` 只进进程 env（不落盘、不打日志、不回显） |

### 错误码语义速查

| status | 语义 |
|---|---|
| 400 | 参数非法（空值、格式、路径非绝对/不存在、id 形态错误、活动会话保护） |
| 404 | 未知 workspace / session / provider / prompt |
| 405 | 路径存在但 method 不匹配（axum 默认） |
| 409 | 冲突：turn 进行中（busy 槽）、重复注册、目标已存在、已归档 |
| 415 / 422 | 请求体缺失/非 JSON/字段类型不符（axum `Json` rejection，代码未定制） |
| 500 | 落盘失败 / compose 失败 / 读写 IO 失败 |
| 502 | **仅** worker 工具派发硬失败（`src/api.rs:419-433`） |

---

## 1. 健康 / 状态 / 工具

### `GET /api/health`
`src/main.rs:860-869`。无参数。

```json
{"ok":true,"name":"celestea-studio","model":"<当前模型>","base_url":"<当前网关>","bind":"127.0.0.1:3777"}
```
恒 200，无错误分支。`bind` 是**常量 `DEFAULT_BIND`**，不随 `STUDIO_BIND` 变化（`src/main.rs:867`）。

### `GET /api/status`
`src/api.rs:79-83` + `src/main.rs:536-571`。无参数。

```json
{
  "model":"...", "reasoning_effort":"max"|null,
  "steps":0, "tokens_per_sec":0.0,
  "context_usage":{"used":89,"window":1000000,"ratio":0.0001,
                   "estimated":true,"method":"session_event_chars"},
  "usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cache_read":0,
           "cache_hit_ratio":0.0,"reasoning_tokens":0,
           "total":{ /* 同形，累计值 */ }},
  "session":"<ws>/<session>"|null
}
```
恒 200。`session` 来自 `workspaces.active_session()`。`method` 二值：`usage_prompt_tokens`（有真实 usage 帧）或 `session_event_chars`（字符估算）。

### `GET /api/tools`
`src/api.rs:40-50`。无参数。

```json
{"tools":[{"name":"read_file","description":"..."}]}
```
恒 200（当前代际 `registry.schemas()`）。无错误分支。

---

## 2. 对话

### `GET /api/events` — SSE
`src/main.rs:871-896`。

- 无参数；`text/event-stream`；`KeepAlive` 默认开启。
- 每条事件 `data` 是信封：`{"turn":N,"seq":M,"payload":{...}}`（`src/main.rs:644-659`）。
- 事件名与载荷见 `docs/DEVELOPMENT.md` §2.5。
- 慢客户端被 broadcast 丢弃时收到 `event: status` + `{"phase":"lagged","hint":"slow client, skipped events","statusline":{...}}`，流继续（`src/main.rs:883-892`）。
- 总线容量 512（`src/main.rs:1311`）。

### `POST /api/turn`
`src/main.rs:983-1027`。

请求：`{"input":"<非空字符串>"}`（`TurnReq`，`src/main.rs:640-643`）

| 情况 | status | body |
|---|---|---|
| 正常 | **202** | `{"turn":7,"status":"started"}` |
| `input` trim 后为空 | 400 | `{"error":"input must not be empty"}` |
| 已有 turn 在跑 | 409 | `{"ok":false,"error":"a turn is already running"}` |

语义：抢 busy 槽 → `status.reset()` → `emit status:start` → `spawn execute_turn` 立即返回 202；真正的结果全部走 SSE。

### `POST /api/cancel`
`src/main.rs:1028-1037`。无 body（忽略）。

```json
{"ok":true,"cancelled":true}    // 有 turn 在跑，已发出取消信号
{"ok":true,"cancelled":false}   // 空闲
```
恒 200。协作式取消：引擎在可中断点退出，SSE 收到 `status:phase=cancelled`。

### `POST /api/clear`
`src/workspaces.rs:1506-1511`。无 body。

```json
{"ok":true,"cleared":true,"session":"<ws>/<session>"|null}
```
恒 200。语义：对当前 generation 的 `gen.runtime.session.clear()` —— 对 `PersistentSessionLog` 即截断 `cli-main.jsonl` + 清空内存事件 + 轮号归零。
**注意**：无备份、无 409 守卫、不影响 worker 会话（`docs/pitfalls.md` P11）。

---

## 3. 配置

### `GET /api/config`
`src/api.rs:56-70`。无参数。

```json
{
  "model":"deepseek-v4-flash-0731",
  "base_url":"http://127.0.0.1:3001/v1",
  "max_steps":4096,
  "max_parallel_tool_calls":1,
  "reasoning_effort":"max"|null,
  "max_output_tokens":null|12345,
  "context_window":1000000,
  "system_prompt":"<装配后的提示词>",
  "api_key_env":"CELESTEA_API_KEY",
  "available":{"models":[{"id","name","provider","reasoning"}],"efforts":["low","high","max"]}
}
```
恒 200。`available.models` **每次读取都从 live providers store 重建**（`src/api.rs:61-68`），provider store 无记录时回落到静态 `AVAILABLE_MODELS`（`provider:""`），id 去重、provider 记录优先（`src/main.rs:157-190`）。永不包含 key。

### `POST /api/config`
`src/api.rs:227-372`。请求体 `ConfigReq`（`src/api.rs:190-203`），**全字段可选**：

| 字段 | 类型 | 语义 |
|---|---|---|
| `model` | string | 换模型；trim 后为空视为未提供 |
| `reasoning_effort` | string \| null | **自由字符串**；`""`/`"off"`（大小写不敏感）= 清除；其他值原样透传（`parse_effort`，`src/api.rs:207-216`） |
| `base_url` | string | 必须 `http://`/`https://`；空串 = 清除覆盖，回落到 env / provider 默认链 |
| `api_key` | string | 只进 `env[api_key_env]`；不落盘、不打日志、不回显 |
| `max_output_tokens` | number | `0` = 清除上限；`> u32::MAX` → 400 |
| `context_window` | number | 写 `context_window_tokens`；`0` = 关闭裁剪（statusline 回落到契约默认窗口） |
| `max_steps` | number | `0` → 400；实际写入 `max(n, 4096)`（**只能抬高，不能低于 `MIN_STEPS`**） |
| `system_prompt` | string | 空串 = 清除内存覆盖、恢复注册表装配；非空 = 内存旁路覆盖 |

响应：**200 + 与 `GET /api/config` 同形的消毒配置**（`src/api.rs:361-371`）。

| status | 触发条件 | body.error |
|---|---|---|
| 409 | busy 槽被占 | `turn in progress; config applies between turns` |
| 400 | 模型名非法（引擎校验） | 引擎原文 |
| 400 | 模型名非法（Studio 宽松校验：≤128 字符，仅 `[A-Za-z0-9._-:/@]`） | `invalid model name '{m}': character {bad:?} is not allowed (only [A-Za-z0-9._-:/@]; no spaces, brackets or control characters)` / `invalid model name: '{m}' exceeds 128 characters` |
| 400 | 非推理模型 + 给了 effort | `model '{target}' is not a reasoning model; reasoning_effort is unavailable` |
| 400 | `base_url` 非 http(s) | `base_url must be an http:// or https:// URL` |
| 400 | `max_output_tokens > u32::MAX` | `max_output_tokens must be <= u32::MAX` |
| 400 | `max_steps == 0` | `max_steps must be >= 1` |
| 500 | compose 失败 | `compose failed: {e}` |

> 推理能力判定：`model_reasoning(id)` 查静态目录，**未知 id 视为推理可用**（自定义端点友好，`src/main.rs:135-137`）。

---

## 4. 会话

> 所有 `{id}` 都是 `"<workspace>/<session>"`，**URL 里必须 `%2F` 编码**。
> 公共错误（来自 `resolve_session_dir` / `session_dir_for`，`src/workspaces.rs:611-652`）：
> - 400 `invalid session id '{id}': expected '<workspace>/<session>'`（无斜杠/多斜杠/空段）
> - 404 `unknown workspace '{ws_name}'`
> - 400 `invalid session id '{id}'`（session 段 sanitize 后为空 / `.` / `..` / 以 `.` 开头 / 解析后父目录不是 workspace 路径）
> - 404 `unknown session '{id}'`（目录或 `cli-main.jsonl` 不存在）

### `GET /api/sessions`
`src/workspaces.rs:1092-1132`。无参数。

```json
{
  "sessions":[
    {"id":"<ws>/<dir>","workspace":"<ws basename>","title":"<dir 名>",
     "model":"<session.json 的 model>"|null,"size":12345,"modified":1788940601,"active":true},
    {"id":"worker:<sid>","workspace":"engine","kind":"worker","title":"...",
     "model":null,"size":42,"modified":0,"active":false}
  ],
  "active_session":"<ws>/<session>"|null
}
```
恒 200，**无 `ok` 字段**。三个来源：工作区会话目录（直接子目录且含 `cli-main.jsonl`，跳过 dot-dir）+ 引擎内存 worker 会话（`kind:"worker"`；compose 期的 `cli-main` 影子注册被跳过）。排序按 `id` 字符串升序。`size` 是 `cli-main.jsonl` 字节数（worker 是事件数），`modified` 是秒级 mtime。

### `POST /api/sessions`
`src/workspaces.rs:1137-1221`。

请求 `SessionCreateReq`（`src/workspaces.rs:1001-1014`）：
```json
{"workspace":"<ws 名，可省>","title":"<非空标题>","model":"<可选>","prompt":"<可选>"}
```
`workspace` 缺省链：active id 的第一段 → 第一个注册 workspace 的 basename。

成功 **200**：`{"ok":true,"id":"<ws>/<新目录名>"}`。目录名 = `"{sanitized title}-{secs}.{nanos}"`，碰撞追加 `-{n}`。**不激活**。`model`/`prompt` 至少一个非空时写 `session.json`。

| status | body.error |
|---|---|
| 404 | `unknown workspace '{ws_name}'` |
| 400 | `invalid model: {e}` |
| 400 | `invalid prompt: {e}` |
| 400 | `title must not be empty` |
| 400 | `title '{title}' sanitizes to the hidden name '{base}'` |
| 404 | `workspace path '{path}' is not accessible` |
| 500 | `create failed: {e}` / `meta write failed: {e}`（后者会回滚删除目录） |

### `GET /api/sessions/{id}/messages`
`src/workspaces.rs:1459-1501`。

成功 **200**：`{"ok":true,"session":"<原样 id>","messages":[...]}`
- 文件会话：解析 `<dir>/cli-main.jsonl`（引擎 v1 `SessionEvent` 逐行 JSON），遇首个不可解析行即停止（撕裂尾部丢弃，`src/api.rs:141-153`）。
- `worker:<sid>`：读引擎内存 `SessionRegistry`，未命中 404 `unknown session '{id}'`。
- 读文件失败 404 `unknown session`。

消息契约（`session_event_to_message`，`src/api.rs:94-135`）：

| SessionEvent | 输出 |
|---|---|
| `TurnStart` / `TurnEnd` | **不输出**（结构事件） |
| `UserMessage{text}` | `{"role":"user","content":text}` |
| `AssistantMessage{text}` | `{"role":"assistant","content":text}` |
| `ThinkingDelta{text}` | `{"role":"thinking","content":text}` |
| `ToolCall{id,name,args,parent_id}` | `{"role":"tool","kind":"call","tool_call_id":id,"tool_name":name,"tool_args":args}`（`parent_id` 有值时**追加** `"tool_parent_id"`；**无 `content` 字段**） |
| `ToolResult{id,value,error,parent_id}` | `{"role":"tool","kind":"result","tool_call_id":id,"tool_value":value,"tool_error":error}`（同上追加 `tool_parent_id`；两个值恒在，可为 null） |

孤儿 `ToolResult`（无对应 `ToolCall`）照常输出——映射是逐事件独立、**没有配对/丢弃逻辑**。

### `POST /api/sessions/{id}/activate`
`src/workspaces.rs:1323-1374`。无 body。

成功 **200**：`{"ok":true,"active_session":"<ws>/<session>"}`（用 resolve 后的 canonical 值）。

| status | body.error |
|---|---|
| 409 | `turn in progress; activate applies between turns` |
| 400 | `invalid session model: {e}`（`session.json` 的 model 非法） |
| 500 | `compose failed: {e}` |
| 500 | `cannot persist active session: {e}` |

顺序：busy 守卫 → resolve → 当前 profile → 可选 `session.json` 的 model 覆盖 → `set_var("CELESTEA_SESSION_DIR", dir)` → `prepare_gen` → `set_active` → `swap_gen`。**compose 失败时 env 已被改写且不回滚**（`docs/pitfalls.md` P12）。

### `POST /api/sessions/{id}/rename`
`src/workspaces.rs:1382-1434`。请求：`{"new_title":"<非空>"}`。

成功 **200**：`{"ok":true,"id":"<ws>/<新目录名>"}`。同名 = no-op 成功；碰撞自动 `-{n}`。重命名 **active** 会话时走 activate 尾部（busy 守卫 + 重绑定，失败回滚目录移动）。

| status | body.error |
|---|---|
| 409 | `turn in progress; rename applies between turns`（仅 active 会话才取 busy 锁） |
| 400 | `new title must not be empty` |
| 400 | `title '{...}' sanitizes to the hidden name '{base}'` |
| 500 | `move failed: {e}` / `compose failed: {e}` / `cannot persist active session: {e}` |

### `POST /api/sessions/{id}/branch`
`src/workspaces.rs:1440-1454`。请求：`{"title":"<可选>"}`（缺省 `"{源名}-分支"`）。

成功 **200**：`{"ok":true,"id":"<ws>/<新目录名>"}`。复制 `cli-main.jsonl`（以及 `session.json` 若存在）到新兄弟目录；**从不激活**。

| status | body.error |
|---|---|
| 400 | `title must not be empty` / `title sanitizes to the hidden name '{base}'` |
| 500 | `create failed: {e}` / `copy failed: {e}` / `meta copy failed: {e}`（均回滚删除新目录） |

### `POST /api/sessions/{id}/compact`
`src/compact.rs:505-519`。**无请求体**（前端发 `{}` 也无影响）。

| status | body | 条件 |
|---|---|---|
| 200 | `{"ok":true,"compacted":false,"note":"历史不足，无需压缩"}` | 完整轮数 `<= COMPACT_THRESHOLD = 8`（即 **≥9 个完整轮**才压缩）；**无 `kept_turns`** |
| 200 | `{"ok":true,"compacted":true,"kept_turns":4,"note":"已压缩：摘要轮 + 最近4轮"}` | 成功 |
| 409 | `{"ok":false,"error":"turn 进行中，无法压缩"}` | busy 槽被占 |
| 400 | `{"ok":false,"error":"invalid session model: {e}"}` | 活动会话重绑路径上 `session.json` 的 model 非法 |
| 500 | `{"ok":false,"error":"..."}` | 见下 |
| 400/404 | `{"ok":false,"error":"..."}` | 来自 `session_dir_for` |

500 错误原文（摘要/落盘阶段）：
`读取会话日志失败：{e}`、`摘要请求缺少可用密钥：{e}`、`摘要请求失败：{e}`、`摘要请求失败：HTTP {status}：{head 300}`、`摘要响应读取失败：{e}`、`摘要响应不是 JSON（{e}）；body 头部：{head 200}`、`摘要响应缺少 choices[0].message.content`、`内部错误：压缩计划为空`、`备份失败 '...'：{e}`、`临时文件创建失败 '...'：{e}`、`临时文件写入失败 '...'：{e}`、`临时文件 fsync 失败 '...'：{e}`、`原子替换失败 '...'：{e}`、`compose failed: {e}`。
**所有摘要错误串都经 `redact` 抹掉 api key**（`src/compact.rs:246-252`、`819-827`）。

成功时额外广播 SSE `compact` 事件：`{"session":"<canonical>","kept_turns":4,"note":"...","rebound":true|false}`（信封 `turn` 恒为 0）。算法细节见 `docs/pitfalls.md` P6 与 `docs/data-files.md` §4。

### `POST /api/sessions/{id}/archive` / `POST /api/sessions/{id}/unarchive`
`src/workspaces.rs:1580-1601`。无 body。成功 **200** `{"ok":true}`。

| 端点 | 目标位置 | 错误 |
|---|---|---|
| archive | `<ws>/.celestea-archived/<name>` | 400 `active session '{id}' cannot be archived`；404 `unknown session '{id}'`；409 `session '{id}' is already archived`；500 `mkdir failed: {e}` / `move failed: {e}` |
| unarchive | 回到 `<ws>/<name>` | 404 `session '{id}' is not archived`；409 `a live session already exists at '{id}'`；500 `move failed: {e}` |

归档保持目录原名 → id 不变、可 unarchive；删除（trash）会加 `-<ts>` 后缀 → **之后无法按 id 寻址**。

### `POST /api/sessions/batch-archive`
`src/workspaces.rs:1605-1623`。请求：`{"ids":["<ws>/<s>", ...]}`。恒 **200**：
```json
{"ok":true,"archived":2,"failed":[{"id":"...","error":"..."}]}
```
逐条继续，失败进 `failed`。

### `POST /api/sessions/batch-delete`
`src/workspaces.rs:1627-1645`。请求同上。恒 **200**：
```json
{"ok":true,"deleted":2,"failed":[{"id":"...","error":"..."}]}
```
目标是 `<ws>/.celestea-trash/<name>-<ts>`（**可恢复**）；active 会话被拒（400）。

---

## 5. 工作区

### `GET /api/workspaces`
`src/workspaces.rs:794-796`。无参数。恒 **200**，**无 `ok`**：
```json
{"workspaces":[{"name":"<basename>","path":"/abs/path","sessions":3}],"active_session":"<ws>/<s>"|null}
```
`sessions` 只数**存活**会话目录（不含归档/回收站）。

### `POST /api/workspaces`
`src/workspaces.rs:818-844`。请求：`{"path":"<绝对存在的目录>"}`（v1 的 `name` 字段被容忍并忽略）。

成功 **200**：`{"ok":true,"name":"<folder basename>"}`。**只注册，不创建/不修改目录**。

| status | body.error |
|---|---|
| 400 | `path must not be empty` |
| 400 | `path '{path}' must be absolute` |
| 400 | `path '{path}' is not an existing directory` |
| 409 | `path '{path}' is already registered as workspace '{base}'` |
| 400 | `path '{path}' has no folder name` |
| 409 | `workspace '{base}' already exists (folder '{path}' and '{other}' share the same folder name; rename one folder first)` |
| 500 | 持久化错误串 |

### `POST /api/workspaces/{name}/rename`
`src/workspaces.rs:870-945`。请求：`{"new_name":"<新文件夹名>"}`。

成功 **200**：完整 registry view（同 `GET /api/workspaces`）。**会真的 `fs::rename` 用户文件夹**；active 会话在该工作区时会重绑定引擎代际。

| status | body.error |
|---|---|
| 409 | `turn in progress; rename applies between turns`（仅 active 会话在该 ws 时取 busy 锁） |
| 400 | `workspace name must not be empty` / `invalid workspace name '{name}'` |
| 404 | `unknown workspace '{old}'` |
| 409 | `workspace '{new_name}' already exists` |
| 409 | `target '{new_path}' already exists; rename the folder first` |
| 500 | `move failed: {e}` / `cannot derive the moved session dir` / `compose failed: {e}` / `cannot persist active session: {e}`（后三者回滚） |

### `POST /api/workspaces/{name}/delete`
`src/workspaces.rs:853-861`。无 body。成功 **200** `{"ok":true}`——**只注销，不动用户文件夹**。若 active 会话属于该 ws，`active_session` 被清空。
错误：404 `unknown workspace '{name}'`；500 持久化错误串。

### `POST /api/workspaces/batch-delete`
`src/workspaces.rs:949-966`。请求：`{"names":["ws1","ws2"]}`。恒 **200**：
```json
{"ok":true,"deleted":1,"failed":[{"name":"ws2","error":"unknown workspace 'ws2'"}]}
```

---

## 6. 文件系统浏览

### `GET /api/fs/browse?path=<绝对路径>`
`src/workspaces.rs:733-766`。`path` 省略/空白 → 列 `/`。

成功 **200**：
```json
{"path":"/src","parent":"/","dirs":["celestea_studio","celestea_harness"],"roots":["/src","/tmp","/srv","/home"]}
```

失败 **400**（注意不是 200 带 error）：
```json
{"path":"<原样 raw>","parent":null,"dirs":[],"roots":[...],"error":"path '/x' is not an existing directory"}
```
错误串：`path '{p}' must be absolute`、`path '{p}' is not an existing directory`、`cannot read '{p}': {e}`。

安全语义（`browse_dirs`，`src/workspaces.rs:700-725`）：只返回**目录名**（文件永不列出）、跳过 `.` 开头、不跟随符号链接、排序后截断 `MAX_DIR_ENTRIES = 200`。
`roots` 是**硬编码常量** `["/src","/tmp","/srv","/home"]`，**仅信息性**——浏览不受它限制；本端点**不读** `CELESTEA_TOOL_ROOTS`（那个变量属于引擎工具守卫）。本端点**无鉴权**，默认只绑环回；若把 `STUDIO_BIND` 改成非环回地址，等于开放任意绝对路径的目录名枚举。

---

## 7. 模型提供商

> `providers.json` 的 `api_key` 是明文（文件 0600），但 **`public_view` 里 `api_key` 键根本不存在**（`src/providers.rs:219-241`）。

### `GET /api/providers`
`src/providers.rs:673-675`。恒 **200**：
```json
{
  "providers":[{
    "id":"...","name":"...","note":"...","base_url":"...","request_format":"chat_completions",
    "models":[{"id":"...","name":"...","reasoning_efforts":["low","high","max"],
               "context_window":1000000,"max_output_tokens":128000}],
    "is_default":true,"has_key":true
  }],
  "default_model":"..."|null
}
```
`is_default` = `default_model` 命中该 provider 的任一 model（多个 provider 列同一 model 时**都**为 true）；`has_key` = `api_key` 存在且非空（**未 trim**）。

### `POST /api/providers`
`src/providers.rs:679-698`。请求 `ProviderReq`（`src/providers.rs:269-280`）：

| 字段 | 必需 | 语义 |
|---|---|---|
| `id` | ✅ | **身份**。同 id = 覆盖更新 |
| `name` | ❌ | 显示名；缺省/空 → 回退为 `id` |
| `note` | ❌ | 备注；**缺省 → 清空为 `""`** |
| `base_url` | ✅ | 必须 `http(s)://` |
| `request_format` | ❌ | 缺省 → `chat_completions`（**会把已存的 `anthropic_messages` 悄悄改回**）；合法值 `chat_completions` / `responses` / `anthropic_messages`（后两者引擎适配器 TODO，仅存储+展示） |
| `api_key` | ❌ | **缺省/null/空白 = 保留库中旧 key**（唯一"缺省保留"的字段） |
| `models[]` | ❌ | 缺省 → **清空该 provider 的模型列表**；每项 `{id,name?,reasoning_efforts?,context_window?,max_output_tokens?}` |

成功 **200**：**`public_view` 整体**（不是 `{"ok":true}`）。

| status | body.error |
|---|---|
| 400 | `provider id must not be empty` |
| 400 | `base_url is required` |
| 400 | `base_url must be an http:// or https:// URL` |
| 400 | `invalid request_format '{t}': expected chat_completions \| responses \| anthropic_messages` |
| 400 | `each model needs a non-empty id`（**空模型行会让整个请求失败**，后端不跳过） |
| 500 | `providers serialize failed: {e}` 等落盘错误 |

### `POST /api/providers/{id}/delete`
`src/providers.rs:702-719`。无 body。成功 **200** `{"ok":true}`。
删除后若 `default_model` 不再被任何存活 provider 的 models 列出，则一并清空并落盘。
错误：404 `unknown provider '{id}'`（用**未 trim** 的原始路径值）；500 落盘错误。

### `POST /api/providers/test`
`src/providers.rs:725-737`。请求 `ProviderTestReq`（**全字段可选**，inline overlay，**绝不落盘**）：`{id?, name?, note?, base_url?, request_format?, api_key?, models?}`。
缺省字段按 `id` 从库中取值；`id` 缺省且无库记录时合成标签 `__inline__`。

| status | body |
|---|---|
| 400 | `{"ok":false,"error":"<candidate 错误原文>"}`（如 `base_url is required`） |
| 200 | `{"ok":true,"latency_ms":123,"model_count":37}` |
| 200 | `{"ok":false,"error":"该请求格式暂不支持自动测试"}`（非 `chat_completions`） |
| 200 | `{"ok":false,"error":"该提供商未配置 api_key"}` |
| 200 | `{"ok":false,"error":"<probe 错误原文>"}`，如 `HTTP 401: {...}`、`response is not JSON (...); body head: ...` |

### `POST /api/providers/{id}/models/fetch`
`src/providers.rs:741-776`。**无 body**。

| status | body |
|---|---|
| 404 | `{"ok":false,"error":"unknown provider '{id}'"}` |
| 200 | `{"ok":true,"models":[{"id":"..."}]}`（**不含 `latency_ms`**） |
| 200 | `{"ok":false,"error":"该请求格式暂不支持自动测试"}` / `"该提供商未配置 api_key"` / probe 错误原文 |

**keyless 同源借用**：provider 自身无 key、且 `base_url` 归一化（trim + 去尾部 `/`）后等于**当前代际**的 `base_url` 时，借用引擎自己的 key（`resolve_api_key(&gen.profile)`）。借用是**请求级**：不写 `providers.json`、不出现在响应、不打日志（`src/providers.rs:523-553`、测试 `1212-1215`）。非同源无 key 仍然报 `该提供商未配置 api_key` 且不发请求。

### `POST /api/providers/default`
`src/providers.rs:781-797`。请求：`{"model":"<模型 id>"}`。

成功 **200**：**`public_view` 整体**。语义：按 model 找到 provider → 覆盖 profile 的 `model`（仅当该 provider 是 `chat_completions` 且 `base_url` 非空时才覆盖 `base_url`）→ 用 provider 自己的 key（**不借用引擎 key**）compose → 持久化 `default_model` → `swap_gen`。保证：**compose 失败绝不落盘，落盘失败绝不 swap**（`src/providers.rs:620-622`）。

| status | body.error |
|---|---|
| 400 | `model must not be empty` |
| 409 | `a turn is running; provider default applies between turns` |
| 500 | compose 错误原文 / `set_default_model` 落盘错误 |

未知 model id 也照切照存（自定义模型直通）。

---

## 8. 提示词

> 两个注册表文件：全局 `prompts.json`（`CELESTEA_PROMPTS_FILE` 可覆盖）+ 每工作区 `<ws-path>/.celestea-prompts.json`。`workspace` 缺省或空白 = 全局。未知工作区 → 404 `unknown workspace '{name}'`。

### `GET /api/prompts?workspace=<可选>`
`src/prompts.rs:714-722`。恒 **200**：

```json
{
  "ok":true,"scope":"global"|"workspace","workspace":null|"<name>",
  "global_file":"<prompts.json 路径>",
  "sections":[{"id","name","template","order","source":"builtin"|"global"|"workspace"}],
  "prompts":[{"id","name","section_overrides":{},"is_default":false,"scope":"global"|"workspace","shadowed":false}],
  "default_prompt":{"id":"...","scope":"global"}|null,
  "active_prompt":"<活动会话绑定的 prompt id>"|null
}
```
`sections` 按 `(order, id)` 升序；同名工作区 prompt 会让全局条目 `shadowed:true`；`active_prompt` 解析链：活动会话 `session.json` 的 `prompt` → workspace `default_prompt` → global `default_prompt`。

### `POST /api/prompts`（upsert）
`src/prompts.rs:743-807`。请求 `PromptUpsertReq`：
```json
{"workspace":"<可选，缺省=global>","id":"<1-128 字符 [A-Za-z0-9._-]>","name":"<显示名>",
 "section_overrides":{"<section id>":"<模板>"},"is_default":true|false}
```
成功 **200**：`{"ok":true,"id":"<id>","scope":"global"|"workspace","hot_applied":true}`。
语义：按 `id` 就地替换否则新增；`is_default` 缺省时保留旧值（新建为 false）；`true` 会把同 scope 其他 prompt 的 `is_default` 清为 false。

| status | body.error |
|---|---|
| 400 | `prompt id must be 1-128 chars of [A-Za-z0-9._-]` |
| 400 | `section '{section_id}': {e}`，其中 `{e} ∈` `template exceeds the 8192 byte cap ({n} bytes)` / `undefined prompt variable '{{name}}'` / `unclosed '{{' in template` |
| 404 | `unknown workspace '{name}'` |
| 409 | `turn in progress; prompt applies between turns` |
| 500 | 落盘错误原文 / `compose failed: {e}`（**compose 失败会把旧文件写回**） |

### `POST /api/prompts/{id}/delete`
`src/prompts.rs:817-844`。请求：`{"workspace":"<可选>"}`（body 是必需提取器，字段全可选）。
成功 **200**：`{"ok":true,"scope":"global"|"workspace","hot_applied":true}`。
若 `default_prompt` 指向它则一并清空。错误：404 `unknown prompt '{id}'`（**未 trim** 的原始路径值）/ `unknown workspace '{name}'`；409 / 500 同上。

### `POST /api/prompts/{id}/default`
`src/prompts.rs:848-875`。请求：`{"workspace":"<可选>"}`。
成功 **200**：`{"ok":true,"default_prompt":"<id>","scope":"...","hot_applied":true}`；同 scope 其他 prompt 的 `is_default` 清 false。错误同 delete。

**三个写端点的公共顺序**（`persist_and_hot_apply`，`src/prompts.rs:668-708`）：**先判 409（不落盘）** → 落盘 → `compose_and_swap` → compose 失败则把旧文件写回。

---

## 9. Worker 编排

三个端点都通过引擎 `ToolRegistry` 派发真实工具，HTTP 面与 agent 工具面**不会漂移**（`src/api.rs:18-21`）。工具契约失败（`{ok:false,...}`）仍走 **200**；只有硬失败才 5xx。

### `POST /api/worker/spawn`
`src/api.rs:437-452`。请求 `SpawnReq`：`{"wid":"W264","brief":"...","title"?:...,"model"?:...,"report_to"?:...}`。
成功 **200**：`{"ok":true,"sessionId":"...","title":"...","wid":"..."}`。
`report_to` 指向 `cli-main` 时，worker 完成回执会唤醒宿主 autowake 循环（见 `docs/DEVELOPMENT.md` §2.6）。
硬失败：**502** `{"ok":false,"error":"..."}`（或带 `value`）；工具无返回值 → 500 `{"ok":false,"error":"tool returned no value"}`。

### `POST /api/worker/send`
`src/api.rs:455-465`。请求：`{"target":"<session id 或命名>","content":"..."}`。响应同 worker 工具的 `{ok,delivered,...}`。

### `GET /api/worker/status?wid=<可选>`
`src/api.rs:472-503`。恒 **200**。
- 无 `wid`：引擎聚合原样返回 `{"ok","total","by_status","workers":[...]}`。
- 带 `wid`：同样形状 + 过滤；命中不到时 `{"ok":false,"total":0,"by_status":{...},"workers":[],"wid":"...","error":"no worker W264 in registry"}`（仍是 200）。

---

## 10. 静态资源

| 路由 | 行为 |
|---|---|
| `GET /`、`GET /index.html` | 读 `frontend/dist/index.html`（`src/main.rs:741-783`） |
| `GET /assets/{*path}` | Vite 产物；`Cache-Control: no-cache` |
| `GET /favicon.ico` | 同上 |
| fallback（任意未匹配路径） | 含 `.` 的路径 404；无扩展名 = SPA 路由 → `index.html`；`/api/*` 一律 404 JSON `{"error":"not found"}` |

`frontend/dist` 不存在时返回"先构建前端"提示页（`src/main.rs:826-847`），API 端点照常可用。路径经过 `sanitize_rel` 加固（拒绝 `..` / 绝对 / 前缀组件，`src/main.rs:787-803`）。
