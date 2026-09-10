/**
 * GET/POST `/api/config` — `src/api.rs:56-70,190-372`.
 *
 * POST is a two-phase apply: the HOST validates (model charset/length, url,
 * numeric caps, effort availability) and then hands an accepted patch to the
 * engine seam (`RuntimeAdapter.configure`). The api_key takes a third path: it
 * goes only into `process.env[api_key_env]` — never into a response, a store or
 * a log line.
 */

import type { Hono } from "hono";
import { EngineError } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import { configView } from "./config-shape.js";
import { failJson, numField, readJsonBody, strField, type Deps, type JsonObject } from "./common.js";
import { validateModelName } from "../store/validate.js";
import { MIN_STEPS } from "../config.js";
import type { ProfilePatch } from "../runtime-adapter.js";

const U32_MAX = 4_294_967_295;

/** `reasoning_effort` handling: ""/"off" clears; free strings pass through. */
function effortPatch(patch: ProfilePatch, raw: string | undefined): void {
  if (raw === undefined) return;
  const v = raw.trim();
  patch.reasoning_effort = v === "" || v.toLowerCase() === "off" ? null : v;
}

/** Validate + fold the optional numeric fields into the patch. */
function numericPatch(c: Parameters<typeof failJson>[0], body: JsonObject, patch: ProfilePatch): Response | null {
  const maxOut = numField(c, body, "max_output_tokens");
  if (!maxOut.ok) return maxOut.response;
  if (maxOut.value !== undefined) {
    if (maxOut.value > U32_MAX) return failJson(c, 400, "max_output_tokens must be <= u32::MAX");
    patch.max_output_tokens = maxOut.value === 0 ? null : Math.trunc(maxOut.value);
  }
  const ctxWindow = numField(c, body, "context_window");
  if (!ctxWindow.ok) return ctxWindow.response;
  if (ctxWindow.value !== undefined) patch.context_window = Math.trunc(ctxWindow.value);
  const steps = numField(c, body, "max_steps");
  if (!steps.ok) return steps.response;
  if (steps.value !== undefined) {
    if (steps.value === 0) return failJson(c, 400, "max_steps must be >= 1");
    patch.max_steps = Math.max(Math.trunc(steps.value), MIN_STEPS);
  }
  return null;
}

export function registerConfig(app: Hono, deps: Deps, table: RouteTable): string[] {
  const get = table.get("get_config");
  app.on(get.method, get.honoPath, (c) => c.json(configView(deps)));

  const post = table.get("post_config");
  app.on(post.method, post.honoPath, async (c) => {
    if (deps.runtime.isBusy()) return failJson(c, 409, "turn in progress; config applies between turns");
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const body = read.body;

    const model = strField(c, body, "model");
    if (!model.ok) return model.response;
    const effort = strField(c, body, "reasoning_effort");
    if (!effort.ok) return effort.response;
    const baseUrl = strField(c, body, "base_url");
    if (!baseUrl.ok) return baseUrl.response;
    const apiKey = strField(c, body, "api_key");
    if (!apiKey.ok) return apiKey.response;
    const systemPrompt = strField(c, body, "system_prompt");
    if (!systemPrompt.ok) return systemPrompt.response;

    const patch: ProfilePatch = {};
    const askedModel = (model.value ?? "").trim();
    if (askedModel !== "") {
      const bad = validateModelName(askedModel);
      if (bad !== null) return failJson(c, 400, bad);
      patch.model = askedModel;
    }
    effortPatch(patch, effort.value);
    if (patch.reasoning_effort != null && !isReasoningCapable(deps, patch.model ?? deps.runtime.profile().model)) {
      return failJson(c, 400, `model '${patch.model ?? deps.runtime.profile().model}' is not a reasoning model; reasoning_effort is unavailable`);
    }
    if (baseUrl.value !== undefined) {
      if (baseUrl.value !== "" && !isHttp(baseUrl.value)) return failJson(c, 400, "base_url must be an http:// or https:// URL");
      deps.settings.setBaseUrlOverride(baseUrl.value);
      if (baseUrl.value !== "") patch.base_url = baseUrl.value;
    }
    const numericFailure = numericPatch(c, body, patch);
    if (numericFailure !== null) return numericFailure;
    if (systemPrompt.value !== undefined) {
      deps.settings.setSystemPromptOverride(systemPrompt.value);
      patch.system_prompt = deps.settings.systemPromptOverride() ?? "";
    }
    if (apiKey.value !== undefined && apiKey.value !== "") {
      process.env[deps.config.apiKeyEnv] = apiKey.value;
    }
    try {
      await deps.runtime.configure(patch);
    } catch (e) {
      const message = e instanceof EngineError ? e.message : String(e);
      return failJson(c, 500, `compose failed: ${message}`);
    }
    return c.json(configView(deps));
  });

  return [get.id, post.id];
}

function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Reasoning availability: a model the providers store lists WITHOUT any
 * reasoning effort is not reasoning-capable; an unknown id is (the contract's
 * "custom endpoint friendly" rule, `src/main.rs:135-137`).
 */
function isReasoningCapable(deps: Deps, model: string): boolean {
  for (const p of deps.providers.rows()) {
    for (const m of p.models) {
      if (m.id === model) return m.reasoning_efforts.length > 0;
    }
  }
  return true;
}
