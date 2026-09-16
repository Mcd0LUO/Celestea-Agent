/**
 * W833 (R3 B8 / W816 F4) — the real adapter shutdown FLUSHES the fallback audit.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B8 W816 F4: production never flushed the fallback pending ledger, so a
 * SIGTERM dropped in-flight platform audit POSTs. The discriminator here is
 * deterministic: the audit endpoint holds the response; shutdown must stay
 * pending until it is released, then complete.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createOfflineLlm } from "./offline-llm.js";
import { createRealRuntimeAdapter } from "./real-runtime-adapter.js";

const CONFIG = JSON.stringify({
  version: 1,
  enabled: true,
  targets: [
    { name: "primary", provider: "prov-a", model: "model-a", baseUrl: "https://a.example/v1", apiKeyEnv: "W833_MISSING_KEY" },
  ],
  policy: { maxAttempts: 1, cooldownMs: 1000, failureThreshold: 1 },
});

const PROFILE = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  reasoning_effort: null,
  max_steps: 4096,
  max_parallel_tool_calls: 4,
  max_output_tokens: null,
  context_window: 1_000_000,
  system_prompt: "engine identity prompt",
};

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  return env;
}

let server: Server;
let port = 0;
let hits = 0;
const pending: { release: (() => void) | null } = { release: null };

/** Release the held audit response (called once the POST is in flight). */
function releaseAudit(): void {
  pending.release?.();
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    pending.release = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W833 B8/F4: adapter shutdown flushes the fallback audit", () => {
  it("stays pending until the in-flight platform audit POST completes", async () => {
    const out = mkdtempSync(join(tmpdir(), "w833-fallback-"));
    roots.push(out);
    hits = 0;
    pending.release = null;
    const env = cleanEnv();
    env["CELESTEA_LLM_FALLBACK"] = "on";
    env["CELESTEA_LLM_FALLBACKS"] = CONFIG;
    env["CELESTEA_AUDIT_URL"] = "http://127.0.0.1:" + port + "/api/audit";

    const adapter = createRealRuntimeAdapter({
      profile: PROFILE,
      env,
      llm: () => createOfflineLlm(),
      dataDir: out,
      resultsDir: join(out, "worker-results"),
    });

    const deadline = Date.now() + 3_000;
    while (hits === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(hits).toBeGreaterThanOrEqual(1); // one target_unavailable POST in flight

    let settled = false;
    const shutdown = adapter.shutdown().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false); // shutdown is AWAITING the POST
    releaseAudit();
    await shutdown;
    expect(settled).toBe(true);
  }, 20_000);
});
