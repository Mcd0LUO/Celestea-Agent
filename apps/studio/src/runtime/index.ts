/**
 * The real engine assembly of `apps/studio` (P5 integration).
 *
 * `createRealRuntimeAdapter` is the production `RuntimeAdapter`: it composes
 * `packages/runtime` (real agent loop + real tool registry + real session log)
 * with an OFFLINE `Llm` seam, so the whole HTTP contract can be exercised end to
 * end without a provider. The P4 fake adapter stays in
 * `../fake-runtime-adapter.ts` for deterministic HTTP-layer tests.
 */

export * from "./engine-profile.js";
export * from "./engine-session.js";
export * from "./engine-plugins.js";
export * from "./offline-llm.js";
export * from "./worker-bridge.js";
export * from "./real-runtime-adapter.js";
