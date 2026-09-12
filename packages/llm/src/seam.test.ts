/**
 * A1 (W746) — the seam vocabulary is core's, and it stays core's.
 *
 * These are not behaviour tests (the provider's behaviour is tested against the
 * mock upstream elsewhere); they are the A1 invariants that must not rot:
 *
 *   1. the re-exported VALUES are the same objects core exports, so
 *      `instanceof LlmError` agrees across packages (the whole point of A1);
 *   2. the provider's `StreamEvent` differs from core's in exactly ONE member
 *      (`failed.kindOf`), asserted at the type level — if core's union gains or
 *      loses a variant, the difference must still be that single member;
 *   3. the request draft accepts a fully-filled core `ModelRequest`.
 */

import { describe, expect, it } from "vitest";

import {
  LlmError as CoreLlmError,
  ROLES as CORE_ROLES,
  assistantText as coreAssistantText,
  messageToolCalls as coreMessageToolCalls,
  usageIsEmpty as coreUsageIsEmpty,
  userMessage as coreUserMessage,
  zeroUsage as coreZeroUsage,
  type LlmError as CoreLlmErrorType,
  type LlmRegistry as CoreLlmRegistryType,
  type ModelRequest,
  type StreamEvent as CoreStreamEvent,
  type Usage,
} from "@celestea/core";
import {
  LlmError,
  LlmRegistry,
  ROLES,
  assistantText,
  messageToolCalls,
  parseUsage,
  statusError,
  usageIsEmpty,
  userMessage,
  zeroUsage,
  type ModelRequestDraft,
  type StreamEvent,
} from "@celestea/llm";

/** Type-level equality (the standard invariant trick). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** The provider's union is core's union with exactly one widened member. */
const DELTA_IS_ONLY_THE_FAILED_MEMBER: Assert<
  Equal<Exclude<StreamEvent, { kind: "failed" }>, Exclude<CoreStreamEvent, { kind: "failed" }>>
> = true;

/** A fully-filled core request is a legal provider request (no adapter needed). */
const ENGINE_REQUEST_IS_A_DRAFT: Assert<Equal<ModelRequest extends ModelRequestDraft ? true : false, true>> = true;

describe("A1 · @celestea/llm re-exports core's seam instead of redeclaring it", () => {
  it("re-exports the same class object, so instanceof agrees across packages", () => {
    expect(LlmError).toBe(CoreLlmError);
    // Built here, recognised there — and the other way round.
    const mine: CoreLlmErrorType = statusError(500, "Internal Server Error", "boom");
    expect(mine).toBeInstanceOf(CoreLlmError);
    expect(mine).toBeInstanceOf(LlmError);
    const theirs = new CoreLlmError("from core");
    expect(theirs).toBeInstanceOf(LlmError);
  });

  it("re-exports the same message/usage helpers (identity, not a copy)", () => {
    expect(ROLES).toBe(CORE_ROLES);
    expect(userMessage).toBe(coreUserMessage);
    expect(assistantText).toBe(coreAssistantText);
    expect(messageToolCalls).toBe(coreMessageToolCalls);
    expect(zeroUsage).toBe(coreZeroUsage);
    expect(usageIsEmpty).toBe(coreUsageIsEmpty);
    expect(userMessage("hi")).toEqual(coreUserMessage("hi"));
  });

  it("re-exports core's LlmRegistry (one registry implementation, not two)", () => {
    const registry = new LlmRegistry();
    expect(registry).toBeInstanceOf(LlmRegistry);
    const asCore: CoreLlmRegistryType = registry;
    expect(asCore.list()).toEqual([]);
  });

  it("parses provider usage frames into core's Usage shape", () => {
    const usage: Usage | undefined = parseUsage({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1 },
    });
    expect(usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      cache_read: 1,
      reasoning_tokens: 0,
    });
  });

  it("keeps the one documented delta (failed.kindOf) exclusive to the provider", () => {
    expect(DELTA_IS_ONLY_THE_FAILED_MEMBER).toBe(true);
    expect(ENGINE_REQUEST_IS_A_DRAFT).toBe(true);
  });
});
