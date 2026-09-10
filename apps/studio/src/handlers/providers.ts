/**
 * Provider endpoints — `src/providers.rs:673-797`.
 *
 * Every response is a `public_view`: the `api_key` KEY does not exist in the
 * shape at all. `/api/providers/test` accepts a full inline overlay that is
 * never persisted; `/models/fetch` resolves the row from the store and may
 * borrow the engine's own key for a same-origin keyless provider.
 */

import type { Hono } from "hono";
import { EngineError } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import { probeModels, testProvider, type ProbeCandidate, type ProbeOptions } from "../store/provider-probe.js";
import { REQUEST_FORMATS, type ProviderRow, type RequestFormat } from "../store/providers.js";
import { isHttpUrl } from "../store/validate.js";
import { baseUrlOf } from "./config-shape.js";
import { failJson, readJsonBody, strField, storeFail, type Deps, type JsonObject } from "./common.js";

function probeOptions(deps: Deps): ProbeOptions {
  return { engineBaseUrl: baseUrlOf(deps), engineKey: process.env[deps.config.apiKeyEnv] ?? null };
}

/** Validate a candidate the way Rust validates `ProviderReq` before probing. */
function candidateError(candidate: ProbeCandidate): string | null {
  if (candidate.base_url.trim() === "") return "base_url is required";
  if (!isHttpUrl(candidate.base_url)) return "base_url must be an http:// or https:// URL";
  if (!(REQUEST_FORMATS as readonly string[]).includes(candidate.request_format)) {
    return `invalid request_format '${candidate.request_format}': expected chat_completions | responses | anthropic_messages`;
  }
  return null;
}

function asCandidate(body: JsonObject, stored: ProviderRow | undefined): ProbeCandidate {
  const fmt = typeof body["request_format"] === "string" ? (body["request_format"] as RequestFormat) : (stored?.request_format ?? "chat_completions");
  return {
    id: stored?.id ?? "__inline__",
    base_url: typeof body["base_url"] === "string" ? body["base_url"] : (stored?.base_url ?? ""),
    request_format: fmt,
    api_key: typeof body["api_key"] === "string" ? body["api_key"] : (stored?.api_key ?? null),
  };
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_providers");
  app.on(route.method, route.honoPath, (c) => c.json(deps.providers.response()));
  return route.id;
}

function registerUpsert(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_providers");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const body = read.body;
    const res = deps.providers.upsert({
      id: typeof body["id"] === "string" ? body["id"] : undefined,
      name: typeof body["name"] === "string" ? body["name"] : undefined,
      note: typeof body["note"] === "string" ? body["note"] : undefined,
      base_url: typeof body["base_url"] === "string" ? body["base_url"] : undefined,
      request_format: typeof body["request_format"] === "string" ? body["request_format"] : undefined,
      api_key: typeof body["api_key"] === "string" ? body["api_key"] : null,
      models: Array.isArray(body["models"]) ? (body["models"] as Array<Record<string, unknown>>) : undefined,
    });
    if (!res.ok) return storeFail(c, res);
    return c.json(res.value);
  });
  return route.id;
}

function registerDelete(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_delete");
  app.on(route.method, route.honoPath, (c) => {
    const res = deps.providers.remove(c.req.param("id") ?? "");
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true });
  });
  return route.id;
}

function registerTest(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_test");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c, false);
    if (!read.ok) return read.response;
    const id = strField(c, read.body, "id");
    if (!id.ok) return id.response;
    const stored = id.value === undefined ? undefined : deps.providers.find(id.value);
    const candidate = asCandidate(read.body, stored);
    const bad = candidateError(candidate);
    if (bad !== null) return failJson(c, 400, bad);
    const out = await testProvider(candidate, probeOptions(deps));
    if (!out.ok) return c.json({ ok: false, error: out.error });
    return c.json({ ok: true, latency_ms: out.latency_ms, model_count: out.model_count });
  });
  return route.id;
}

function registerModelsFetch(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_models_fetch");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    const stored = deps.providers.find(id);
    if (stored === undefined) return failJson(c, 404, `unknown provider '${id}'`);
    const out = await probeModels(
      { id: stored.id, base_url: stored.base_url, request_format: stored.request_format, api_key: stored.api_key },
      probeOptions(deps),
    );
    if (!out.ok) return c.json({ ok: false, error: out.error });
    return c.json({ ok: true, models: out.models });
  });
  return route.id;
}

function registerDefault(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_default");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const model = strField(c, read.body, "model");
    if (!model.ok) return model.response;
    const wanted = (model.value ?? "").trim();
    if (wanted === "") return failJson(c, 400, "model must not be empty");
    if (deps.runtime.isBusy()) return failJson(c, 409, "a turn is running; provider default applies between turns");
    const owner = deps.providers.rows().find((p) => p.models.some((m) => m.id === wanted));
    const patch = owner !== undefined && owner.request_format === "chat_completions" && owner.base_url !== "" ? { model: wanted, base_url: owner.base_url } : { model: wanted };
    try {
      await deps.runtime.configure(patch);
    } catch (e) {
      return failJson(c, 500, e instanceof EngineError ? e.message : String(e));
    }
    const saved = deps.providers.setDefaultModel(wanted);
    if (!saved.ok) return storeFail(c, saved);
    return c.json(deps.providers.response());
  });
  return route.id;
}

export function registerProviders(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerUpsert(app, deps, table), registerDelete(app, deps, table), registerTest(app, deps, table), registerModelsFetch(app, deps, table), registerDefault(app, deps, table)];
}
