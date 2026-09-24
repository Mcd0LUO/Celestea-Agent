# Celestea Studio · 数据文件与格式

> 状态：**当前**。共享数据文件的 schema 与落点；字段真源是 `../contracts/data-files/`。页内提到的「并入前路径」以当时为准。

> 📦 **W781（2026-09-14）**：旧前端仓 Celestea-Studio（并入前位于同级的 `celestea_studio` 目录）已全量并入本仓，前端 = `apps/web/`，
> 运行数据迁到 `/var/lib/celestea-agent/`。本页所述路径以**并入前**的旧两仓布局为准（历史参考），
> 现役口径见 [`archive/README-frontend.md`](./archive/README-frontend.md) 与 [`../README.md`](../README.md)。

> 🏠 **W880（2026-09-18）：CELESTEA_HOME 数据根**。workspace 里的 celestea 产物（会话目录 / 归档 / 回收站 / prompts / run_code 临时程序）已全部移出工作区，落到跨平台数据根：
> 1. `$CELESTEA_HOME`（生产 systemd 固定 `/var/lib/celestea-agent`，FHS 的 `/var/lib/<service>`）；
> 2. `$XDG_DATA_HOME/celestea`（Linux；回应 claude-code#1455 一类 XDG 诉求）；
> 3. `~/.celestea`（Linux/macOS 默认；同类 agent CLI 的事实标准）；
> 4. `%USERPROFILE%\.celestea`（Windows 默认）。
>
> 布局：`<home>/workspaces/<workspace-basename>/{sessions,archive,trash,run-code}/prompts.json`。会话 id 仍是 `<workspace-basename>/<session-dir>`。
> 旧布局 `<ws>/.celestea/sessions`（W877 过渡）与 `<ws>/<session-dir>`、`<ws>/.celestea-archived`、`<ws>/.celestea-trash`、`<ws>/.celestea-prompts.json` 继续**只读兼容**（canonical 优先）。解析器 `packages/core/src/celestea-home.ts`，存储侧 `apps/studio/src/store/celestea-home.ts`。


> 权威来源：`src/workspaces.rs` / `src/providers.rs` / `src/prompts.rs` / `src/compact.rs` / `src/api.rs` 的实际读写代码。
> 所有 schema 都是 serde 派生结构的真实字段（含 `#[serde(default)]` 与 `Option` 语义）。

## 0. 总览

| 文件 | 默认路径 | 环境变量覆盖 | 权限 | 写入方 | 读取方 |
|---|---|---|---|---|---|
| `workspaces.json` | `<cwd>/workspaces.json` | `CELESTEA_WORKSPACES_FILE` | 普通（无 key） | `WorkspaceRegistry::persist_locked` | 启动 / 所有会话端点 |
| `providers.json` | `<cwd>/providers.json` | `CELESTEA_PROVIDERS_FILE` | **0600** | `ProvidersStore::save` | 启动 / 所有 provider 端点 |
| `prompts.json` | `<cwd>/prompts.json` | `CELESTEA_PROMPTS_FILE` | 普通 | `persist_prompt_file` | compose 时装配 / prompts 端点 |
| `<CELESTEA_HOME>/workspaces/<ws>/prompts.json` | 每个工作区容器 | — | 普通 | 同上（workspace scope） | compose 时装配 / prompts 端点 |
| `celestea.toml` | `<cwd>/celestea.toml` | —（引擎解析链） | 普通，**不含 key** | 人 | 启动 `resolve_profile` |
| 会话目录 | `<CELESTEA_HOME>/workspaces/<ws>/sessions/<session>/`（legacy `<workspace path>/<session>/`） | `CELESTEA_SESSION_DIR`（指向**会话目录**） | 普通 | 引擎 `PersistentSessionLog` + Studio | 引擎回放 / messages 端点 |
| `cli-main.jsonl` | 会话目录内 | — | 普通 | 引擎（每事件一行） | 引擎回放 / messages / compact |
| `cli-main.jsonl.<n>` | 会话目录内（`n` = 1,2,…） | — | 普通 | 引擎**轮转**（写入前 size ≥ 16 MiB） | 引擎回放 / messages（**跨段**读取） |
| `session.json` | 会话目录内（可选） | — | 普通 | `POST /api/sessions` | activate / compact / prompts 装配 |
| `cli-main.jsonl.precompact` | 会话目录内 | — | 普通 | `compact::rewrite_atomic` | 人工回滚 |

