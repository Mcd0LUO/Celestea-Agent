import { describe, expect, it } from "vitest";

import {
  CONNECT_TIMEOUT_ENV,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  msToDuration,
  normalizeReasoningEffort,
  PROFILE_TIMEOUT_KEYS,
  readTimeoutProfile,
  resolveApiKey,
  resolveClientConfig,
  resolveTimeoutMs,
  resolveTimeoutTiers,
  RESPONSE_TIMEOUT_ENV,
  STREAM_IDLE_TIMEOUT_ENV,
} from "@celestea/llm";
import { OpenAiCompatClient } from "@celestea/llm";

describe("three timeout tiers: defaults and profile keys", () => {
  it("uses the Rust defaults (15s connect / 60s response / 90s idle)", () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_RESPONSE_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_TIMEOUTS).toEqual({ connectMs: 15_000, responseMs: 60_000, idleMs: 90_000 });
    expect(resolveTimeoutTiers(null, {})).toEqual(DEFAULT_TIMEOUTS);
  });

  it("names the profile keys documented by the runtime config", () => {
    expect(PROFILE_TIMEOUT_KEYS).toEqual({
      connect: "llm_connect_timeout_ms",
      response: "llm_response_timeout_ms",
      idle: "llm_stream_idle_timeout_ms",
    });
  });

  it("lets the profile keys override the defaults", () => {
    const tiers = resolveTimeoutTiers(
      {
        llm_connect_timeout_ms: 111,
        llm_response_timeout_ms: 222,
        llm_stream_idle_timeout_ms: 333,
      },
      {},
    );
    expect(tiers).toEqual({ connectMs: 111, responseMs: 222, idleMs: 333 });
  });

  it("lets the CELESTEA_LLM_* env vars win over the profile keys", () => {
    const env = {
      [CONNECT_TIMEOUT_ENV]: "1000",
      [RESPONSE_TIMEOUT_ENV]: "2000",
      [STREAM_IDLE_TIMEOUT_ENV]: "3000",
    };
    const tiers = resolveTimeoutTiers(
      {
        llm_connect_timeout_ms: 111,
        llm_response_timeout_ms: 222,
        llm_stream_idle_timeout_ms: 333,
      },
      env,
    );
    expect(tiers).toEqual({ connectMs: 1000, responseMs: 2000, idleMs: 3000 });
  });

  it("ignores blank/unparseable env values and keeps the profile value", () => {
    expect(resolveTimeoutMs(111, "not-a-number", 333)).toBe(111);
    expect(resolveTimeoutMs(undefined, "   ", 333)).toBe(333);
    expect(resolveTimeoutMs(undefined, "-5", 333)).toBe(333);
    expect(resolveTimeoutMs(undefined, "12.5", 333)).toBe(333);
    expect(resolveTimeoutMs(undefined, " 222 ", 333)).toBe(222);
    expect(resolveTimeoutMs(null, undefined, 333)).toBe(333);
    // env 0 disables even when the profile set a value
    expect(resolveTimeoutMs(111, "0", 333)).toBe(0);
  });

  it("maps 0 to a disabled stage and rejects invalid profile values leniently", () => {
    expect(msToDuration(0, 90_000)).toBeNull();
    expect(msToDuration(undefined, 90_000)).toBe(90_000);
    expect(msToDuration(-1, 90_000)).toBe(90_000);
    const { profile, errors } = readTimeoutProfile({
      llm_connect_timeout_ms: 0,
      llm_response_timeout_ms: "soon",
      llm_stream_idle_timeout_ms: -3,
    });
    expect(profile).toEqual({ llm_connect_timeout_ms: 0 });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("llm_response_timeout_ms");
  });
});

describe("client construction from config/profile", () => {
  it("treats 0 as disabled and defaults the rest to the Rust tiers", () => {
    const client = new OpenAiCompatClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "dummy",
      model: "deepseek-chat",
      connectTimeoutMs: 5_000,
      responseTimeoutMs: 0,
      streamIdleTimeoutMs: 0,
    });
    expect(client.timeouts()).toEqual({ connectMs: 5_000, responseMs: null, idleMs: null });
  });

  it("reports the documented defaults when nothing is configured", () => {
    const client = new OpenAiCompatClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "dummy",
      model: "deepseek-chat",
    });
    expect(client.timeouts()).toEqual(DEFAULT_TIMEOUTS);
  });
});

describe("profile -> config resolution", () => {
  it("reads the api key from the environment only (api_key_env honoured)", () => {
    expect(resolveApiKey({}, { DEEPSEEK_API_KEY: "  sk-from-env  " })).toBe("sk-from-env");
    expect(resolveApiKey({}, {})).toBeNull();
    expect(resolveApiKey({}, { DEEPSEEK_API_KEY: "   " })).toBeNull();
    expect(resolveApiKey({ api_key_env: "MY_KEY" }, { MY_KEY: "sk-custom" })).toBe("sk-custom");
    // only the named env var is read; an unset key resolves to the empty string
    expect(resolveClientConfig({ api_key_env: "MY_KEY" }, {}).apiKey).toBe("");
  });

  it("resolves base_url / model / effort / caps with env fallbacks", () => {
    const config = resolveClientConfig(
      {
        base_url: "http://127.0.0.1:3001/v1",
        model: "deepseek-v4-flash-0731",
        reasoning_effort: "max",
        max_output_tokens: 4096,
        llm_response_timeout_ms: 1234,
      },
      {},
    );
    expect(config.baseUrl).toBe("http://127.0.0.1:3001/v1");
    expect(config.model).toBe("deepseek-v4-flash-0731");
    expect(config.reasoningEffort).toBe("max");
    expect(config.maxOutputTokens).toBe(4096);
    expect(config.responseTimeoutMs).toBe(1234);
    expect(config.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(config.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);

    const fromEnv = resolveClientConfig(null, { DEEPSEEK_BASE_URL: "http://shim/v1" });
    expect(fromEnv.baseUrl).toBe("http://shim/v1");
    expect(fromEnv.model).toBe("deepseek-chat");
    expect(fromEnv.apiKey).toBe("");
  });

  it("never leaks the api key through the client's describe() view", () => {
    const client = OpenAiCompatClient.fromProfile(
      { model: "deepseek-chat" },
      { DEEPSEEK_API_KEY: "sk-super-secret-value" },
    );
    const described = JSON.stringify(client.describe());
    expect(described).not.toContain("sk-super-secret");
    expect(described).toContain("deepseek-chat");
  });
});

describe("reasoning_effort is a free-form passthrough", () => {
  it("keeps null/undefined as unset and everything else verbatim", () => {
    expect(normalizeReasoningEffort(null)).toBeNull();
    expect(normalizeReasoningEffort(undefined)).toBeNull();
    expect(normalizeReasoningEffort("max")).toBe("max");
    expect(normalizeReasoningEffort("xhigh-custom")).toBe("xhigh-custom");
    expect(normalizeReasoningEffort("off")).toBe("off");
    expect(normalizeReasoningEffort(" HIGH ")).toBe(" HIGH ");
  });
});
