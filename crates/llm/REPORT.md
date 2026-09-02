# celestea-llm (W177) — LLM 模型提供器迭代报告

## 1. 结论

本迭代把 `celestea-llm` 从「仅 from_env + with_model 的裸客户端」升级为带完整
**模型提供器**形态的适配器：新增 `DeepSeekConfig` / `ReasoningEffort` / `ModelInfo`
类型与模型目录，`build_request` 现在映射 `reasoning_effort` 并按「请求显式 >
config 默认」规则下发输出上限，`generate`/`from_env` 对模型做目录校验。所有新增
类型都放在 `crates/llm`，`celestea-core` 契约零改动（架构师决策：模型适配器是
可替换插件，其配置与能力是插件关切）。

`cargo build -p celestea-llm` 通过；`cargo test -p celestea-llm` **12/12 通过**
（原 6 项消息/工具/线格式测试全部保留并适配，新增 6 项覆盖配置构造、
reasoning_effort/max_tokens 映射、模型校验、supported_models 元数据）。

## 2. 实现

### 新增类型（全部在 crates/llm）
- `pub enum ReasoningEffort { Low, Medium, High }` — `#[serde(rename_all="lowercase")]`
  序列化为 `"low"/"medium"/"high"`；`impl From<ReasoningEffort> for
  async_openai::types::chat::ReasoningEffort` 做 Low→low / Medium→medium / High→high
  的直映射（不暴露 `minimal`/`xhigh`）。
- `pub struct ModelInfo { name, context_length, max_output_tokens, supports_reasoning }` —
  目录条目的能力元数据。
- `pub struct DeepSeekConfig { base_url, api_key, model, reasoning_effort,
  max_output_tokens }` — 插件级配置。手写 `Debug`，`api_key` 以 `<redacted>`
  显示，避免日志泄漏凭据（红线：凭据零落盘）。

### 构造与便捷路径
- `DeepSeekLlm::new(config: DeepSeekConfig) -> Self` — 显式配置构造。
- `DeepSeekLlm::from_env() -> Result<Self, LlmError>`（保留）— 读
  `DEEPSEEK_API_KEY`（必填）/ `DEEPSEEK_BASE_URL`（可选，默认
  https://api.deepseek.com），model 默认 `deepseek-chat`，并对目录做校验。
- `with_model()`（保留，back-compat）— 仍返回 `Self`，作为 ModelRequest
  未指定 model 时的兜底。

### 模型目录
- `pub fn supported_models() -> Vec<ModelInfo>`：
  - `deepseek-chat`：context_length 65_536，max_output_tokens 8_192，非推理。
  - `deepseek-reasoner`：context_length 65_536，max_output_tokens 8_192，支持推理。
- 数值经 web_search 对 DeepSeek 官方文档核准（见第 4 节出处 URL）：两模型上下文
  64K、输出上限 8K（默认 4K）；`deepseek-reasoner` 的 CoT 不占用 64K 上下文、
  max_tokens 限制的是 CoT 之后的最终回答长度。

### build_request 映射
- `reasoning_effort`：`self.reasoning_effort.map(Into::into)` 写入请求字段。
- 输出上限：`req.max_tokens.or(self.max_output_tokens)`（请求显式优先，否则用
  config 的 `max_output_tokens`）。
- 字段选择：**DeepSeek 接受 `max_tokens`，不接受 `max_completion_tokens`** —
  DeepSeek 官方 Chat Completions API 参数表只有 `max_tokens`（对 reasoner 语义为
  CoT 之后最终回答的上限，默认 4K 最大 8K；CoT 可到 32K 且不计入 64K 上下文），
  故沿用 async-openai 的 deprecated `max_tokens` 字段，在 `#[allow(deprecated)]`
  下使用。

### 模型校验
- `pub fn validate_model(&self, model: &str) -> Result<(), LlmError>` — 不在目录则
  返回 `Err(LlmError)` 并列出受支持模型。
- `generate()` 先对 effective model 校验再发请求；`from_env()` 也对默认模型校验。
- 注：`new()` 签名按 pin 为 `-> Self`（无 Result），故 Err 校验落在请求路径
  `generate()` 与 `from_env()`，调用方可先用 `validate_model` 预检。

## 3. 验证

- `cargo build -p celestea-llm` — 通过，无警告。
- `cargo test -p celestea-llm` — **12/12 通过**：
  原 6 项（user/tool-result/assistant-tool-call/tool-spec/arguments/wire-format）
  保留适配；新增 6 项：
  - `reasoning_effort_serde_and_mapping`（serde lowercase + async-openai 映射）
  - `config_construction_roundtrip`（config 构造回读字段）
  - `build_request_maps_reasoning_effort_and_max_tokens`（effort=high、config
    默认 2048 兜底、temperature）
  - `build_request_request_max_tokens_wins_over_config`（请求 128 覆盖 config 2048）
  - `model_validation_rejects_unknown_model`（`gpt-4o` 报错并列出目录）
  - `supported_models_metadata_is_sane`（非空、含两模型、output≤context、reasoner
    支持推理）

## 4. 出处与红线自查

### 模型元数据出处（web_search 核准）
- https://api-docs.deepseek.com/quick_start/pricing/ — 模型与定价、默认输出 4K /
  调大 max_tokens 支持更长输出。
- https://api-docs.deepseek.com/guides/reasoning_model/（镜像：
  https://deepseek.apidog.io/reasoning-model-deepseek-reasoner-835841m0）—
  deepseek-reasoner：上下文 64K、CoT 不计入上下文、max_tokens 默认 4K 最大 8K、
  CoT 可达 32K。
