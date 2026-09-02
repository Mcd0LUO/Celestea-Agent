# celestea-cli (W105 / W176 / W182 / W178) — REPORT

## 一、变更（Changes）

W178 在 crates/cli/ 内落地「模型配置」：Profile 扩展 4 个可选键 + DeepSeekConfig 组装 + 模型校验。与 W182（可用性层：clap 子命令 chat/run/tools、rustyline REPL、--json、--strict）**同文件合并**于 crates/cli/src/main.rs，最终为合并态；本报告以 W178 侧视角记录模型配置层的实现与验证。

### 1. Profile 扩展（新增可选键，向后兼容）

- Profile 新增 4 字段（其余 4 键保持 W176 语义不变）：
  - `base_url: Option<String>` —— 覆盖 API base URL；**优先于 env DEEPSEEK_BASE_URL，再回退 provider 默认 https://api.deepseek.com**。
  - `reasoning_effort: Option<ReasoningEffort>` —— 仅接受 "low"/"medium"/"high"。
  - `max_output_tokens: Option<u32>` —— 输出 token 上限，非负且必须 fit u32。
  - `api_key_env: String` —— 存 API key 的环境变量名，**默认 "DEEPSEEK_API_KEY"**。
- **token 值永不进 profile**：profile 只可能携带 *环境变量名*，凭据一律从 env 读取。
- 默认值：base_url=None / reasoning_effort=None / max_output_tokens=None / api_key_env="DEEPSEEK_API_KEY"，与旧 profile（只有 4 键）完全兼容。

### 2. merge_profile_mode 扩展（纯函数，strict 分支）

- 新增 4 个解析分支（lenient：未知键忽略、类型错/非法值保留默认 → 向后兼容；strict：报错）：
  - `base_url`：须为非空字符串；
  - `reasoning_effort`：须为 "low"/"medium"/"high"（strict 下其它字符串报错并回显实际值）；
  - `max_output_tokens`：非负整数且 ≤ u32::MAX（as_u64 + u32::try_from，负数/超界 strict 报错、lenient 忽略）；
  - `api_key_env`：须为非空字符串。
- **PROFILE_KEYS 扩至 8 键**（model/system_prompt/max_steps/max_parallel_tool_calls/base_url/reasoning_effort/max_output_tokens/api_key_env），--strict 未知键拒绝自动覆盖新键（落实 W182 四节交接点）。

### 3. compose：DeepSeekConfig 组装（替换 from_env().with_model()）

- 原 `DeepSeekLlm::from_env().with_model(profile.model)` 改为显式组装：
  1. `validate_model(&profile.model)` —— **先行**校验（不依赖任何 env/网络）：调 `DeepSeekLlm::supported_models()`，模型不在目录则报错并列出支持模型（deepseek-chat, deepseek-reasoner）；
  2. `api_key = std::env::var(&profile.api_key_env)` —— 缺失时清晰报错（`environment variable 'X' is not set; set it to your DeepSeek API key (or point api_key_env at a different variable)`），token 值零落盘；
  3. `base_url = resolve_base_url(profile.base_url, env DEEPSEEK_BASE_URL)`，纯函数，profile → env → 默认 三级回退（空串视为未提供）；
  4. 组装 `DeepSeekConfig { base_url, api_key, model, reasoning_effort, max_output_tokens }` → `DeepSeekLlm::new(config)`。
- 抽出纯函数：`resolve_base_url`（base_url 三级回退）、`validate_model`（目录校验），均可单测。
- `/profile` 输出（format_profile）新增 base_url / reasoning_effort（小写）/ max_output_tokens / api_key_env 行（api_key 本身永不显示）。

### 4. 测试（W178 新增 10 个）

