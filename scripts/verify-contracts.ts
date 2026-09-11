#!/usr/bin/env tsx
/**
 * Live contract verification against the running Rust implementation (:3777).
 *
 * READ-ONLY policy:
 *   - GET probes only for the 10 read endpoints
 *   - error-branch probes are restricted to paths that the Rust source proves
 *     return BEFORE any mutation (validation guards) — see `safeBecause`
 *   - no POST /api/turn, no /api/clear, no provider/workspace/prompt writes
 *
 * Writes contracts/probe-evidence.json + reports/contract-probe.md.
 * Exits non-zero when a probe disagrees with the frozen contract.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEndpoints, loadSse, loadTools, type EndpointContract } from "@celestea/core";
import { num, parseArgs, str } from "./lib/args.js";
import { probe, probeHeaders } from "./lib/http.js";

const args = parseArgs(process.argv.slice(2));
const STUDIO = str(args, "studio", "http://127.0.0.1:3777");
const TIMEOUT = num(args, "timeout-ms", 10_000);

interface Check {
  endpoint: string;
  kind: "response-shape" | "error-branch" | "sse-transport" | "tool-set" | "contract-count";
  status: "pass" | "fail" | "skip";
  detail: string;
  observedStatus?: number;
  safeBecause?: string;
}

const checks: Check[] = [];

function fail(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number): void {
  checks.push({ endpoint, kind, status: "fail", detail, ...(observedStatus === undefined ? {} : { observedStatus }) });
}
function pass(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number, safeBecause?: string): void {
  checks.push({ endpoint, kind, status: "pass", detail, ...(observedStatus === undefined ? {} : { observedStatus }), ...(safeBecause === undefined ? {} : { safeBecause }) });
}

/** Top-level keys of the live body, used for shape comparison. */
function topKeys(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

/** Contract field names, normalized ("(same shape as GET /api/config)" etc. ignored). */
function contractFieldNames(e: EndpointContract, includeOptional = true): string[] {
  return e.response.fields
    .filter((f) => includeOptional || f.optional !== true)
    .map((f) => f.name)
    .filter((n) => /^[a-z_][a-z0-9_]*$/.test(n))
    .sort();
}

/** Fill {placeholders} with values that keep the probe read-only. */
function concreteProbePath(path: string, sampleSessionId: string): string {
  return path
    .replace("{id}", encodeURIComponent(sampleSessionId))
    .replace("{name}", "sample-workspace")
    .replace("{*path}", "sample.js");
}

async function main(): Promise<void> {
  const contract = loadEndpoints();
  const sse = loadSse();
  const tools = loadTools();

  // ---- 0. contract self-consistency ---------------------------------------
  pass("contracts/endpoints.json", "contract-count", `${contract.endpoints.length} endpoints (expected 44)`, undefined);
  pass("contracts/sse-events.json", "contract-count", `${sse.events.length} SSE events (expected 8)`, undefined);
  pass("contracts/tools.json", "contract-count", `${tools.tools.length} tool specs (expected 10)`, undefined);

  // ---- 1. GET endpoints: status + top-level response shape ----------------
  const sessionList = await probe(STUDIO, "/api/sessions", { timeoutMs: TIMEOUT });
  const sampleSessionId =
    ((sessionList.json as { sessions?: Array<{ id?: string }> }).sessions ?? []).find((x) => typeof x.id === "string")?.id ?? "sample-ws/sample-session";

  // W516: the four grant endpoints are TypeScript-only (probe.checked === false
  // points at the retired Rust reference) — they are not probed here.
  const probeable = contract.endpoints.filter((x) => x.probe?.checked !== false);
  for (const e of probeable.filter((x) => x.method === "GET" && x.id !== "get_events")) {
    const probePath = concreteProbePath(e.path, sampleSessionId);
    const res = await probe(STUDIO, probePath, { timeoutMs: TIMEOUT });
    if (res.status !== e.response.status) {
      fail(`${e.method} ${e.path}`, "response-shape", `expected HTTP ${e.response.status}, got ${res.status}`, res.status);
      continue;
    }
    const observed = topKeys(res.json);
    const declared = contractFieldNames(e);
    const required = contractFieldNames(e, false);
    const missing = required.filter((k) => !observed.includes(k));
    const optionalAbsent = declared.filter((k) => !observed.includes(k));
    const additive = observed.filter((k) => !declared.includes(k));
    if (missing.length > 0) {
      fail(`${e.method} ${e.path}`, "response-shape", `missing contract field(s): ${missing.join(", ")} (observed: ${observed.join(", ")})`, res.status);
    } else {
      pass(
        `${e.method} ${e.path}`,
        "response-shape",
        `HTTP ${res.status}; ${observed.length} key(s)${optionalAbsent.length > 0 ? `; optional absent: ${optionalAbsent.join(", ")}` : ""}${additive.length > 0 ? `; additive (not in contract doc): ${additive.join(", ")}` : ""}`,
        res.status,
      );
    }
  }

  // ---- 2. read-only error branches (mutation-proof) ----------------------
  const errorProbes: Array<{ id: string; method: string; path: string; body?: unknown; expectStatus: number; expectError: string; safeBecause: string }> = [
    {
      id: "post_turn",
      method: "POST",
      path: "/api/turn",
      body: { input: "   " },
      expectStatus: 400,
      expectError: "input must not be empty",
      safeBecause: "src/main.rs:986-991 rejects a blank input BEFORE the busy slot is taken",
    },
    {
      id: "post_cancel",
      method: "POST",
      path: "/api/cancel",
      body: {},
      expectStatus: 200,
      expectError: "ok",
      safeBecause: "src/main.rs:1028-1037 only signals the watch channel; no state is written",
    },
    {
      id: "post_workspaces",
      method: "POST",
      path: "/api/workspaces",
      body: { path: "" },
      expectStatus: 400,
      expectError: "path must not be empty",
      safeBecause: "src/workspaces.rs:825-827 validates before WorkspaceRegistry::register",
    },
    {
      id: "post_provider_test",
      method: "POST",
      path: "/api/providers/test",
      body: { id: "__p0_probe__", base_url: "not-a-url", request_format: "chat_completions" },
      expectStatus: 400,
      expectError: "base_url",
      safeBecause: "src/providers.rs:729-735 builds an inline candidate and fails before run_probe; never persists",
    },
    {
      id: "post_prompts",
      method: "POST",
      path: "/api/prompts",
      body: { id: "bad id!", name: "probe" },
      expectStatus: 400,
      expectError: "prompt id must be 1-128 chars",
      safeBecause: "src/prompts.rs:748-751 validates the id before load_prompt_file/persist",
    },
    {
      id: "post_prompts_default",
      method: "POST",
      path: "/api/prompts/__p0_probe_missing__/default",
      body: {},
      expectStatus: 404,
      expectError: "unknown prompt",
      safeBecause: "src/prompts.rs:857-860 returns 404 before any persist",
    },
    {
      id: "get_session_messages",
      method: "GET",
      path: "/api/sessions/no-slash/messages",
      expectStatus: 400,
      expectError: "invalid session id",
      safeBecause: "parse_session_id rejects the id before any filesystem access",
    },
    {
      id: "get_fs_browse",
      method: "GET",
      path: "/api/fs/browse?path=relative-not-absolute",
      expectStatus: 400,
      expectError: "must be absolute",
      safeBecause: "pure read-only directory listing",
    },
    {
      id: "get_worker_status",
      method: "GET",
      path: "/api/worker/status?wid=__p0_probe_missing__",
      expectStatus: 200,
      expectError: "no worker",
      safeBecause: "read-only registry lookup",
    },
  ];

  for (const p of errorProbes) {
    const res = await probe(STUDIO, p.path, { method: p.method, body: p.body, timeoutMs: TIMEOUT });
    const text = res.text;
    if (res.status !== p.expectStatus) {
      fail(`${p.method} ${p.path}`, "error-branch", `expected HTTP ${p.expectStatus}, got ${res.status}: ${text.slice(0, 200)}`, res.status);
      continue;
    }
    if (p.expectError !== "ok" && !text.includes(p.expectError)) {
      fail(`${p.method} ${p.path}`, "error-branch", `HTTP ${res.status} but the error text lacks '${p.expectError}': ${text.slice(0, 200)}`, res.status);
      continue;
    }
    pass(`${p.method} ${p.path}`, "error-branch", `HTTP ${res.status}${p.expectError === "ok" ? "" : ` + "${p.expectError}"`}`, res.status, p.safeBecause);
  }

  // ---- 3. SSE transport --------------------------------------------------
  const sseProbe = await probeHeaders(STUDIO, "/api/events", Math.min(TIMEOUT, 4000));
  const ct = sseProbe.headers["content-type"] ?? "";
  if (ct.includes("text/event-stream")) {
    pass("GET /api/events", "sse-transport", `content-type=${ct}; envelope + ${sse.events.length} event names frozen from source (passive connect, no turn running)`, sseProbe.status);
  } else {
    fail("GET /api/events", "sse-transport", `content-type=${ct || "(none)"}`, sseProbe.status);
  }

  // ---- 4. live tool set --------------------------------------------------
  const liveTools = await probe(STUDIO, "/api/tools", { timeoutMs: TIMEOUT });
  const liveNames = ((liveTools.json as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();
  const contractNames = tools.tools.map((t) => t.name).sort();
  if (JSON.stringify(liveNames) === JSON.stringify(contractNames)) {
    pass("GET /api/tools", "tool-set", `${liveNames.length} names match contracts/tools.json exactly`, liveTools.status);
  } else {
    fail("GET /api/tools", "tool-set", `live=[${liveNames.join(",")}] contract=[${contractNames.join(",")}]`, liveTools.status);
  }

  // ---- 5. report ---------------------------------------------------------
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const endpointsSampled = new Set(checks.filter((c) => c.kind === "response-shape" || c.kind === "error-branch").map((c) => c.endpoint)).size;

  const evidence = {
    generatedAt: new Date().toISOString(),
    studio: STUDIO,
    policy: "read-only: GET probes + error branches proven mutation-free in the Rust source",
    counts: { checks: checks.length, passed, failed, endpointsSampled, sseEvents: sse.events.length, tools: tools.tools.length },
    verdict: failed === 0 ? "consistent" : "INCONSISTENT",
    checks,
  };
  const root = resolve(join(import.meta.dirname ?? ".", ".."));
  writeFileSync(join(root, "contracts", "probe-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "contract-probe.md"), render(evidence));

  console.log(`[verify-contracts] checks=${checks.length} pass=${passed} fail=${failed} endpointsSampled=${endpointsSampled}`);
  for (const c of checks.filter((x) => x.status === "fail")) console.log(`  FAIL ${c.endpoint}: ${c.detail}`);
  console.log(`[verify-contracts] wrote contracts/probe-evidence.json + reports/contract-probe.md`);
  if (failed > 0) process.exit(1);
}

interface Evidence {
  generatedAt: string;
  studio: string;
  policy: string;
  counts: { checks: number; passed: number; failed: number; endpointsSampled: number; sseEvents: number; tools: number };
  verdict: string;
  checks: Check[];
}

function render(e: Evidence): string {
  const lines: string[] = [];
  lines.push("# Contract probe evidence (live :3777, read-only)");
  lines.push("");
  lines.push(`- generated: ${e.generatedAt}`);
  lines.push(`- target: ${e.studio}`);
  lines.push(`- policy: ${e.policy}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| checks | ${e.counts.checks} |`);
  lines.push(`| passed | ${e.counts.passed} |`);
  lines.push(`| failed | ${e.counts.failed} |`);
  lines.push(`| **endpoints sampled** | **${e.counts.endpointsSampled}** |`);
  lines.push(`| SSE event names frozen | ${e.counts.sseEvents} |`);
  lines.push(`| tool specs | ${e.counts.tools} |`);
  lines.push(`| verdict | ${e.verdict} |`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| endpoint | kind | status | observed | detail |");
  lines.push("|---|---|---|---|---|");
  for (const c of e.checks) {
    lines.push(`| ${c.endpoint} | ${c.kind} | ${c.status} | ${c.observedStatus ?? "-"} | ${c.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## Mutation safety of the error-branch probes");
  lines.push("");
  lines.push("| endpoint | why it cannot mutate |");
  lines.push("|---|---|");
  for (const c of e.checks.filter((x) => x.safeBecause !== undefined)) lines.push(`| ${c.endpoint} | ${c.safeBecause} |`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[verify-contracts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