**会话日志的轮转（W1503）**：`cli-main.jsonl` 达到 16 MiB 时，**下一次写入前**把它整体改名成
`cli-main.jsonl.1`（再满则是 `.2`，**代际递增、从不覆盖旧段** —— 会话日志是模型可见历史的
来源，替换旧段会删历史，这是它与 `USAGE_LEDGER_MAX_BYTES` 那个审计日志先例的关键差别）。
所有读取路径（引擎 `events()` / `deriveMessages()` / `open()`、Studio `messages()`）都按
`[.1, .2, …, 当前段]` 顺序**跨段**拼接，因此投影与从未轮转**逐字节等价**。
`compact` 的 `.precompact` 备份与轮转**无关**（前者是压缩备份，后者是容量分段）。

`.gitignore` 排除：`providers.json`、`workspaces.json`、`sessions/`、`frontend/dist/`、`target/`、`*.log`、`.env`。

---

## 1. `workspaces.json`（v2）

### 1.1 schema（`src/workspaces.rs:122-140`）

```jsonc
{
  "workspaces": [ { "path": "/abs/registered/dir" } ],   // #[serde(default)] -> []
  "active_session": "<workspace>/<session>"  // #[serde(default)] -> null
}
```

- **没有 `version` 字段**。"v2" 只是命名约定（`src/workspaces.rs:1-14`）：工作区 key = 注册路径的 `Path::file_name()`（文件夹 basename），**名称从不存储**；v1 的 `name` 字段在加载时被读出用作映射后丢弃、不再写回（`src/workspaces.rs:363-376`）。
- 未知字段不报错（没有 `deny_unknown_fields`）。
- **没有归档状态字段**：归档是纯文件系统移动，registry 不记录；归档后的会话落在 `<CELESTEA_HOME>/workspaces/<ws>/archive/`（W880；legacy `.celestea-archived/` 只读兼容），默认扫描不列出 → 对 `GET /api/sessions` 完全不可见（`?archived=1` 才列）。
- 写入：`to_string_pretty` → `<path>.json.tmp` → `rename` 原子替换（`src/workspaces.rs:284-293`）。**没有 fsync**（与 `compact` 的日志写入不同级，见 §5）。

### 1.2 session id 形态

```
"<workspace-basename>/<session-dir-name>"
```
规则（`parse_session_id`，`src/workspaces.rs:594-604`）：恰好一个 `/`，两侧非空，session 段不含 `/`。
解析（`resolve_session_dir`，`src/workspaces.rs:611-640`）：workspace 段是**注册表查找**（绝不是路径拼接）；session 段经 `sanitize_component`（分隔符/控制字符/空白 → `_`，**CJK 保留**），并拒绝空 / `.` / `..` / `.` 开头；最后校验 `dir.parent() == ws_path`（双保险防穿越）。
另有 `"worker:<sid>"` 形态，只在 `GET /api/sessions/{id}/messages` 生效（引擎内存 SessionRegistry）。

### 1.3 磁盘布局

```
<workspace path>/                     注册的任意用户目录
├── <session-dir>/                    会话 = 直接子目录且含 cli-main.jsonl
│   ├── cli-main.jsonl                引擎 PersistentSessionLog 回放文件
│   ├── session.json                  可选：{"model":"<id>","prompt":"<prompt id>"}
│   └── cli-main.jsonl.precompact     可选：/compact 的单副本备份
├── <session-dir-2>/                  （legacy 布局；新会话不再落在这里）
├── .celestea/sessions/<name>/        W877 过渡布局（只读兼容）
├── .celestea-archived/<name>/        归档（legacy；只读兼容）
└── .celestea-trash/<name>-<ts>/      回收站（legacy；只读兼容）
```

W880 之后工作区**根下不再新建任何 celestea 产物**，canonical 布局为：

```
<CELESTEA_HOME>/workspaces/<workspace-basename>/
├── sessions/<name>/                 活跃会话
├── archive/<name>/                  归档（保持原名，可 unarchive）
├── trash/<name>-<ts>/               回收站（加时间戳，**不可再按 id 寻址**）
├── prompts.json                     工作区级段注册表
└── run-code/                        run_code 临时程序（宿主机写、bwrap 只读挂载）
```
- dot 前缀目录永不扫描（`scan_session_dirs`，`src/workspaces.rs:666-692`）。
- `cli-main` 只是引擎内部文件名（`SESSION_FILE`），**没有特权**；唯一限制是活动会话不能被归档/删除。
- `sessions/<workspace>/<session>/cli-main.jsonl` 这种层级只在**默认工作区**（`<cwd>/sessions`）+ legacy 迁移后出现；注册工作区的路径可以是任意目录。