- 新键解析（lenient 全字段）、默认值（api_key_env=DEEPSEEK_API_KEY）、strict 接受新键、strict 拒绝错误类型（4 键逐一）、strict 拒绝未知 reasoning_effort 值、strict 拒绝负数 max_output_tokens、lenient 忽略非法新键、resolve_base_url 优先级、validate_model 接受/拒绝并列出支持模型。
- 既有测试全部保留：W176 遗留 profile 测试（字面量 ..Profile::default() 适配新字段）+ W182 可用性层测试。

## 二、验证（Verification）

- `cargo build -p celestea-cli` — 通过（exit 0，**无警告**）。
- `cargo test -p celestea-cli` — 全绿：**44 passed / 0 failed**（W176 遗留 + W182 + W178 新增 10）。
- 运行时冒烟（exit code / stderr 语义）：
  - 无 key（profile 缺省 api_key_env=DEEPSEEK_API_KEY）→ exit 1，stderr 报 environment variable 'DEEPSEEK_API_KEY' is not set …；
  - profile 指定 api_key_env="MY_CUSTOM_KEY" + 该 env 缺 → exit 1 报 'MY_CUSTOM_KEY' is not set；设置后进入 API 调用（fake key → 401 证明 DeepSeekLlm::new(config) 组装正确、请求已发出）；
  - 未知模型 {"model":"gpt-4o"}（无 key 也先报模型错误）→ exit 1：model 'gpt-4o' is not supported; supported models: deepseek-chat, deepseek-reasoner；
  - --strict + 新键全量 profile（crates/cli/profile.example.json）→ 通过 strict 校验并进入 compose/API 调用（新键不再被判未知键）；
  - --strict + {"base_url":123} → exit 1：profile field 'base_url' must be a string, got number；
  - `tools` 子命令（不经 LLM）→ exit 0 列 4 个内置工具。
- 红线自查：
  - 改动文件仅 crates/cli/：src/main.rs、profile.example.json、REPORT.md（Cargo.toml 本轮未动）✓
  - 未触碰 crates/core、crates/llm、crates/session、crates/tools、crates/agent-loop、root Cargo.toml、ARCHITECTURE.md、其它 crate ✓
  - 未运行 cargo add / cargo remove；未新增依赖 ✓
  - 未做 git commit / 任何 git 写操作 ✓
  - 构建前查负载（uptime 1 分钟 ≈ 0.6–0.8 < 20）；只 build -p celestea-cli ✓
  - 凭据零落盘：token 值未写入任何文件/注释/报告 ✓
  - 文件属主 celestea:celesdev ✓（main.rs/profile.example.json/REPORT.md 均确认）

## 三、回滚（Rollback）

变更全部集中在 crates/cli/（src/main.rs、profile.example.json、REPORT.md），回滚：

    git -C /src/celestea_harness checkout -- crates/cli/

即恢复到基线（含 W176/W182 合并态；W178 模型配置层一并回退，需重新落地）。若只想回退模型层而保留 W182 可用性层，可手工撤销 compose/merge/Profile 的 W178 段。

## 四、遗留（Remaining / Follow-up）

- **W178 已落地**：Profile 8 键 + DeepSeekConfig 组装 + 模型目录校验 + 测试，与 W182 合并态无冲突（双方均未覆盖对方逻辑，本轮验证 44 测试全绿）。
- 后续若再增模型键，需同步并入 PROFILE_KEYS 与 merge_profile_mode 类型分支（W182 四节交接点已闭合）。
- --json 流式抑制为 best-effort（dup/dup2 失败则不抑制）；彻底解耦属 W180 P1#5（agent-loop 注入 StreamSink），超本 crate 范围，未越界改动。
- clap 用法错误 exit 2 与 turn 错误同码不同义；如需区分可后续 try_parse 自映射。
- reasoning_effort 语义：由 DeepSeek 服务端对 deepseek-reasoner 生效；本层仅透传 profile 值，不校验「模型是否支持推理」（能力表 ModelInfo.supports_reasoning 已在 llm 目录中，可作为后续增强）。

