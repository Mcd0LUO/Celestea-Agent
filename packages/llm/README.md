# @celestea/llm — OpenAI-compatible LLM provider (P2a)

Rust parity target: `celestea_harness/crates/llm` (+ `crates/runtime/src/compose.rs`
for profile resolution). Raw SSE transport, usage/cache-hit parsing, three
timeout tiers, free-form `reasoning_effort` passthrough.

## 职责

* **请求构造** — `POST {base_url}/chat/completions`，体为
  `{model, messages, tools?, reasoning_effort?, max_tokens?, temperature?, stream:true}`。
  `reasoning_effort` 是**自由字符串**，原样透传（`"max"` 就是 `"max"`，不改名、不折叠、不裁剪）；
  请求的 `max_tokens` 优先，缺省回落到配置的 `max_output_tokens`。
* **SSE 解析** — 逐行 `data:`、空行分帧；跳过注释/keepalive/空帧/非 JSON；`[DONE]` 结束；
  `reasoning_content` → `thinking` 增量（实时 CoT），`content` → `text` 增量，
  `tool_calls` 按 index 分片累积，`usage` 帧（含“只有 usage 的尾帧”）在终态事件前下发。
* **用量解析** — `Usage{prompt_tokens, completion_tokens, total_tokens, cache_read, reasoning_tokens}`；
  `cache_read` 兼容三种键：`prompt_cache_hit_tokens` / `cache_read_input_tokens` /
  `prompt_tokens_details.cached_tokens`（前两者优先），
  `reasoning_tokens` 取 `completion_tokens_details.reasoning_tokens`。
* **三档超时（无总请求超时）** — connect 15s、响应头 60s、流空闲 90s；
  0 = 关闭该档；长生成只靠“帧间隔”判活，永不因总时长被杀。
* **错误语义** — 响应头超时抛
  `llm timeout: response headers not received within {N}ms ({url})`（`kind="generate"`）；
  connect 超时抛 `llm timeout: connect timeout: ...`；
  流空闲 → 终态事件 `failed{kindOf:"timeout"}`；流中途解码/传输错误 → `failed{kindOf:"stream"}`；
  未收到 `[DONE]` 而流结束 → `interrupted`；HTTP 非 2xx → `stream request failed: {status}: {片段}`。
  **任何路径都不会伪造 done**（R1）。
* **密钥安全** — API key 只从运行时 profile / 环境变量读取（`api_key_env`，默认
  `DEEPSEEK_API_KEY`），只作为 `Authorization: Bearer` 头发送；不落盘、不写日志、
  不进入错误文案，`describe()` 视图也不含 key。

## 公开 API（唯一出口：`src/index.ts`）

| 分类 | 导出 |
|---|---|
| seam 类型 | `Llm`, `LlmStream`, `StreamEvent`, `Message`, `Content`, `TextContent`, `ToolCallContent`, `ToolCall`, `Role`, `ROLES`, `ToolSpec`, `ModelRequest` |
| seam 工具 | `userMessage`, `systemMessage`, `assistantText`, `assistantToolCall`, `toolResultMessage`, `collectMessageText`, `messageToolCalls`, `collectStream` |
| 用量 | `Usage`, `parseUsage`, `usageFromObject`, `usageIsEmpty`, `zeroUsage`, `ZERO_USAGE`, `cacheHitRatio`, `USAGE_REQUIRED_KEYS`, `CACHE_READ_FLAT_KEYS`, `CACHE_READ_NESTED`, `REASONING_TOKENS_NESTED` |
| 错误 | `LlmError`, `LlmErrorKind`, `TimeoutStage`, `TIMEOUT_ERROR_PREFIX`, `timeoutError`, `responseHeaderTimeoutError`, `connectTimeoutError`, `streamIdleTimeoutMessage`, `isTimeoutError`, `errorKind` |
| 超时三档 | `TimeoutTiers`, `TimeoutProfile`, `DEFAULT_TIMEOUTS`, `DEFAULT_*_TIMEOUT_MS`, `CONNECT_TIMEOUT_ENV`, `RESPONSE_TIMEOUT_ENV`, `STREAM_IDLE_TIMEOUT_ENV`, `PROFILE_TIMEOUT_KEYS`, `resolveTimeoutMs`, `resolveTimeoutTiers`, `readTimeoutProfile`, `msToDuration`, `isTimeoutMs`, `EnvLike` |
| profile→配置 | `LlmProfile`, `ResolvedClientConfig`, `resolveClientConfig`, `resolveApiKey`, `tiersFromConfig`, `normalizeReasoningEffort`, `validateModel`, `API_KEY_ENV`, `BASE_URL_ENV`, `DEFAULT_BASE_URL`, `DEFAULT_MODEL` |
| 适配器 | `OpenAiCompatClient`（实现 `Llm`）, `OpenAiCompatOptions`, `createDeepSeekLlm`, `LlmRegistry`, `createDeepSeekRegistry`, `DEEPSEEK_PROVIDER_NAME` |

