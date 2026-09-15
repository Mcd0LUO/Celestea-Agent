/**
 * E §4.4 acceptance: D6 — one user intent that cost three attempts is THREE
 * ledger rows (503 / idle timeout / ok) with `attempt` 0/1/2 and the
 * `fallback_from` chain intact, plus the D9 half that matters to the account:
 * switched off, the same call books exactly one row.
 *
 * The ledger here is the REAL one (`UsageLedgerFile` + `UsageLedger`), written
 * into a throwaway directory; only the two seams are injected, so nothing
 * touches a provider or a production data file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantText, statusError, userMessage } from "@celestea/llm";
// The decorator lives on the PROVIDER seam, which is the only seam whose
// `failed` union can carry `kindOf:"timeout"` (see llm-assembly.ts).
import type { StreamEvent, Usage } from "@celestea/llm";
import type { Llm } from "@celestea/core";
import { createLedgerLlm, createUsageLedger, createUsageLedgerFile, type UsageLedgerRecord, type UsageStepRecord } from "@celestea/runtime";
import type { Profile } from "@celestea/runtime";
import { createFallbackWiring } from "./fallback-host.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w785-ledger-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILE = { model: "model-a", base_url: "https://a.example/v1", api_key_env: "CFG_KEY" } as unknown as Profile;
/** `model: ""` = "the seam's configured model wins" (the production call shape). */
const REQ = { model: "", system: null, messages: [userMessage("hi")], tools: [], max_tokens: null, temperature: null };
const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  cache_read: 0,
  reasoning_tokens: 0,
};

function okStream(text: string, usage: Usage = USAGE): StreamEvent[] {
  return [
    { kind: "text", text },
    { kind: "usage", usage },
    { kind: "done", message: assistantText(text) },
  ];
}

/** A provider-seam script re-typed as the core seam the host hands around. */
function events(plan: StreamEvent[]): Llm {
  const seam = {
    generate: async (): Promise<AsyncIterable<StreamEvent>> => ({
      async *[Symbol.asyncIterator]() {
        for (const e of plan) yield e;
      },
    }),
  };
  return seam as unknown as Llm;
}

function scripted(plan: { error?: unknown; events?: StreamEvent[] }): Llm {
  return plan.error === undefined ? events(plan.events ?? []) : ({ generate: async () => Promise.reject(plan.error) } as unknown as Llm);
}

const CONFIG = JSON.stringify({
  version: 1,
  enabled: true,
  targets: [
    { name: "t1", provider: "p", model: "model-a" },
    { name: "t2", provider: "p", model: "model-b" },
    { name: "t3", provider: "p", model: "model-c" },
  ],
  policy: { maxAttempts: 3 },
});

describe("D6 — three attempts, three rows", () => {
  it("books 2 error rows + 1 ok row with attempt 0/1/2 and the fallback_from chain", async () => {
    const dataDir = tempDir();
    const file = createUsageLedgerFile({ dataDir, env: {} });
    expect(file).not.toBeNull();
    const ledger = createUsageLedger({ session: "ws1/s1", file: file! });
    const wiring = createFallbackWiring({
      dataDir,
      env: { CELESTEA_LLM_FALLBACK: "on", CELESTEA_LLM_FALLBACKS: CONFIG },
      clientFor: (target) => {
        if (target.name === "t1") return scripted({ error: statusError(503, "Service Unavailable", "no") });
        if (target.name === "t2") {
          return events([{ kind: "failed", kindOf: "timeout", message: "llm timeout: stream idle timeout: no data chunk for 90ms" }]);
        }
        return events(okStream("Hello"));
      },
    });

    const llm = wiring.wrap({ inner: events(okStream("never")), profile: PROFILE, sessionId: "ws1/s1", steps: ledger, provider: "prov-a" });
    for await (const _event of await (llm as Llm).generate(REQ)) void _event;
    ledger.endTurn("completed");

    const rows = file!.read();
    const steps = rows.filter((r): r is UsageStepRecord => r.kind !== "turn_total");
    expect(steps.map((r) => [r.kind, r.attempt, r.fallback_from, r.model])).toEqual([
      ["error", 0, null, "model-a"],
      ["error", 1, "t1", "model-b"],
      ["ok", 2, "t2", "model-c"],
    ]);
    expect(steps[0]?.http_status).toBe(503);
    expect(steps[0]?.billed_unknown).toBe(true);
    expect(steps[1]?.error_kind).toBe("timeout");
    expect(steps[2]?.usage).toEqual(USAGE);

    const total = rows.find((r: UsageLedgerRecord) => r.kind === "turn_total");
    expect(total?.kind === "turn_total" && total.attempts).toBe(3);
    expect(total?.kind === "turn_total" && total.steps).toBe(3);
    expect(ledger.total().prompt_tokens).toBe(100);
  });
});

describe("D9 — switched off, the ledger is what it always was", () => {
  it("books exactly one row with attempt 0 and no fallback_from", async () => {
    const dataDir = tempDir();
    const file = createUsageLedgerFile({ dataDir, env: {} });
    const ledger = createUsageLedger({ session: "ws1/s1", file: file! });
    const llm = createLedgerLlm({
      inner: events(okStream("one call")),
      sink: ledger,
      provider: "prov-a",
      model: "model-a",
      base_url_host: "a.example",
    });
    for await (const _event of await llm.generate(REQ)) void _event;

    const steps = file!.read().filter((r): r is UsageStepRecord => r.kind !== "turn_total");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "ok", attempt: 0, fallback_from: null, model: "model-a" });
  });
});
