#!/usr/bin/env tsx
/**
 * Live contract verification against the running backend (:3777).
 *
 * READ-ONLY policy:
 *   - GET probes only for the 10 read endpoints
 *   - error-branch probes are restricted to paths that the retired backend source proves
 *     return BEFORE any mutation (validation guards) — see `safeBecause`
 *   - no POST /api/turn, no /api/clear, no provider/workspace/prompt writes
 *
 * Writes contracts/probe-evidence.json + reports/contract-probe.md.
 * Exits 1 when a probe disagrees with the frozen contract, 2 when a face could
 * not be probed at all (degraded; recorded, never a silent pass).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEndpoints, loadSse, loadTools, type EndpointContract } from "@celestea/core";
import { num, parseArgs, str } from "./lib/args.js";
import { probe, probeHeaders, type ProbeResult } from "./lib/http.js";

const args = parseArgs(process.argv.slice(2));
const STUDIO = str(args, "studio", "http://127.0.0.1:3777");
const TIMEOUT = num(args, "timeout-ms", 10_000);

interface Check {
  endpoint: string;
  kind: "response-shape" | "error-branch" | "sse-transport" | "tool-set" | "contract-count";
  status: "pass" | "fail" | "skip" | "degraded";
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
function degraded(endpoint: string, kind: Check["kind"], detail: string, observedStatus?: number): void {
  checks.push({ endpoint, kind, status: "degraded", detail, ...(observedStatus === undefined ? {} : { observedStatus }) });
}

/**
 * Section 4 -- session-explicit tool faces (W803 probe follow-up).
 *
 * A bare GET /api/tools answers for the FOCUSED/active session, whose mode can
 * drift (an execution session folds the face to 6), while contracts/tools.json is
 * the full registry (11). So name the session explicitly, one probe per face:
 *   - mode=standard  -> MUST equal the full registry exactly (11 names);
 *   - mode=execution -> MUST be the documented fold: exactly 6, a subset of the
 *     registry, folding out the four SDK bridge tools + ask_user_question
 *     (contracts/endpoints.json#get_tools, W791 P1).
 */
async function probeToolFaces(
  sessions: Array<{ id: string; mode?: string }>,
  contractNames: string[],
): Promise<void> {
  const standardSession = sessions.find((s) => s.mode === "standard");
  const executionSession = sessions.find((s) => s.mode === "execution");
  const contractSet = new Set(contractNames);
  const EXPECTED_FOLDED = ["ask_user_question", "list_dir", "read_file", "run_shell", "write_file"].sort();

  async function toolNamesFor(sessionId: string): Promise<{ names: string[]; status: number }> {
    const res = await probe(STUDIO, "/api/tools?session=" + encodeURIComponent(sessionId), { timeoutMs: TIMEOUT });
    const names = (((res.json as { tools?: Array<{ name: string }> }).tools) ?? []).map((t) => t.name).sort();
    return { names, status: res.status };
  }
  function sameNames(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((n, i) => n === b[i]);
  }
  const STANDARD_LABEL = "GET /api/tools?session=...(standard)";
  const EXECUTION_LABEL = "GET /api/tools?session=...(execution)";

  if (standardSession !== undefined) {
    const r = await toolNamesFor(standardSession.id);
    if (sameNames(r.names, contractNames)) {
      pass(STANDARD_LABEL, "tool-set", "session=" + standardSession.id + " (mode=standard); " + r.names.length + " names match contracts/tools.json exactly (full registry)", r.status);
    } else {
      fail(STANDARD_LABEL, "tool-set", "session=" + standardSession.id + " (mode=standard); live=[" + r.names.join(",") + "] contract=[" + contractNames.join(",") + "]", r.status);
    }
  } else {
    // No standard session: the primary equality assertion cannot run. Degrade
    // EXPLICITLY and recordably -- assert the weaker contract-superset-live
    // invariant, mark the check degraded (never a silent pass) and exit 2. A
    // live name outside the contract is still a hard fail.
    const fallback = sessions.find((s) => s.mode !== "execution");
    if (fallback === undefined) {
      degraded(STANDARD_LABEL, "tool-set", "DEGRADED: /api/sessions lists " + sessions.length + " session(s), none with mode=standard; the full-registry equality could not be asserted at all");
    } else {
      const r = await toolNamesFor(fallback.id);
      const outside = r.names.filter((n) => !contractSet.has(n));
      if (outside.length === 0) {
        degraded(STANDARD_LABEL, "tool-set", "DEGRADED: no mode=standard session in /api/sessions (" + sessions.length + " listed); asserted the weaker invariant contract superset-of live (" + r.names.length + " live <= " + contractNames.length + " contract) via session=" + fallback.id + " mode=" + (fallback.mode ?? "unknown") + "; activate a standard session to restore exact-equality", r.status);
      } else {
        fail(STANDARD_LABEL, "tool-set", "no mode=standard session AND live reports name(s) outside the contract: [" + outside.join(",") + "]", r.status);
      }
    }
  }

  if (executionSession !== undefined) {
    const r = await toolNamesFor(executionSession.id);
    const outside = r.names.filter((n) => !contractSet.has(n));
    const folded = contractNames.filter((n) => !r.names.includes(n));
    const problems: string[] = [];
    if (r.names.length !== 6) problems.push("expected exactly 6 names, got " + r.names.length);
    if (outside.length > 0) problems.push("name(s) outside the contract: [" + outside.join(",") + "]");
    if (!sameNames(folded, EXPECTED_FOLDED)) problems.push("folded-out=[" + folded.join(",") + "] expected=[" + EXPECTED_FOLDED.join(",") + "]");
    const base = "session=" + executionSession.id + " (mode=execution); live=[" + r.names.join(",") + "] folded-out=[" + folded.join(",") + "]";
    if (problems.length === 0) {
      pass(EXECUTION_LABEL, "tool-set", base + "; exactly 6: the full registry folded by the four SDK bridge tools + ask_user_question", r.status);
    } else {
      fail(EXECUTION_LABEL, "tool-set", base + "; " + problems.join("; "), r.status);
    }
  } else {
    degraded(EXECUTION_LABEL, "tool-set", "DEGRADED: no mode=execution session in /api/sessions (" + sessions.length + " listed); the folded face could not be probed. The bare GET /api/tools answer follows the active session's mode, which is why this probe is session-explicit");
  }
}

