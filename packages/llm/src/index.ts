/**
 * @celestea/llm — OpenAI-compatible LLM provider (P2a public API).
 *
 * Parity target: `celestea_harness/crates/llm` — raw SSE transport, usage /
 * cache-hit parsing, three timeout tiers, free-form reasoning_effort.
 *
 * Only this barrel is the package's public surface: provider internals
 * (SSE framing, wire mapping, HTTP transport) stay private so callers depend on
 * the `Llm` seam, not on the provider.
 */

// The seam this package implements (see seam.ts for the core TODO adapter).
export type {
  Content,
  Llm,
  LlmStream,
  Message,
  ModelRequest,
  Role,
  StreamEvent,
  TextContent,
  ToolCall,
  ToolCallContent,
  ToolSpec,
} from "./seam.js";
export {
  assistantText,
  assistantToolCall,
  collectMessageText,
  collectStream,
  messageToolCalls,
  ROLES,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "./seam.js";

// Usage contract (the statusline reads exactly these flat counters).
export type { LlmUsageFrame, Usage } from "./usage.js";
export {
  cacheHitRatio,
  CACHE_READ_FLAT_KEYS,
  CACHE_READ_NESTED,
  parseUsage,
  REASONING_TOKENS_NESTED,
  USAGE_REQUIRED_KEYS,
  usageFromObject,
  usageIsEmpty,
  ZERO_USAGE,
  zeroUsage,
} from "./usage.js";

// Errors: the machine-readable timeout/timeout-stage + status/retryability
// contract (iteration E §4 P0 adds httpStatus/retryable; nothing is renamed).
export type { LlmErrorKind, LlmErrorOptions, TimeoutStage } from "./errors.js";
export {
  cancelledError,
  connectTimeoutError,
  errorKind,
  isRetryableStatus,
  isTimeoutError,
  LlmError,
  networkError,
  responseHeaderTimeoutError,
  RETRYABLE_HTTP_STATUSES,
  statusError,
  streamIdleTimeoutMessage,
  TIMEOUT_ERROR_PREFIX,
  timeoutError,
} from "./errors.js";

// The three timeout tiers + profile/env resolution.
export type { EnvLike, TimeoutProfile, TimeoutTiers } from "./timeouts.js";
export {
  CONNECT_TIMEOUT_ENV,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  isTimeoutMs,
  msToDuration,
  PROFILE_TIMEOUT_KEYS,
  readTimeoutProfile,
  RESPONSE_TIMEOUT_ENV,
  resolveTimeoutMs,
  resolveTimeoutTiers,
  STREAM_IDLE_TIMEOUT_ENV,
} from "./timeouts.js";

// Provider profile -> client configuration (api key from env only).
export type { LlmProfile, ResolvedClientConfig } from "./profile.js";
export {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeReasoningEffort,
  resolveApiKey,
  resolveClientConfig,
  tiersFromConfig,
  validateModel,
} from "./profile.js";

// Production factory: mode switch + live profile -> client assembly (W511).
export type { LiveLlmProfile, LiveLlmView, LlmMode } from "./factory.js";
export {
  createLiveLlm,
  liveLlmView,
  LLM_BASE_URL_ENV,
  LLM_MODE_ENV,
  resolveLlmMode,
  withBaseUrlFallback,
} from "./factory.js";

// The adapter + provider registration.
export type { OpenAiCompatOptions } from "./client.js";
export { OpenAiCompatClient } from "./client.js";
export {
  createDeepSeekLlm,
  createDeepSeekRegistry,
  DEEPSEEK_PROVIDER_NAME,
  LlmRegistry,
} from "./provider.js";
