/**
 * Llm seam — port of `crates/core/src/llm.rs`.
 *
 * The seam is one async method: `generate` returns a stream of StreamEvents.
 * In Rust it returns `Result<LlmStream, LlmError>`; the TS mapping is a rejected
 * promise carrying [LlmError], so `try/catch` is the `Err` arm.
 *
 * `LlmRegistry` is the multi-provider seam (Rust W189): named, append-only rows
 * with last-registration-wins resolution, so compose code registers each
 * provider under a stable name and routes requests by name.
 */

import type { LlmStream, ModelRequest } from "./stream.js";
import { NamedRegistry } from "./plugin.js";

export interface Llm {
  generate(req: ModelRequest): Promise<LlmStream>;
}

/** Named registry of adapters; a later `register` of a name shadows the earlier. */
export class LlmRegistry {
  private readonly registry = new NamedRegistry<Llm>();

  register(name: string, llm: Llm): void {
    this.registry.insert(name, llm);
  }

  /** The adapter registered for `name` (last registration wins). */
  resolve(name: string): Llm | undefined {
    return this.registry.get(name);
  }

  /** Distinct names in first-registration order (a shadowed name listed once). */
  list(): string[] {
    const seen: string[] = [];
    for (const { name } of this.registry.entries()) if (!seen.includes(name)) seen.push(name);
    return seen;
  }
}

/** Well-known tokens for the Llm services in a Context. */
export const LLM_SERVICE = "celestea.core.Llm";
export const LLM_REGISTRY_SERVICE = "celestea.core.LlmRegistry";