/**
 * W767 added two TypeScript-only endpoints that are not plain JSON GETs, so a
 * generic top-level-key comparison misreports both. Each gets its own honest
 * assertion instead of a silent skip: /login is HTML, and /auth/check is
 * cookie-gated — with no cookie the documented 401 branch IS the answer.
 */
const BESPOKE_GET: Record<string, (res: ProbeResult) => { ok: boolean; detail: string }> = {
  get_login: (res) => ({
    ok: res.status === 200 && (res.headers["content-type"] ?? "").includes("text/html"),
    detail: `HTTP ${res.status}; HTML login page (${(res.headers["content-type"] ?? "no content-type").split(";")[0]}) — no JSON keys to compare`,
  }),
  get_auth_check: (res) => ({
    ok: res.status === 401 && res.text.includes("unauthorized"),
    detail: `HTTP ${res.status}; cookie-gated, so the documented 401 "unauthorized" branch is the correct answer for an unauthenticated probe`,
  }),
};

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
  // NOTE: loadEndpoints()/loadSse()/loadTools() already THROW on a count
  // mismatch, so these lines record the frozen count as evidence; the numbers
  // come from the contracts themselves (never a hard-coded literal that can
  // silently rot).
  pass("contracts/endpoints.json", "contract-count", `${contract.endpoints.length} endpoints (contract declares ${contract.count})`, undefined);
  pass("contracts/sse-events.json", "contract-count", `${sse.events.length} SSE events (contract declares ${sse.count})`, undefined);
  pass("contracts/tools.json", "contract-count", `${tools.tools.length} tool specs (contract declares ${tools.count})`, undefined);

  // ---- 1. GET endpoints: status + top-level response shape ----------------
  const sessionList = await probe(STUDIO, "/api/sessions", { timeoutMs: TIMEOUT });
  const sampleSessionId =
    ((sessionList.json as { sessions?: Array<{ id?: string }> }).sessions ?? []).find((x) => typeof x.id === "string")?.id ?? "sample-ws/sample-session";

  // W516: the four grant endpoints are TypeScript-only (probe.checked === false
  // points at the retired backend) — they are not probed here.
  const probeable = contract.endpoints.filter((x) => x.probe?.checked !== false);
  for (const e of probeable.filter((x) => x.method === "GET" && x.id !== "get_events")) {
    const probePath = concreteProbePath(e.path, sampleSessionId);
    const res = await probe(STUDIO, probePath, { timeoutMs: TIMEOUT });
    const bespoke = BESPOKE_GET[e.id];
    if (bespoke) {
      const b = bespoke(res);
      if (b.ok) pass(`${e.method} ${e.path}`, "response-shape", b.detail, res.status);
      else fail(`${e.method} ${e.path}`, "response-shape", b.detail, res.status);
      continue;
    }
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

  // ---- 4. live tool set (session-explicit; W803 probe follow-up) ----------
  const sessions = (((sessionList.json as { sessions?: Array<{ id?: string; mode?: string }> }).sessions) ?? [])
    .filter((s): s is { id: string; mode?: string } => typeof s.id === "string");
  const contractNames = tools.tools.map((t) => t.name).sort();
  await probeToolFaces(sessions, contractNames);

  // ---- 5. report ---------------------------------------------------------
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const degradedCount = checks.filter((c) => c.status === "degraded").length;
  const endpointsSampled = new Set(checks.filter((c) => c.kind === "response-shape" || c.kind === "error-branch").map((c) => c.endpoint)).size;

  const evidence = {
    generatedAt: new Date().toISOString(),
    studio: STUDIO,
    policy: "read-only: GET probes + error branches proven mutation-free in the retired backend source",
    counts: { checks: checks.length, passed, failed, degraded: degradedCount, endpointsSampled, sseEvents: sse.events.length, tools: tools.tools.length },
    verdict: failed > 0 ? "INCONSISTENT" : degradedCount > 0 ? "DEGRADED" : "consistent",
    checks,
  };
  const root = resolve(join(import.meta.dirname ?? ".", ".."));
  writeFileSync(join(root, "contracts", "probe-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "contract-probe.md"), render(evidence));

  console.log("[verify-contracts] checks=" + checks.length + " pass=" + passed + " fail=" + failed + " degraded=" + degradedCount + " endpointsSampled=" + endpointsSampled);
  for (const c of checks.filter((x) => x.status === "fail")) console.log("  FAIL " + c.endpoint + ": " + c.detail);
  for (const c of checks.filter((x) => x.status === "degraded")) console.log("  DEGRADED " + c.endpoint + ": " + c.detail);
  console.log("[verify-contracts] wrote contracts/probe-evidence.json + reports/contract-probe.md");
  if (failed > 0) process.exit(1);
  if (degradedCount > 0) process.exit(2);
}

interface Evidence {
  generatedAt: string;
  studio: string;
  policy: string;
  counts: { checks: number; passed: number; failed: number; degraded: number; endpointsSampled: number; sseEvents: number; tools: number };
  verdict: string;
  checks: Check[];
}

function render(e: Evidence): string {
  const lines: string[] = [];
  lines.push("# Contract probe evidence (live :3777, read-only)");
  lines.push("");
  lines.push("- generated: " + e.generatedAt);
  lines.push("- target: " + e.studio);
  lines.push("- policy: " + e.policy);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|---|---|");
  lines.push("| checks | " + e.counts.checks + " |");
  lines.push("| passed | " + e.counts.passed + " |");
  lines.push("| failed | " + e.counts.failed + " |");
  lines.push("| degraded | " + e.counts.degraded + " |");
  lines.push("| **endpoints sampled** | **" + e.counts.endpointsSampled + "** |");
  lines.push("| SSE event names frozen | " + e.counts.sseEvents + " |");
  lines.push("| tool specs | " + e.counts.tools + " |");
  lines.push("| verdict | " + e.verdict + " |");
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| endpoint | kind | status | observed | detail |");
  lines.push("|---|---|---|---|---|");
  for (const c of e.checks) {
    lines.push("| " + c.endpoint + " | " + c.kind + " | " + c.status + " | " + (c.observedStatus ?? "-") + " | " + c.detail.replace(/\|/g, "\\|") + " |");
  }
  lines.push("");
  lines.push("## Mutation safety of the error-branch probes");
  lines.push("");
  lines.push("| endpoint | why it cannot mutate |");
  lines.push("|---|---|");
  for (const c of e.checks.filter((x) => x.safeBecause !== undefined)) lines.push("| " + c.endpoint + " | " + c.safeBecause + " |");
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[verify-contracts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
