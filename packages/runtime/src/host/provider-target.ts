/**
 * Startup provider-target resolution (W511) — the TS port of Rust
 * `providers::apply_startup_default` + `resolve_base_url` + `resolve_api_key`.
 *
 * providers.json is the operator's registry of upstreams; resolving a target
 * means answering three questions BEFORE the first compose (and again on every
 * generation swap, from the host's own profile):
 *
 *   model     `default_model` IS IN the models list of some provider -> that id
 *             ("providers.json default_model");
 *             else env `CELESTEA_MODEL` -> "env CELESTEA_MODEL";
 *             else whatever the caller's profile already carried
 *             ("profile default", i.e. the celestea.toml slot).
 *             An unlisted `default_model` never wins: the contract validates it
 *             against the provider rows instead of trusting a stale string.
 *   base_url  the provider that OWNS the resolved model, when its
 *             request_format is chat_completions and its base_url is non-empty
 *             (Rust writes it into the profile before compose);
 *             else env `CELESTEA_BASE_URL` -> else the profile's own base_url.
 *   api key   env[api_key_env] when non-empty; otherwise a plaintext key stored
 *             on the owning provider row is injected into the PROCESS ENV (the
 *             engine's only key channel, exactly like Rust's `env::set_var`).
 *             In-memory only: never written to a data file, never returned in a
 *             response, never logged.
 *
 * The module is store-free: it consumes the three `ProvidersStore` methods it
 * needs, so the rules are unit-testable without a data file.
 *
 * W747: moved verbatim from `apps/studio/src/runtime/provider-target.ts` into the
 * runtime's host layer (rules, export names and behaviour unchanged; the old
 * path is now a re-export shim). The ONE edit is the profile slice below: the
 * host view (`EngineProfile`) lives in `apps/studio/src/runtime-adapter.ts` and a
 * package may not import an app, so the three fields this module actually reads
 * are declared here as the minimal structural `ProfileSlot` that the host view
 * already satisfies. `applyProviderTarget` is generic in it, so a caller holding
 * an `EngineProfile` gets that exact type back.
 */

/** The startup-profile slice this module reads (satisfied by the host's view). */
export interface ProfileSlot {
  model: string;
  base_url: string;
  api_key_env: string;
}

/** The fields of a providers.json row this module reads. */
export interface ProviderRef {
  id: string;
  base_url: string;
  request_format: string;
  api_key: string | null;
  models: readonly { id: string }[];
}

/** The `ProvidersStore` slice this module needs. */
export interface ProviderLookup {
  rows(): readonly ProviderRef[];
  defaultModel(): string | null;
}

/** Where the resolved model id came from (reported by the startup log). */
export type ModelSource = "providers.json default_model" | "env CELESTEA_MODEL" | "profile default";
/**
 * Where the api key came from; "none" means unauthenticated requests.
 *
 * W747: named `ProviderKeySource` in the engine because `profile.ts` already
 * exports a `KeySource` — the Rust resolve_api_key ORDER (`env` / `api_key_file`
 * / `home_config` / `provider_store` / `borrowed_engine_key` / `none`), which is a
 * different, wider vocabulary. Two exports cannot share one name in a package's
 * single public API, and the host's narrower 3-value union is what the startup
 * log reports; the host-side shim re-exports it under its original name, so no
 * `apps/studio` import changed.
 */
export type ProviderKeySource = "env" | "provider_store" | "none";

export interface ProviderTarget {
  model: string;
  base_url: string;
  /** The provider row that lists `model` (null = no provider claims it). */
  provider_id: string | null;
  model_source: ModelSource;
  key_source: ProviderKeySource;
}

/** The request format that has a live adapter today (Rust `ENGINE_FORMAT`). */
export const CHAT_COMPLETIONS_FORMAT = "chat_completions";

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Every model id any provider row lists (the `default_model` allow-list). */
export function listedModelIds(lookup: ProviderLookup): Set<string> {
  const ids = new Set<string>();
  for (const p of lookup.rows()) for (const m of p.models) ids.add(m.id);
  return ids;
}

/** Resolve the model id + its source. Pure: no env mutation, no I/O. */
export function resolveModel(
  lookup: ProviderLookup,
  env: NodeJS.ProcessEnv,
  fallbackModel: string,
): { model: string; source: ModelSource } {
  const declared = trimmed(lookup.defaultModel());
  if (declared !== "" && listedModelIds(lookup).has(declared)) {
    return { model: declared, source: "providers.json default_model" };
  }
  const fromEnv = trimmed(env["CELESTEA_MODEL"]);
  if (fromEnv !== "") return { model: fromEnv, source: "env CELESTEA_MODEL" };
  return { model: fallbackModel, source: "profile default" };
}

/** The first provider row listing `model` (Rust `find_provider_with_model`). */
export function ownerOf(lookup: ProviderLookup, model: string): ProviderRef | null {
  for (const p of lookup.rows()) {
    if (p.models.some((m) => m.id === model)) return p;
  }
  return null;
}

/** Rust `resolve_base_url(profile, env)` restricted to the TS channels. */
export function resolveBaseUrl(owner: ProviderRef | null, env: NodeJS.ProcessEnv, profileBaseUrl: string): string {
  if (owner !== null && owner.request_format === CHAT_COMPLETIONS_FORMAT && trimmed(owner.base_url) !== "") {
    return owner.base_url;
  }
  const fromEnv = trimmed(env["CELESTEA_BASE_URL"]);
  return fromEnv === "" ? profileBaseUrl : fromEnv;
}

/**
 * The key to authenticate with: the deployment's env key wins, a keyless env
 * borrows the owning provider's stored key (injected into the process env by
 * the caller). Blank values never count as "configured".
 */
export function resolveProviderKey(
  owner: ProviderRef | null,
  env: NodeJS.ProcessEnv,
  apiKeyEnv: string,
): { key: string | null; source: ProviderKeySource } {
  if (trimmed(env[apiKeyEnv]) !== "") return { key: trimmed(env[apiKeyEnv]), source: "env" };
  const stored = trimmed(owner?.api_key);
  return stored === "" ? { key: null, source: "none" } : { key: stored, source: "provider_store" };
}

/** The three answers together, from the host's startup profile. */
export function resolveProviderTarget(
  lookup: ProviderLookup,
  env: NodeJS.ProcessEnv,
  base: ProfileSlot,
): ProviderTarget {
  const { model, source } = resolveModel(lookup, env, base.model);
  const owner = ownerOf(lookup, model);
  const { source: keySource } = resolveProviderKey(owner, env, base.api_key_env);
  return {
    model,
    base_url: resolveBaseUrl(owner, env, base.base_url),
    provider_id: owner?.id ?? null,
    model_source: source,
    key_source: keySource,
  };
}

/**
 * Apply a target to the startup profile and hand the secret to the process env.
 * The key is written to `env[api_key_env]` ONLY — the returned profile and every
 * log line stay key-free. Returns the profile plus the applied target.
 */
export function applyProviderTarget<P extends ProfileSlot>(
  base: P,
  target: ProviderTarget,
  lookup: ProviderLookup,
  env: NodeJS.ProcessEnv,
): { profile: P; target: ProviderTarget } {
  const owner = target.provider_id === null ? null : ownerOf(lookup, target.model);
  const { key, source } = resolveProviderKey(owner, env, base.api_key_env);
  if (key !== null) env[base.api_key_env] = key;
  return {
    profile: { ...base, model: target.model, base_url: target.base_url },
    target: { ...target, key_source: source },
  };
}