### 1.4 加载 / 迁移 / 损坏处理（`load_registry`，`src/workspaces.rs:350-422`）

| 情况 | 行为 |
|---|---|
| 文件存在且可解析 | 归一化（见下）后加载；有变化才重写文件 |
| 文件缺失 | 触发 **legacy 迁移**：`root/*.jsonl` → `root/<stem>/cli-main.jsonl`；`root/<ws>/*.jsonl` → `root/<ws>/<stem>/cli-main.jsonl`（已叫 `cli-main.jsonl` 的跳过；dot-dir 从不迁移）。迁移前先把所有 `*.jsonl` 备份到 `root/.backup-<unix-secs>/`；每步先查目标是否存在 → **幂等**；单文件失败只打印不中断启动。然后创建 `{"workspaces":[{"path":"<cwd>/sessions"}],"active_session":"sessions/cli-main"}` |
| JSON 畸形 | **硬错误** `workspaces.json '<path>' is malformed: {e}`，main 打印后 `exit(1)`；**绝不覆盖**不可读的注册表 |
| 两个工作区 basename 相同 | 硬错误 `two workspaces resolve to the same folder name '{base}' (workspace keys must be unique basenames; rename one folder)` |
| 其它读错误 | 硬错误，同样 `exit(1)` |

v1→v2 归一化（`normalize_registry`，`src/workspaces.rs:303-342`）：按 basename 去重；`active_session` 的 workspace 段按 v1 name→basename 映射重写；幂等。

### 1.5 `session.json`

```jsonc
{ "model": "deepseek-v4-flash-0731", "prompt": "my-prompt-id" }   // 字段可选，只写出现过的
```
- **唯一写入点**：`POST /api/sessions` 且 `model` / `prompt` 至少一个非空（`src/workspaces.rs:1206-1218`）；两者都空则**不创建**该文件。
- 读取：`get_sessions` 的 `model` 字段；`activate` 时热应用（非法值 → 400 `invalid session model: {e}`）；`compact` 选摘要模型（缺省用当前代际 model）；prompts 装配选会话级 prompt 绑定。
- 缺失/损坏 → `None`（容忍），不阻断。
- 随会话搬移：branch 会复制它；rename 因整目录 rename 自然跟随。
- **注意**：`POST /api/config` 改模型**不会**回写 `session.json`——会话级模型只在创建时决定（改文件是唯一后续手段）。

---

## 2. `providers.json`

### 2.1 schema（`src/providers.rs:52-86`）

```jsonc
{
  "providers": [
    {
      "id": "celestea",                  // 必需；身份
      "name": "Celestea",                // 必需；仅显示名
      "note": "",                        // #[serde(default)] -> ""
      "base_url": "http://127.0.0.1:3001/v1",  // 必需
      "request_format": "chat_completions",    // 必需；chat_completions|responses|anthropic_messages
      "api_key": "<明文密钥，仅本文件可见>",   // Option<String>，default -> None
      "models": [
        {
          "id": "deepseek-v4-pro",       // 必需
          "name": "DeepSeek V4 Pro",     // 必需
          "reasoning_efforts": ["low","high","max"],  // default -> []，**自由字符串、无枚举校验**
          "context_window": 1000000,     // Option<u64>
          "max_output_tokens": 128000    // Option<u64>
        }
      ]
    }
  ],
  "default_model": "deepseek-v4-pro"     // Option<String>，default -> None
}
```
- **没有 `version` 字段、没有任何迁移逻辑**；`id/name/base_url/request_format` 无 `serde(default)` → 缺字段即反序列化失败。
- `ProviderModel` **故意不 derive `Debug`**，防止带 key 的类型被打印（`src/providers.rs:51`）。
- `request_format`：只有 `chat_completions` 能真正跑（引擎适配器就绪）；`responses` / `anthropic_messages` 仅存储 + 展示，探测时返回"暂不支持自动测试"（`src/providers.rs:10-13`、`39-46`）。

### 2.2 落盘与权限（`src/providers.rs:189-212`）

pretty JSON → `providers.json.tmp` → `OpenOptions` 带 `mode(0o600)` → `write_all` + `sync_all`（忽略错误）→ `rename`。
**每次 `save()` 都重设 0600**；但 `open()` 不会给已存在的文件补 chmod（若文件权限被外部改宽，要等下一次写才恢复）。
`open()` 契约：文件不存在 → 空 store；**JSON 畸形 → 硬错误**（绝不以空 store 覆盖不可读文件，`src/providers.rs:98-113`）。