## 五、W189 补充：compose 接入 LLM adapter 注册表

### 变更
- compose 改为「注册 deepseek 到 LlmRegistry → resolve 使用」：
  deepseek_registry(DeepSeekLlm::new(config))，再 resolve("deepseek")。
- Context 同时 provide 两个 seam（向后兼容）：
  - LlmService（单 adapter 直读，agent-loop 等消费方不变）；
  - LlmRegistryService（扩展：按名路由的多 provider 注册表）。
- 新增测试 compose_registers_deepseek_and_keeps_llm_service（自定义 api_key_env，
  断言 registry 含 deepseek、resolve 命中、LlmService 仍可解析）。

### 验证
- cargo build -p celestea-cli / cargo test -p celestea-cli 全绿

### 回滚
- git checkout crates/cli

### 遗留
- Profile 目前仍单模型；后续可在 profile 引入 provider 选择键并经 LlmRegistry
  按名路由。

## 六、W192 补充：TOML 配置 + .env + api_key_file + cargo install

### 变更
- **配置加载升级为「TOML 优先、JSON 回退、缺省默认」**：
  - 新增 `load_profile_file(path, strict)`：按扩展名自动识别格式 —— `.toml` 走 toml crate 解析（`toml_to_json` 把 toml::Value 转成 merge 消费的 JSON 形状，整数/字符串/布尔 1:1 映射），其余按 JSON；文件不存在返回 `Ok(None)`。
  - 新增 `resolve_profile(explicit, strict, primary, fallback)`：`--profile <path>` 显式指定（文件必须存在）；否则自动发现 `celestea.toml` → `profile.json` → 默认。三条路径共用同一 `merge_profile_mode`（9 键 + `--strict` 未知键/错类型报错）。
  - clap `--profile` 改为 `Option<PathBuf>`（默认 None = 自动发现），帮助文本同步更新。
- **Profile 新增第 9 键 `api_key_file: Option<String>`**；`PROFILE_KEYS` 扩至 9；merge 分支 + `format_profile` 输出同步。
- **API key 三路径（优先级）**：env[api_key_env]（非空）> api_key_file（trim 后内容）> 报错；抽成 `resolve_api_key` 纯函数，`compose` 改用它（key 值永不落盘/打日志）。
- **启动时 `load_dotenv()`**：dotenvy 加载 `.env`（存在才加载，失败静默），`DEEPSEEK_API_KEY` 可写进 `.env` 免 export。
- 新增 `crates/cli/celestea.toml.example`（9 键带注释 TOML 模板）；**保留** `profile.example.json`（JSON 回退仍支持，JSON 示例继续有效，双格式示例并存）。
- 根 README.md 配置节更新：TOML 优先 + JSON 回退、API key 三路径（env > api_key_file > 报错）、`.env` 自动加载、配置键表扩至 9 键。

### 验证
- `cargo build -p celestea-cli` 通过，无本 crate 警告。
- `cargo test -p celestea-cli`：**58 passed / 0 failed**（W176/W178/W182/W189 遗留 44 + W192 新增 14）。
- W192 新增 14 测试覆盖：TOML 解析与类型映射、TOML 优先于 JSON、JSON 回退、两者皆缺默认、非法 TOML、TOML strict 未知键、env 优先于 api_key_file、api_key_file trim、缺 key 报错、缺 key 文件报错、strict 接受/拒绝 api_key_file、.env 加载与缺失静默。
- 运行时冒烟：
  - `tools` 子命令 exit 0；
  - 仅 `celestea.toml` + api_key_file（无 env）→ 通过 key 解析进入 LLM 调用（未报 API key not found）；
  - 仅 `profile.json` + env key → 自动回退 JSON、env 生效。
