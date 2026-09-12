/**
 * The OpenAI-compatible provider client (P2a).
 *
 * Implements the `Llm` seam on top of the pieces of this package:
 * wire.ts (request body), transport.ts (connect + response-header guards),
 * stream.ts (idle-guarded SSE decoding), usage.ts (usage/cache parsing).
 *
 * Error semantics:
 *   * response-header timeout -> LlmError `llm timeout: response headers not
 *     received within {N}ms ({url})`, kind "generate";
 *   * connect timeout         -> LlmError `llm timeout: connect timeout: ...`;
 *   * non-2xx                 -> LlmError `stream request failed: <status>:
 *     <body snippet>` (no API key);
 *   * stream idle stall       -> stream event failed{kind:"timeout"};
 *   * mid-stream decode error -> stream event failed{kind:"stream"};
 *   * missing [DONE]          -> stream event interrupted.
 *
 * The API key lives in a private field, is sent only as a Bearer header, and
 * is never logged, serialized or echoed into an error message.
 */

import type http from "node:http";

import { statusError } from "./errors.js";
import {
  resolveClientConfig,
  validateModel,
  type LlmProfile,
  type ResolvedClientConfig,
} from "./profile.js";
import {
  buildRequestBody,
  chatCompletionsUrl,
  type ChatCompletionsBody,
} from "./wire.js";
import { httpStatusLabel, readBodySnippet, redact, sendChatRequest } from "./transport.js";
import { streamEvents } from "./stream.js";
import type { Llm, LlmStream, ModelRequestDraft } from "./seam.js";
import { DEFAULT_TIMEOUTS, type EnvLike, type TimeoutTiers } from "./timeouts.js";

/** Constructor options. Timeout fields: 0 = disabled (Rust ms_to_duration). */
export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Free-form tier string; passed through verbatim, never folded/renamed. */
  reasoningEffort?: string | null;
  maxOutputTokens?: number | null;
  connectTimeoutMs?: number | null;
  responseTimeoutMs?: number | null;
  streamIdleTimeoutMs?: number | null;
}

function toMs(value: number | null | undefined, fallback: number | null): number | null {
  if (value === null || value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value === 0 ? null : Math.floor(value);
}

export class OpenAiCompatClient implements Llm {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #reasoningEffort: string | null;
  readonly #maxOutputTokens: number | null;
  readonly #connectMs: number | null;
  readonly #responseMs: number | null;
  readonly #idleMs: number | null;

  constructor(options: OpenAiCompatOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#reasoningEffort = options.reasoningEffort ?? null;
    this.#maxOutputTokens = options.maxOutputTokens ?? null;
    this.#connectMs = toMs(options.connectTimeoutMs, DEFAULT_TIMEOUTS.connectMs);
    this.#responseMs = toMs(options.responseTimeoutMs, DEFAULT_TIMEOUTS.responseMs);
    this.#idleMs = toMs(options.streamIdleTimeoutMs, DEFAULT_TIMEOUTS.idleMs);
  }

  /** The configured model (used when a request leaves its model empty). */
  get model(): string {
    return this.#model;
  }

  /** Effective timeouts (null = that stage is disabled). */
  timeouts(): TimeoutTiers {
    return { connectMs: this.#connectMs, responseMs: this.#responseMs, idleMs: this.#idleMs };
  }

  /** Secret-free view of the configuration (safe to log/serialize). */
  describe(): {
    baseUrl: string;
    model: string;
    reasoningEffort: string | null;
    maxOutputTokens: number | null;
    timeouts: TimeoutTiers;
  } {
    return {
      baseUrl: this.#baseUrl,
      model: this.#model,
      reasoningEffort: this.#reasoningEffort,
      maxOutputTokens: this.#maxOutputTokens,
      timeouts: this.timeouts(),
    };
  }

  /** The endpoint this client posts to. */
  endpoint(): string {
    return chatCompletionsUrl(this.#baseUrl);
  }

  /** Request model wins; the configured model is the fallback. */
  effectiveModel(req: ModelRequestDraft): string {
    return req.model === undefined || req.model === "" ? this.#model : req.model;
  }

  /** Serialized request body (reasoning_effort injected verbatim). */
  requestBody(req: ModelRequestDraft, model: string = this.effectiveModel(req)): ChatCompletionsBody {
    return buildRequestBody(req, {
      model,
      reasoningEffort: this.#reasoningEffort,
      maxOutputTokens: this.#maxOutputTokens,
    });
  }

  /**
   * Start a streaming turn. Pre-stream failures (model validation, connect /
   * response-header timeout, transport error, non-2xx status) reject with an
   * LlmError; the returned stream then carries the terminal state as an event.
   */
  async generate(req: ModelRequestDraft): Promise<LlmStream> {
    const model = this.effectiveModel(req);
    validateModel(model);
    const body = this.requestBody(req, model);
    const url = this.endpoint();
    const response = await sendChatRequest({
      url,
      apiKey: this.#apiKey,
      body: JSON.stringify(body),
      connectMs: this.#connectMs,
      responseMs: this.#responseMs,
    });
    await assertSuccess(response);
    return streamEvents(response, this.#idleMs);
  }

  /** Build a client from a resolved configuration. */
  static fromConfig(config: ResolvedClientConfig): OpenAiCompatClient {
    return new OpenAiCompatClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxOutputTokens: config.maxOutputTokens,
      connectTimeoutMs: config.connectTimeoutMs,
      responseTimeoutMs: config.responseTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });
  }

  /** Options from a runtime profile + environment (api key from env only). */
  static fromProfile(profile?: LlmProfile | null, env: EnvLike = process.env): OpenAiCompatClient {
    return OpenAiCompatClient.fromConfig(resolveClientConfig(profile, env));
  }
}

/** Reject with a status-bearing error when the response is not 2xx. */
async function assertSuccess(response: http.IncomingMessage): Promise<void> {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) return;
  const text = await readBodySnippet(response);
  response.destroy();
  const label = httpStatusLabel(status, response.statusMessage);
  throw statusError(status, label, redact(text));
}