- https://api-docs.deepseek.com/api/create-chat-completion/ — max_tokens 参数语义
  （DeepSeek 用 max_tokens，不用 max_completion_tokens）。
- https://www.datastudios.org/post/deepseek-context-window-token-limits-memory-policy-and-2025-rules
  — 交叉佐证 deepseek-chat 最大输出 8K（默认 4K）、reasoner 64K 输入上限。
- https://api-docs.deepseek.com/updates/ — deepseek-chat / deepseek-reasoner 为
  长期稳定的两个模型名。

### 红线自查
- ✅ 只改 crates/llm/（src/lib.rs + REPORT.md）；未动 crates/core、root Cargo.toml、
  ARCHITECTURE.md 或其它 crate。
- ✅ 无 cargo add/remove；未改任何依赖（async-openai 0.41.3 原字段够用）。
- ✅ 无 git 写操作（未 commit/stage；回滚仍可用
  `git -C /src/celestea_harness checkout -- crates/llm/`）。
- ✅ 构建前查负载（1min load < 2），只 build 本 crate。
- ✅ 文件属主 celestea:celesdev（写入经 bash 以 uid 1003 执行，未改用 root 工具）。
- ✅ 凭据零落盘：注释/报告不含真实 api key；`Debug` 对 api_key 做 redact。

### 回滚
变更集中在 `crates/llm/`，`git -C /src/celestea_harness checkout -- crates/llm/`
即恢复。

## W189 补充：LLM adapter 注册表便捷函数

### 变更
- 新增 pub fn deepseek_registry(llm: DeepSeekLlm) -> LlmRegistry：把 DeepSeek
  提供器注册进默认 LlmRegistry 的 "deepseek" 名下（W189 多 provider seam）。
  调用方可在其上继续注册其它 provider；同名后注册会 shadow 先注册（patch 语义）。
- DeepSeekLlm 本体零改动；注册表类型定义在 celestea-core。

### 验证
- cargo test -p celestea-llm: passed（新增 deepseek_registry_registers_deepseek）

### 回滚
- git checkout crates/llm

### 遗留
- 目前仅 deepseek 一个 provider；按名路由的消费方 seam（LlmRegistryService）在
  core 定义，cli compose 已接线。
## W190 补充：移除硬编码模型目录，模型名自由化

### 变更
- **删除** `DeepSeekLlm::supported_models()` 与硬编码 preset（deepseek-chat /
  deepseek-reasoner 两个 ModelInfo 条目）。`ModelInfo` 类型保留，供未来自定义
  模型能力表扩展，但不再有内置预设。
- **改造** `DeepSeekLlm::validate_model`：不再查目录，只校验 model 非空
  （trim 后为空则 `Err(LlmError("model must not be empty"))`）。模型名成为自由
  字符串——提供器对 `base_url` 指向的任意 OpenAI 兼容端点说话，端点自定目录
  （本机 new-api 型端点暴露 deepseek-v4-flash / glm-5.2 / qwen3.8-max 等）。
- `generate()` 仍先对 effective model 做非空校验再发请求；`from_env()` 同步。
- 测试：`model_validation_rejects_unknown_model` / `supported_models_metadata_is_sane`
  删除，新增 `validate_model_requires_non_empty_model`（接受任意非空模型名、
  拒绝空串/空白）。

### 验证
- cargo build（全仓）：通过；cargo test -p celestea-llm：12/12 通过。
- 端到端（本机提供者）：见 W190 结果报告
  /server-center/runtime/worker-exec/results/W190-本机提供者端到端.md。

### 回滚
- git -C /src/celestea_harness checkout -- crates/llm/



## W191 补充：reasoning → StreamEvent::Thinking 映射（seam + 源码核验）

### 变更
- 新增 `thinking_event(reasoning) -> Option<StreamEvent>`：非空 reasoning → StreamEvent::Thinking
  （trim 后），空/空白 → None。
- 新增 `extract_reasoning(chunk: &serde_json::Value) -> Option<String>`：从流式 chunk 原始 JSON
  提取 DeepSeek 的 `choices[].delta.reasoning_content`（多 choice 按序拼接）。
- 关键核验（源码为准）：async-openai 0.41.3 的 `ChatCompletionStreamResponseDelta`
  （src/types/chat/chat_.rs:1140）只建模 content / function_call / tool_calls / role / refusal，
  **不含 reasoning_content / reasoning 字段**；无 `deny_unknown_fields`，serde 会静默丢弃未知字段。
  公开 `Chat::create_stream` 固定返回类型化 `CreateChatCompletionStreamResponse`，无公开原始
  SSE/JSON 出口。因此本迭代内，实时 generate() 流无法从类型化 delta 取到 CoT——映射函数已实现
  并对真实线格式单测，接入实时流是 P1 接原始 SSE 传输后的接线工作（seam 已就绪，标注 #[allow(dead_code)]）。
  Thinking 缝本体已端到端可用：agent-loop 消费 StreamEvent::Thinking（见 agent-loop 测试）。

### 验证
- cargo test -p celestea-llm: 17 passed（+5：thinking_event 非空/空、extract_reasoning 读取/
  多 choice 拼接/缺失为 None）。
- 全仓 build/test: 通过。

### 回滚
- git -C /src/celestea_harness checkout -- crates/llm/

### 遗留
- 实时 reasoning 落地依赖 async-openai 提供 raw SSE（当前版本无公开出口）或 provider 直连；
  seam 与映射已单测覆盖，P1 接传输即可点亮。