调用方只依赖 `Llm` seam 与上面的类型；SSE 分帧、wire 映射、HTTP 传输是包内实现，
**不从 index.ts 导出**（`packages/llm/src/sse/*`、`wire.ts`、`transport.ts`、`stream.ts`）。

## 超时契约

| 档位 | 默认 | profile 键 | 环境变量 | 语义 |
|---|---|---|---|---|
| connect | 15000 ms | `llm_connect_timeout_ms` | `CELESTEA_LLM_CONNECT_TIMEOUT_MS` | TCP/TLS 握手 |
| response | 60000 ms | `llm_response_timeout_ms` | `CELESTEA_LLM_RESPONSE_TIMEOUT_MS` | `send()` → 响应头 |
| stream idle | 90000 ms | `llm_stream_idle_timeout_ms` | `CELESTEA_LLM_STREAM_IDLE_TIMEOUT_MS` | 相邻两个数据帧的间隔（含首帧等待） |

优先级 **env > profile 键 > 内置默认**；`0` 关闭该档；env 空白/不可解析则回落到 profile 键
（与 `crates/runtime/src/config.rs::resolve_llm_timeout_ms` 一致）。
**不存在总请求超时**：只有“响应头没来”和“帧间隔断了”会触发，长时间生成不会被杀。

## 用量契约

`Usage` 五个扁平计数即 `statusline.usage` 的字段（`prompt_tokens` / `completion_tokens` /
`total_tokens` / `cache_read` / `reasoning_tokens`）；`cache_hit_ratio = clamp(cache_read /
prompt_tokens, 0, 1)`，4 位小数。全零 usage 视为“没有 usage 帧”（`undefined`），
非数字/负数/小数一律按 0 处理（对齐 serde `as_u64`）。

## 扩展点：新增一个 provider

1. 若新 provider 也讲 OpenAI `chat/completions`（仅 base_url / 模型名不同），直接复用
   `OpenAiCompatClient`，用 profile 覆盖 `base_url` / `model` / `reasoning_effort` / 超时键即可。
2. 若请求体或流格式不同（例如 `responses` / `anthropic_messages`），实现 `Llm` seam：

   ```ts
   class MyProvider implements Llm {
     async generate(req: ModelRequest): Promise<LlmStream> { /* 自己的 wire + SSE */ }
   }
   ```

   复用 `timeouts.ts`（三档解析）、`usage.ts`（用量解析）、`errors.ts`（超时前缀/kind 映射）
   与 `stream.ts` 的 `TurnAccumulator`，即可继承同样的超时/用量/终态语义。
3. 注册：`registry.register("myprovider", new MyProvider(...))`。
   `crates/llm/src/registry.rs` 的对应物是 `createDeepSeekRegistry(llm)`。

## core seam adapter（TODO）

`packages/llm` 以**插件**形式实现 `packages/core` 的 `Llm` seam，只依赖 `packages/core`
（不依赖 session / tools / agent-loop / runtime）。P2a 交付时 core 的 seam 仍在改造中
（`packages/core/src/{llm,stream,message}.ts` 在工作区里尚未提交、也未定型），因此
**本包自带 `src/seam.ts` 这份词汇表**，并把形状对齐到 core 现有实现；一旦 core 定稿，
切换只需改 import：

