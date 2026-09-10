/**
 * Provider-target resolution + live-assembly rules (W511), no network and no
 * data file: the rules are asserted directly, and the live client is inspected
 * through its secret-free view.
 */

import { describe, expect, it } from "vitest";
import {
  createLiveLlm,
  liveLlmView,
  resolveLlmMode,
  withBaseUrlFallback,
} from "@celestea/llm";
import type { EngineProfile } from "../runtime-adapter.js";
import {
  applyProviderTarget,
  ownerOf,
  resolveModel,
  resolveProviderKey,
  resolveProviderTarget,
  type ProviderLookup,
  type ProviderRef,
} from "./provider-target.js";

function row(over: Partial<ProviderRef> = {}): ProviderRef {
  return {
    id: "gw",
    base_url: "http://gw.test/v1",
    request_format: "chat_completions",
    api_key: null,
    models: [{ id: "m1" }],
    ...over,
  };
}

function lookup(rows: readonly ProviderRef[], defaultModel: string | null): ProviderLookup {
  return { rows: () => rows, defaultModel: () => defaultModel };
}

function baseProfile(over: Partial<EngineProfile> = {}): EngineProfile {
  return {
    model: "unknown",
    base_url: "http://profile.test/v1",
    reasoning_effort: null,
    max_steps: 4096,
    max_parallel_tool_calls: 4,
    max_output_tokens: null,
    context_window: 1_000_000,
    api_key_env: "CELESTEA_API_KEY",
    system_prompt: "identity",
    ...over,
  };
}

describe("model resolution", () => {
  it("takes a default_model that a provider actually lists", () => {
    const out = resolveModel(lookup([row()], "m1"), { CELESTEA_MODEL: "env-model" }, "profile-model");
    expect(out).toEqual({ model: "m1", source: "providers.json default_model" });
  });

  it("rejects a default_model no provider lists and falls back to CELESTEA_MODEL", () => {
    const out = resolveModel(lookup([row()], "ghost"), { CELESTEA_MODEL: "env-model" }, "profile-model");
    expect(out).toEqual({ model: "env-model", source: "env CELESTEA_MODEL" });
  });

  it("falls back to the profile model when nothing is configured", () => {
    const out = resolveModel(lookup([], null), {}, "profile-model");
    expect(out).toEqual({ model: "profile-model", source: "profile default" });
  });
});

describe("target resolution", () => {
  it("reports the owning provider and its base_url for a chat_completions row", () => {
    const rows = [row({ id: "other", models: [{ id: "m9" }] }), row({ id: "gw", base_url: "http://gw.test/v1" })];
    const target = resolveProviderTarget(lookup(rows, "m1"), { CELESTEA_BASE_URL: "http://env.test/v1" }, baseProfile());
    expect(target).toMatchObject({
      model: "m1",
      base_url: "http://gw.test/v1",
      provider_id: "gw",
      model_source: "providers.json default_model",
      key_source: "none",
    });
    expect(ownerOf(lookup(rows, "m1"), "m9")?.id).toBe("other");
    expect(ownerOf(lookup(rows, "m1"), "nope")).toBeNull();
  });

  it("keeps the env base_url for a provider without a chat adapter", () => {
    const rows = [row({ request_format: "anthropic_messages" })];
    const target = resolveProviderTarget(lookup(rows, "m1"), { CELESTEA_BASE_URL: "http://env.test/v1" }, baseProfile());
    expect(target.base_url).toBe("http://env.test/v1");
    expect(target.provider_id).toBe("gw");
  });

  it("keeps the profile base_url when neither provider nor env sets one", () => {
    const target = resolveProviderTarget(lookup([], null), {}, baseProfile({ base_url: "http://profile.test/v1" }));
    expect(target.base_url).toBe("http://profile.test/v1");
    expect(target.provider_id).toBeNull();
  });
});

