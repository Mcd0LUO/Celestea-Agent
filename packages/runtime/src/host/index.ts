/**
 * W747 — the host layer of the engine assembly.
 *
 * The engine's true composition root used to live entirely in `apps/studio`
 * (`apps/studio/src/runtime/**`, ~2500 lines): profile resolution, provider
 * targeting, session-log binding, tool/sandbox/guard assembly, grants policy.
 * `@celestea/runtime` only mounted plugins. W732 §A2 / §F1 flagged that as the
 * largest gap between the documented layering and the code, so the engine-side
 * half moves here, one bounded cut at a time.
 *
 * Rules for this layer:
 *   1. `packages/*` may never import `apps/*` (dependency-cruiser
 *      `no-packages-to-apps`): a module only moves here once it depends on
 *      nothing but `@celestea/core`, the L1 packages and `../` internals.
 *   2. The host keeps its HTTP shapes and its data files. When a module needs a
 *      host-owned type, the MINIMAL structural slice it reads is declared here
 *      (see `ProfileSlot` in `provider-target.ts`) — never a copy of the host
 *      view, and never a host import.
 *   3. Nothing is re-written while moving: behaviour, export names and error
 *      text stay byte-identical, and the old `apps/studio/src/runtime/<mod>.ts`
 *      path stays alive as a re-export shim so existing imports do not break.
 *
 * These modules are NOT a package subpath: everything below is re-exported by
 * `../index.ts`, the package's only public API (cross-package deep imports are
 * forbidden by `dependency-cruiser` and ESLint). A subpath export would need an
 * exception in `.dependency-cruiser.cjs`; that is a separate decision.
 *
 * Moved so far (W747, first cut):
 *   engine-session.ts  log/binding assembly + the `<ws>/<session>` id helper
 *   provider-target.ts startup model/base_url/api-key resolution (W511)
 * Still in `apps/studio/src/runtime/` and blocked — see the W747 report:
 *   engine-profile.ts  needs `EngineProfile`/`ProfilePatch` (apps runtime-adapter)
 *                      and `MIN_STEPS`/`CONTEXT_WINDOW` (apps config)
 *   engine-plugins.ts  needs `@celestea/tools` in packages/runtime/package.json
 *   llm-assembly.ts    needs `@celestea/llm` in packages/runtime/package.json
 *   session-compose.ts needs `CapacityError` (apps runtime-adapter) + the above
 */

export * from "./engine-session.js";
export * from "./provider-target.js";