```ts
// 现在（P2a，自持词汇表）
import type { Llm, LlmStream, Message, ModelRequest, StreamEvent, ToolSpec } from "./seam.js";
// core seam 合并后（唯一改动点；seam.ts 可退化为 core 的 re-export）
import type { Llm, LlmStream, Message, ModelRequest, StreamEvent, ToolSpec } from "@celestea/core";
```

### 接口差异（对照 W271 的 `packages/core/src/{llm,stream,message,types}.ts`）

| 项 | core 现状 | 本包 | 差异 / 处置 |
|---|---|---|---|
| `Llm.generate(req): Promise<LlmStream>` | 一致 | 一致 | 无差异，`OpenAiCompatClient implements Llm` 直接满足结构 |
| `StreamEvent` 判别字段 | `kind` | `kind` | 已对齐（`text` / `thinking` 载荷字段同样是 `text`） |
| `StreamEvent.failed.kindOf` | `"generate" \| "stream"` | `"generate" \| "stream" \| "timeout"` | **需 core 放宽**：Rust 侧 `Failed{kind}` 是自由字符串，SSE 空闲守卫取 `"timeout"`（P2a 硬性要求“流空闲 → kind=timeout”）；否则换接口时会丢该语义 |
| `ModelRequest` | 全字段必填（`model: string`、`system: string \| null`、`tools: ToolSpec[]`、`max_tokens: number \| null`、`temperature: number \| null`） | 同名字段、可选/宽松 | 无破坏：core 的值可直接传入本包；本包不生产 `ModelRequest`，只消费 |
| `LlmError` | 纯 `message` 类（对齐 Rust `LlmError(String)`） | 同名 + `kind` / `isTimeout` / `timeoutStage`，保留 `TIMEOUT_ERROR_PREFIX = "llm timeout"` | 换接口时让本包 `LlmError extends CoreLlmError`（`instanceof` 与 core 兼容），结构化字段保留 |
| `LlmRegistry` | 已有（`NamedRegistry`，后注册覆盖、`list()` 去重） | `provider.ts` 内含同名最小实现 | 换接口时删除本包实现，改用 core 的；`createDeepSeekRegistry` 保留为便捷工厂 |
| seam 词汇（`Role`/`Content`/`ToolCall`/`Message`/`ToolSpec`/`Usage`） | `message.ts` + `types.ts` | 与之一致：`Content` 标签 `"text"` / `"tool_call"`，载荷字段 `content`，`tool_call_id: string \| null`，Usage 五扁平计数 | 已对齐，无需转换 |
| `Llm` service token | `LLM_SERVICE` / `LLM_REGISTRY_SERVICE` | 无 | 组合期（compose）由 runtime 侧使用；本包不涉及 |

## 目录

| 文件 | 行数(约) | 职责 |
|---|---|---|
| `src/index.ts` | 107 | 唯一公开出口 |
| `src/seam.ts` | 143 | seam 词汇表 + `Llm` 接口 + 消息构造器 + `collectStream` |
| `src/client.ts` | 177 | `OpenAiCompatClient`（实现 `Llm`）与 HTTP 错误包装 |
| `src/transport.ts` | 150 | HTTP 传输 + connect/响应头两档超时 + 错误体片段 + 脱敏 |
| `src/stream.ts` | 246 | 流空闲超时读体 + `TurnAccumulator` + 终态事件（done/failed/interrupted） |
| `src/sse/frames.ts` | 98 | 增量 SSE 分帧器 |
| `src/sse/chunks.ts` | 151 | chunk 视图、`reasoning_content`、tool-call 分片、参数解析 |
| `src/wire.ts` | 136 | 消息/工具映射与请求体构造 |
| `src/usage.ts` | 121 | 用量与三种 cache 键解析 |
| `src/timeouts.ts` | 153 | 三档超时解析（profile 键 + env + 默认） |
| `src/profile.ts` | 121 | profile→配置、api key 只从 env、effort 直通 |
| `src/provider.ts` | 62 | provider 注册与 from-env 构造 |
| `src/*.test.ts`, `src/mock-upstream.test-util.ts` | — | 本地 mock HTTP server 测试（无网络） |