### 2.3 `public_view`：外发字段（`src/providers.rs:219-241`）

| 字段 | 说明 |
|---|---|
| `id` / `name` / `note` / `base_url` / `request_format` | 原样 |
| `models[].id` / `name` / `reasoning_efforts` / `context_window` / `max_output_tokens` | 原样 |
| `is_default` | `default_model` 命中该 provider 的任一 model |
| `has_key` | `api_key` 存在且非空字符串（**未 trim**） |
| **`api_key`** | **键不存在**（不是置空）。测试断言响应文本既不含密钥也不含 `"api_key"` |

### 2.4 更新语义（`provider_from_req`，`src/providers.rs:341-391`）

| 字段 | 缺省时行为 |
|---|---|
| `api_key` | **保留库中旧 key**（唯一"缺省保留"） |
| `models` | **清空为 `[]`** |
| `note` | **清空为 `""`** |
| `request_format` | **重置为 `chat_completions`**（会把已存的 `anthropic_messages` 悄悄改回） |
| `name` | 回退为 `id` |

> 源码注释（`src/providers.rs:338-340`）写的是"每个出现的字段生效"，与实现不符——以本表为准。前端每次都发全字段，所以日常不会撞上；用 curl 做部分更新会。

### 2.5 `default_model` 与启动覆盖（`apply_startup_default`，`src/providers.rs:594-616`）

- 启动时若 `default_model` 非空：覆盖 `celestea.toml` 的 `profile.model`；若某 provider 的 models 列出该 id 且是 `chat_completions`，还覆盖 `profile.base_url` 并把该 provider 的 key 注入 `env[profile.api_key_env]`（仅内存）。
- 即使没有 provider 列出该 id，也照样覆盖模型名（自定义模型直通）。
- 运行期改默认走 `POST /api/providers/default`（compose → 落盘 → swap，失败互不牵连）。

### 2.6 数值字段

后端 `context_window` / `max_output_tokens` 只接受 **JSON number**（`Option<u64>`）。前端的 `k`/`m` 后缀（`1m = 1000000`、`1.5m`、`128k`）是**前端输入糖**（`frontend/src/ui/providers.ts:285-296` 的 `numOrNull`），不会出现在请求体里；用 curl 传 `"1k"` 会被 serde 拒绝。

---

## 3. `prompts.json`（段注册表）

### 3.1 文件与 schema（`src/prompts.rs:126-165`）

两个注册表：
- **全局**：`prompts.json`（`CELESTEA_PROMPTS_FILE` 覆盖，否则相对进程 cwd）；
- **工作区**：`<CELESTEA_HOME>/workspaces/<ws>/prompts.json`（legacy `<workspace path>/.celestea/prompts.json` 与 `<workspace path>/.celestea-prompts.json` 只读兼容）。

```jsonc
{
  "sections": [
    { "id": "identity", "name": "Identity", "template": "...", "order": 100 }  // 全部必需
  ],
  "prompts": [
    { "id": "my-prompt", "name": "My Prompt",
      "section_overrides": { "identity": "新的段模板 {{model}}" },  // default -> {}
      "is_default": false }                                        // default -> false
  ],
  "default_prompt": "my-prompt"                                    // Option<String>
}
```
- **新文件，无迁移**（`src/prompts.rs:14`）。
- 读取容错：缺失/不可读 → 默认空；**畸形 → 打警告 + 默认空**（注册表绝不能拖垮 compose/UI，`src/prompts.rs:167-183`）。
- 落盘：pretty JSON + `.json.tmp` + rename（`src/prompts.rs:186-194`）；**不设 0600**（无密钥）。

### 3.2 四级层级

| 层级 | 载体 | 说明 |
|---|---|---|
| `builtin` | 代码常量 `BUILTIN_SECTIONS`（10 段：`identity` / `environment` / `tool_access` / `paths` / `shell` / `network` / `delegation` / `planning` / `output` / `context`，order 100..1000） | 只有 builtin 段有静态 `name`；`default_system_prompt()` = 按数组序 `"\n\n"` 拼接 |
| `global` | `prompts.json` 的 `sections` / `prompts` | 覆盖 builtin 同名段 |
| `workspace` | `<CELESTEA_HOME>/workspaces/<ws>/prompts.json` | 覆盖 global 同名段 |
| `session` | 会话目录 `session.json` 的 `"prompt"` 字段（**绑定一个 prompt id，不是独立的段层**） | 其 `section_overrides` 最后覆盖 |