- `cargo install --path crates/cli` 成功装出 `/opt/cargo/bin/celestea`（release），`--version` 0.1.0、`tools` 正常。
- 红线自查：
  - 改动文件仅 crates/cli/（src/main.rs、celestea.toml.example、REPORT.md）+ 根 README.md 用法/配置节（红线允许）；未触碰其它 crate、root Cargo.toml、ARCHITECTURE.md ✓
  - 未运行 cargo add/remove；toml/dotenvy 为架构师已 pin 的 workspace 依赖 ✓
  - 未做 git 写操作 ✓
  - 构建前查负载（uptime 1 分钟 < 1）✓
  - 凭据零落盘：key 值仅测试假值，未写入任何文件/示例/报告 ✓
  - 文件属主 celestea:celesdev ✓

### 回滚

    git -C /src/celestea_harness checkout -- crates/cli/ README.md

注意：README.md 及 core/llm/agent-loop 存在并行 worker 改动（W190/W191 类 thinking 支持），回滚 README 前需与协调方确认，勿覆盖并行工作。

### 遗留
- api_key_file 内容含尾随换行会被 trim（符合预期）；文件读取失败（如权限/不存在）硬报错并含路径。
- `.env` 加载仅限启动时当前目录，不递归查找父目录。
- `--profile` 显式指定时不再自动回退（显式路径必须存在），语义更清晰。


## W194: 富渲染 + 美中断（crossterm）+ 身份

### 变更
- **输出 sink 解耦落地**：Env 持 `config` + `renderer: Option<rich::RichRenderer>`，
  `Env::make_loop(cancel)` 按需以 with_cancel_sink/with_cancel/with_sink/new 构造每轮
  loop；cli 不再依赖 agent-loop 直接 print。
- **富渲染（mod rich，crossterm）**：仅交互 chat / 非 json run 且 stdout 为 TTY 时启用。
  - 流式 markdown（pulldown-cmark 按行增量渲染）：ATX 标题（1/2 级青/蓝粗体）、
    粗体/斜体/行内代码/删除线、无序/有序列表、引用块、表格（表头加粗 + 分隔行淡色）。
  - 代码块：fenced 代码跨行累积，闭合时 syntect 高亮（24-bit true color，一次性
    OnceLock 建 SyntaxSet + ThemeSet）；无高亮器时淡色兜底。
  - Thinking 块：淡色 `[thinking] ` 前缀 + 缩进（流式按行输出）。
  - 工具卡片：ToolCall → `⚙ name [id] 运行中…`；ToolResult 用 ToolOutput.render/value
    渲染带状态卡片（Allow=绿/成功、error=红、deny/ask=黄）。
- **美中断（Ctrl-C）**：run_turn_interruptible 首按 Ctrl-C → watch::Sender →
  with_cancel_sink 优雅取消；二次按 Ctrl-C 强退。取消后 flush 半截输出、crossterm 还原
  终端（disable_raw_mode + 光标归位 + 清屏至行尾）、打印 `⏹ 已中断`、回到 REPL 提示符；
  one-shot 退出码 130（ExitKind::Interrupted = 128+SIGINT）。
- **身份（D）**：Profile::default().system_prompt 改为与 core 一致的
  "You are celestea, an AI agent. You are concise, accurate and direct."；
  celestea.toml.example 同步。
- --json 路径不变：rich = false + stdout_redirect 静音，输出仍为纯结构化 JSON。

### 验证
- cargo build -p celestea-cli：通过，无警告。
- cargo test -p celestea-cli：70 passed / 0 failed（新增 12：rich::tests 9 个 +
  interrupted_exit_code_is_130 / default_profile_uses_celestea_identity /
  compose_carries_identity_into_loop_config，以及 exit_kind_mapping 扩展 130）。
- 全仓 cargo build --workspace && cargo test --workspace：通过。

### 回滚
- git -C /src/celestea_harness checkout -- crates/cli/

### 遗留
- 流式 markdown 为「行粒度」增量（完整行即时渲染、未完成行尾端缓冲至 finish/flush）；
  全行重绘（光标保存/恢复重画缓冲）可作为后续增强以获得逐字渲染体验。