describe("api key channel", () => {
  it("prefers the environment key and never rewrites the env from it", () => {
    const env = { CELESTEA_API_KEY: "env-key" };
    const out = resolveProviderKey(row({ api_key: "stored-key" }), env, "CELESTEA_API_KEY");
    expect(out).toEqual({ key: "env-key", source: "env" });
  });

  it("borrows a keyless provider's stored key into the process env only", () => {
    const env: NodeJS.ProcessEnv = {};
    const rows = [row({ api_key: "stored-key" })];
    const { profile, target } = applyProviderTarget(baseProfile(), resolveProviderTarget(lookup(rows, "m1"), env, baseProfile()), lookup(rows, "m1"), env);
    expect(env["CELESTEA_API_KEY"]).toBe("stored-key");
    expect(target.key_source).toBe("provider_store");
    expect(profile.model).toBe("m1");
    expect(profile.base_url).toBe("http://gw.test/v1");
    expect(JSON.stringify(profile)).not.toContain("stored-key");
    expect(JSON.stringify(target)).not.toContain("stored-key");
  });

  it("reports no key at all for a blank stored key", () => {
    const env: NodeJS.ProcessEnv = {};
    const rows = [row({ api_key: "   " })];
    applyProviderTarget(baseProfile(), resolveProviderTarget(lookup(rows, "m1"), env, baseProfile()), lookup(rows, "m1"), env);
    expect(env["CELESTEA_API_KEY"]).toBeUndefined();
    expect(resolveProviderKey(row({ api_key: "" }), env, "CELESTEA_API_KEY").source).toBe("none");
  });

  it("honours a custom api_key_env name", () => {
    const env: NodeJS.ProcessEnv = { MY_KEY: "custom" };
    expect(resolveProviderKey(row({ api_key: "stored" }), env, "MY_KEY")).toEqual({ key: "custom", source: "env" });
  });
});

describe("live assembly (mode + profile mapping)", () => {
  it("defaults to live and only an explicit offline value switches the seam", () => {
    expect(resolveLlmMode({})).toBe("live");
    expect(resolveLlmMode({ CELESTEA_LLM_MODE: "live" })).toBe("live");
    expect(resolveLlmMode({ CELESTEA_LLM_MODE: " OFFLINE " })).toBe("offline");
    expect(() => resolveLlmMode({ CELESTEA_LLM_MODE: "offlin" })).toThrow(/must be 'live' or 'offline'/);
  });

  it("fills base_url from CELESTEA_BASE_URL only when the profile leaves it empty", () => {
    expect(withBaseUrlFallback({ base_url: "http://p.test" }, { CELESTEA_BASE_URL: "http://e.test" }).base_url).toBe("http://p.test");
    expect(withBaseUrlFallback({ base_url: "" }, { CELESTEA_BASE_URL: "http://e.test" }).base_url).toBe("http://e.test");
    expect(withBaseUrlFallback({ base_url: "" }, {}).base_url).toBe("");
  });

  it("wires reasoning_effort / max_output_tokens / the three timeout tiers into the client", () => {
    const env = {
      CELESTEA_LLM_CONNECT_TIMEOUT_MS: "111",
      CELESTEA_LLM_RESPONSE_TIMEOUT_MS: "222",
      CELESTEA_LLM_STREAM_IDLE_TIMEOUT_MS: "0",
    };
    const profile = {
      model: "m1",
      base_url: "http://gw.test/v1",
      reasoning_effort: "xhigh-custom",
      max_output_tokens: 4321,
      context_window_tokens: 128_000,
    };
    const client = createLiveLlm(profile, env);
    expect(client.describe()).toEqual({
      baseUrl: "http://gw.test/v1",
      model: "m1",
      reasoningEffort: "xhigh-custom",
      maxOutputTokens: 4321,
      timeouts: { connectMs: 111, responseMs: 222, idleMs: null },
    });
    expect(client.endpoint()).toBe("http://gw.test/v1/chat/completions");
    expect(client.timeouts()).toEqual({ connectMs: 111, responseMs: 222, idleMs: null });
    const view = liveLlmView(profile, { ...env, CELESTEA_LLM_MODE: "offline" });
    expect(view).toMatchObject({ mode: "offline", contextWindow: 128_000, hasApiKey: false, maxOutputTokens: 4321 });
    expect(JSON.stringify(view)).not.toContain("key");
  });

  it("passes the reasoning effort through verbatim in the request body", () => {
    const client = createLiveLlm({ model: "m1", base_url: "http://gw.test/v1", reasoning_effort: "max" }, {});
    const body = client.requestBody({ messages: [{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }] });
    expect(body.reasoning_effort).toBe("max");
    expect(body.model).toBe("m1");
  });
});