装配顺序（`effective_sections`，`src/prompts.rs:422-456`）：`builtin` → `global.sections` → `ws.sections` → bound prompt 的 `section_overrides`。
- 已存在的段：**只换 template，保留原 order**；新增的段 order = `ORDER_FALLBACK = 2000`。
- 排序 `(order, id)` 升序；空/纯空白 template 丢弃；渲染失败时**已知段回退 builtin 模板**、用户新增段丢弃，绝不 panic。
- 最后 `"\n\n"` 连接并截断到 `PROMPT_MAX_LEN = 8192` 字节（落在字符边界）。

选择链（`resolve_prompt`，`src/prompts.rs:393-418`）：会话绑定 id（先 ws 后 global）→ 找不到就**直接返回 None、不回退任何 default**；无绑定 → `ws.default_prompt` → `global.default_prompt` → None（即 builtin base）。
注意 `is_default` 字段**不参与解析链**，只由 handler 维护并回显；真正决定默认的是 `default_prompt`。

### 3.3 `{{var}}` 插值（`interpolate`，`src/prompts.rs:294-321`）

- 语法：`{{name}}`，名称内部 `trim()`；**无别名、无转义**（字面 `{{` 无法表达）。
- 未闭合 `{{` → `unclosed '{{' in template`；未知变量 → `undefined prompt variable '{{name}}'`。
- 可用变量（`PROMPT_VARS`，9 个）：

| 变量 | 取值 |
|---|---|
| `model` | `profile.model` |
| `provider` | `base_url` 的 host 段（去 scheme、取首个 `/` 之前） |
| `base_url` | 当前网关 |
| `workspace` | `CELESTEA_SESSION_DIR` 的**父目录名** |
| `session` | 会话目录名 |
| `tools` | 常量工具名清单 `PROMPT_TOOLS` |
| `context_window` | `profile.context_window_tokens` |
| `max_output_tokens` | `profile.max_output_tokens`（None → 0） |
| `date` | 系统时钟 UTC 民用日期（无 chrono） |

### 3.4 校验

- `validate_prompt_id`：1-128 字符，仅 `[A-Za-z0-9._-]`。
- `validate_template`：≤8192 字节；`{{` 必须闭合；变量必须在白名单。

### 3.5 内存旁路 `user_override`

`POST /api/config` 的 `system_prompt`：非空 → 写入进程内 `USER_OVERRIDE` 槽，`build_gen` **完全绕过注册表装配**；空串 → 清空槽并回落到 `default_system_prompt()`。装配出来的提示词**永远不会**被误判为用户覆盖（只有这个槽算，`src/main.rs:384-396`）。

---

## 4. 会话日志 `cli-main.jsonl`

### 4.1 格式

引擎 v1 持久化格式：**一行一个 `SessionEvent`**，serde 内部 tag 为 `"type"`、variant 名 snake_case（参照实现 `/src/celestea_harness/crates/core/src/session_log.rs:44-85`；该仓已于 2026-09-11 删除，现行真源见 [`../contracts/session-event.schema.json`](../contracts/session-event.schema.json)）。

```jsonc
{"type":"turn_start","id":"turn-1"}
{"type":"user_message","text":"..."}
{"type":"thinking_delta","text":"..."}
{"type":"tool_call","id":"call_1","name":"read_file","args":{"path":"/tmp/x"},"parent_id":null}
{"type":"tool_result","id":"call_1","value":{"ok":true},"error":null,"parent_id":null}
{"type":"assistant_message","text":"..."}
{"type":"turn_end","id":"turn-1","outcome":"completed"}
```

解析（`parse_session_jsonl`，`src/api.rs:141-153`）：跳过空行；**遇到首个不可解析行即停止**——撕裂的尾部（写一半）永远不会被当成内容。

### 4.2 消息契约（`session_event_to_message`，`src/api.rs:94-135`）

| 事件 | 输出 JSON |
|---|---|
| `turn_start` / `turn_end` | 不输出（结构标记） |
| `user_message` | `{"role":"user","content":<text>}` |
| `assistant_message` | `{"role":"assistant","content":<text>}` |
| `thinking_delta` | `{"role":"thinking","content":<text>}` |
| `tool_call` | `{"role":"tool","kind":"call","tool_call_id":<id>,"tool_name":<name>,"tool_args":<args>}` + 可选 `"tool_parent_id"` |
| `tool_result` | `{"role":"tool","kind":"result","tool_call_id":<id>,"tool_value":<value>,"tool_error":<error>}` + 可选 `"tool_parent_id"` |

