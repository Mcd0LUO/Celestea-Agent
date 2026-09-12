/**
 * W747 compat shim — this module moved to the runtime's host layer:
 * `packages/runtime/src/host/provider-target.ts` (exported as `@celestea/runtime`).
 *
 * The rules, the export names and the error text are unchanged; a caller migrates
 * by deleting its import, not by editing the engine. `ProfileSlot` (the minimal
 * structural profile slice, added by the move) is deliberately NOT re-exported
 * here: this path's export surface stays exactly what it was.
 */

export {
  CHAT_COMPLETIONS_FORMAT,
  applyProviderTarget,
  listedModelIds,
  ownerOf,
  resolveBaseUrl,
  resolveModel,
  resolveProviderKey,
  resolveProviderTarget,
  type ProviderKeySource as KeySource,
  type ModelSource,
  type ProviderLookup,
  type ProviderRef,
  type ProviderTarget,
} from "@celestea/runtime";
