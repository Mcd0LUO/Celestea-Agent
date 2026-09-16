/**
 * W835 (R3 batch C) — P1-3 on the REAL dispatch path.
 *
 * Source: W826-R3修复计划 §批次 C P1-3 verification probe: run the real
 * fallback decorator with the REAL UsageLedger as the step sink, have the inner
 * stream emit one usage frame and then suspend, let the consumer abandon it
 * after that first frame, and assert a ledger row is still written.
 *
 * The ledger is the real one (UsageLedgerFile + UsageLedger), written into a
 * throwaway directory; only the client seam is scripted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantText, userMessage } from "@celestea/llm";
import type { Llm, StreamEvent, Usage } from "@celestea/core";
import { createUsageLedger, createUsageLedgerFile, type UsageStepRecord } from "@celestea/runtime";
import type { Profile } from "@celestea/runtime";
import { createFallbackWiring } from "./fallback-host.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w835-llm-c-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = { model: "model-a", base_url: "https://a.example/v1", api_key_env: "CFG_KEY" } as unknown as Profile;
const REQ = { model: "", system: null, messages: [userMessage("hi")], tools: [], max_tokens: null, temperature: null };
const USAGE: Usage = {
  prompt_tokens: 11,
  completion_tokens: 4,
  total_tokens: 15,
  cache_read: 0,
  reasoning_tokens: 0,
};
const CONFIG = JSON.stringify({
  version: 1,
  enabled: true,
  targets: [{ name: "t1", provider: "p", model: "model-a" }],
  policy: { maxAttempts: 1 },
});

/** One usage frame, then a done the consumer never reads (it breaks first). */
function usageThenSuspend(usage: Usage): Llm {
  return {
    generate: async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        yield { kind: "usage", usage };
        yield { kind: "done", message: assistantText("not read") };
      },
    }),
  };
}

describe("W835 P1-3 — the real ledger books an abandoned fallback step", () => {
  it("writes one ok row with the usage when the consumer breaks after the usage frame", async () => {
    const dataDir = tempDir();
    const file = createUsageLedgerFile({ dataDir, env: {} });
    expect(file).not.toBeNull();
    const ledger = createUsageLedger({ session: "ws1/s1", file: file! });
    const wiring = createFallbackWiring({
      dataDir,
      env: { CELESTEA_LLM_FALLBACK: "on", CELESTEA_LLM_FALLBACKS: CONFIG },
      clientFor: () => usageThenSuspend(USAGE),
    });
    const inner = usageThenSuspend(USAGE);
    const llm = wiring.wrap({ inner, profile: PROFILE, sessionId: "ws1/s1", steps: ledger, provider: "prov-a" });
    expect(llm).not.toBeNull();

    let sawUsage = false;
    for await (const event of await llm!.generate(REQ)) {
      if (event.kind === "usage") {
        sawUsage = true;
        break;
      }
    }
    expect(sawUsage).toBe(true);

    ledger.endTurn("completed");
    const steps = file!.read().filter((r): r is UsageStepRecord => r.kind !== "turn_total");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "ok", attempt: 0, fallback_from: null });
    expect(steps[0]?.usage).toEqual(USAGE);
  });
});