- Thinking「可折叠」暂以淡色前缀 + 缩进呈现（满足最低要求）；真正的折叠/展开需键盘交互，
  与 rustyline 冲突，留待后续。
- 表格为朴素单元格渲染（未做跨行列宽对齐）；分隔行仅作语义标记。
- setext 标题（===/---）未支持，仅 ATX 标题（LLM 输出以 ATX 为主）。

## W195: chat 全屏 ratatui TUI（Claude Code 观感）

### 变更
- 新增 mod tui（crates/cli/src/main.rs）：ratatui 0.30.2 + crossterm 0.29 全屏 TUI 聊天。
  - 布局：左「对话流」流式 markdown（复用 rich 的 StreamingMarkdown 增量渲染，把其 ANSI 输出经
    ansi_line_to_spans 转成 ratatui span）+ 右「工具/状态」面板（ToolCard 实时状态：运行中→成功/
    错误/deny）+ 底部状态栏（model/steps/streaming/已中断）+ 底部输入框。
  - 流式增量：事件 sink 把 LoopEvent(Text/Thinking/ToolCall/ToolResult/Done) 应用到共享
    TuiState(Arc+Mutex)，MessageBuf.push_stream/finish_stream 复用 rich 的 StreamingMarkdown，
    按帧节流重绘（should_redraw 20ms 门限）避免刷太猛。
  - 滚动：对话流自动跟随尾部（除非用户上翻/中断）；输入为自绘单行框 + Up/Down 历史 + Esc 清空；
    /tools /model /clear /profile /exit 命令沿用。
- chat 子命令分派（tui::chat_mode）：stdin+stdout 均 TTY → 全屏 TUI；stdin TTY 但 stdout 非 TTY →
  沿用 P1 rustyline REPL；stdin 非 TTY（管道/重定向）→ 沿用 P1 read-all-stdin 一次性。run --json 与
  tools 完全不变（rich renderer 仅在没有进入 TUI 时安装，避免与备用屏幕冲突）。
- 中断：TUI 内 Ctrl-C（raw 模式下是键事件而非 SIGINT）→ 第一次触发 with_cancel 优雅取消 + 状态栏显示
  「已中断」+ 回到输入框；第二次 Ctrl-C 还原终端退出 TUI（Interrupted=130）。run_tui_turn 把双 Ctrl-C
  语义织入 select! 键流。
- 复用打通：把 rich 的 StreamingMarkdown(new/feed/finish)、Highlighter、highlighter()、
  render_thinking_line、render_tool_call_card、render_tool_result_card 从私有改为 pub(crate)。

### 验证
- cargo build --workspace：通过，无警告。
- cargo test -p celestea-cli：77 passed / 0 failed（新增 7：split_ansi_lines、
  message_buf_incremental_and_finish、tool_card_resolve_transitions、chat_mode_dispatches、
  split_widths_reserves、throttle_redraw_gate、ansi_to_spans_maps_styles）。
- 全仓 cargo test --workspace：各 crate 全绿（cli 77），无 FAILED。
- 非 TTY / --json 路径不改逻辑：OneShot/Repl 分支仍走既有 run_one_shot/run_repl，向后兼容。

### 回滚
- git -C /src/celestea_harness checkout -- crates/cli/
  （W195 的 mod tui、分发改写、rich 可见性改动一并回退；其余 W176/W178/W182/W192/W194 合并态回退到基线）。

### 遗留
- TUI 输入为单行；多行输入/粘贴编辑未做（与 Claude Code 仍有差距），可后续加编辑器。
- 交互式 UI 无法在无 TTY 自动化环境做端到端人工冒烟（已用单测覆盖纯函数与分派逻辑）。
- 事件触发重绘 + 20ms 节流为朴素实现；若需更低 CPU 可改用事件驱动的脏区间重绘。