- tool 消息**没有 `content` 字段**（结构化字段是唯一真源）。
- `tool_parent_id` 用于 `run_code` 子调用分组；孤儿 `tool_result`（没有前置 `tool_call`）照常输出，映射不配对、不过滤。

### 4.3 `session.json` 与日志的关系

`cli-main.jsonl` 是引擎的**对话历史**；`session.json` 是 Studio 的**会话元数据**（模型 / 提示词绑定），引擎完全不读它。

### 4.4 `/compact` 之后的日志形态

`POST /api/sessions/{id}/compact` 成功后（`plan_compaction`，`src/compact.rs:138-169`）：

```
turn-1: turn_start / user_message("【上下文压缩】<摘要，≤20000 字符>")
        / assistant_message("上下文已压缩，以上为历史摘要。") / turn_end(completed)
turn-2 .. turn-(K+1): 最近 K=4 个完整轮，内容原样，仅 turn_start/turn_end 的 id 重编号
```
- 轮 id 用引擎原生 `turn-<n>`（`PersistentSessionLog::next_turn_number` 只认这个前缀），所以重放后新轮从 `turn-(K+2)` 起，不与磁盘撞号。
- 未闭合的尾轮与首个 `turn_start` 之前的事件**一律丢弃**。
- 阈值：完整轮数 `<= 8` 直接跳过（`COMPACT_THRESHOLD`）；即需要 ≥9 个完整轮。
- 备份：`cli-main.jsonl.precompact`（**单副本、覆盖式**），是重绑失败后唯一的人工回滚通道。

---

## 5. 落盘保证对比（重要）

| 写入 | 原子性 | fsync | 备注 |
|---|---|---|---|
| `workspaces.json` | tmp + rename | **无** | registry 变更立即持久化 |
| `providers.json` | tmp + rename + **0600** | 有（忽略错误） | 每次写重设权限 |
| `prompts.json`（global / 工作区 canonical） | tmp + rename | 无 | 无权限要求 |
| `cli-main.jsonl`（引擎写入） | 引擎 `PersistentSessionLog` 负责 | 引擎决定 | Studio 不直接写 |
| `cli-main.jsonl`（compact 重写） | 先备份 → tmp + `sync_all` → rename | **有** | 失败删 tmp |
| `session.json` | 直接 `std::fs::write`（**非原子**） | 无 | 内容极小，仅创建时写 |

---

## 6. `celestea.toml` 与引擎剖面

```toml
model = "deepseek-v4-flash-0731"
base_url = "http://127.0.0.1:3001/v1"
api_key_env = "CELESTEA_API_KEY"
```
- 解析链（引擎 `resolve_profile`，Studio 启动时调用）：`./celestea.toml` > `./profile.json` > `~/.celestea/celestea.toml` > `~/.celestea/profile.json` > 默认值。
- **key 绝不写在这个文件里**：只写 `api_key_env`（环境变量名）；key 的来源是 env → `api_key_file` → `~/.celestea` 配置。
- 启动后 `profile.max_steps` 被抬到 `MIN_STEPS = 4096`（引擎 agent loop 的 `max_steps=0` 意味着"零步"而不是"无限"，所以"无限"只能用高上限表达）。
- `providers.json` 的 `default_model` 会在首次 compose **之前**覆盖这里的 `model`（并在日志里打印一行提示，不含 key）。

---

## 7. 相关环境变量（数据文件视角）

| 变量 | 作用 |
|---|---|
| `CELESTEA_WORKSPACES_FILE` | `workspaces.json` 路径 |
| `CELESTEA_PROVIDERS_FILE` | `providers.json` 路径 |
| `CELESTEA_PROMPTS_FILE` | 全局 `prompts.json` 路径 |
| `CELESTEA_SESSION_DIR` | 引擎要回放的**会话目录**（由 activate/rename/compact/启动恢复设置） |
| `CELESTEA_API_KEY` | 引擎 key 通道（`api_key_env` 默认指向它） |
| `DEEPSEEK_BASE_URL` | `resolve_base_url` 的 env 兜底 |
| `CELESTEA_AUTOWAKE` | `0/off/false/no` 关闭 autowake |
| `STUDIO_BIND` | HTTP 绑定地址（默认 `127.0.0.1:3777`） |
| `CELESTEA_TOOL_ROOTS` | **引擎**工具读根白名单；Studio 的 `/api/fs/browse` **不读**它 |
