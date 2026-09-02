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
