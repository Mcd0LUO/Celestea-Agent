#!/usr/bin/env tsx
/**
 * Replay comparison harness (P0 skeleton).
 *
 * Reads fixtures/ -> replays every session through the TS implementation ->
 * writes a structured diff report to reports/.
 *
 * Compared:
 *   A. Studio messages projection  vs GET /api/sessions/{id}/messages (GOLDEN, from Rust)
 *   B. engine derive_messages      vs the TS-derived expectation (self-consistency; P1 makes it golden)
 *   C. SSE transcript              vs the stored derivation (determinism)
 *   D. providers public_view       vs the api_key-free contract
 *   E. registry.tsv round-trip     vs the stored parse
 *
 * `--strict` exits non-zero when a GOLDEN comparison (A) diverges.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firstJsonDiff } from "@celestea/core";
import { analyzeReplay, deriveMessages, deriveSseTranscript, parseSessionJsonl, projectMessages } from "@celestea/session";
import { parseRegistryTsv, serializeRegistryTsv, summarize } from "@celestea/workers";
import { bool, num, parseArgs, str } from "./lib/args.js";

const args = parseArgs(process.argv.slice(2));
const FIXTURES = resolve(str(args, "fixtures", "fixtures"));
const REPORTS = resolve(str(args, "reports", "reports"));
const STRICT = bool(args, "strict");
const MAX_SHOWN = num(args, "max-diffs", 5);

interface Finding {
  scope: string;
  kind: "golden-divergence" | "self-check-divergence" | "info" | "error";
  detail: string;
}

interface SessionReport {
  id: string;
  slug: string;
  roles: string[];
  events: number;
  turns: number;
  danglingToolCalls: number;
  orphanToolResults: number;
  subCalls: number;
  tornTail: boolean;
  turnIdMonotonic: boolean;
  outcomes: Record<string, number>;
  messages: { golden: number; actual: number; divergences: number };
  derived: { expected: number; actual: number; divergences: number };
  sse: { expected: number; actual: number; divergences: number };
  goldenVerdict: "match" | "divergence";
}

const findings: Finding[] = [];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function compareLists(scope: string, expected: readonly unknown[], actual: readonly unknown[], kind: Finding["kind"]): number {
  let divergences = 0;
  if (expected.length !== actual.length) {
    findings.push({ scope, kind, detail: `length ${expected.length} != ${actual.length}` });
    divergences += 1;
  }
  const n = Math.min(expected.length, actual.length);
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const d = firstJsonDiff(expected[i], actual[i], `$[${i}]`);
    if (d === null) continue;
    divergences += 1;
    if (shown < MAX_SHOWN) {
      findings.push({ scope, kind, detail: d });
      shown += 1;
    }
  }
  if (divergences > shown) findings.push({ scope, kind, detail: `... and ${divergences - shown} more divergence(s) suppressed` });
  return divergences;
}

function main(): void {
  if (!existsSync(FIXTURES)) {
    throw new Error(`fixtures directory not found: ${FIXTURES} (run \`pnpm golden:export\` first)`);
  }
  mkdirSync(REPORTS, { recursive: true });
  const manifest = readJson<{ generatedAt: string; sessions: Array<{ id: string; slug: string; roles: string[] }> }>(
    join(FIXTURES, "index.json"),
  );

  const sessions: SessionReport[] = [];

  for (const entry of manifest.sessions) {
    const dir = join(FIXTURES, "sessions", entry.slug);
    const parsed = parseSessionJsonl(readFileSync(join(dir, "cli-main.jsonl"), "utf8"));
    const stats = analyzeReplay(parsed);
    const actualMessages = projectMessages(parsed.events);
    const golden = readJson<{ messages: unknown[] }>(join(dir, "messages-expected.json")).messages;
    const msgDiv = compareLists(`${entry.id} :: messages-projection`, golden, actualMessages, "golden-divergence");

    const derivedExpected = readJson<{ messages: unknown[] }>(join(dir, "derive-messages-expected.json")).messages;
    const actualDerived = deriveMessages(parsed.events);
    const derivedDiv = compareLists(`${entry.id} :: derive-messages`, derivedExpected, actualDerived, "self-check-divergence");

    const ssePath = join(dir, "sse-transcript-derived.jsonl");
    let sseDiv = 0;
    let sseCount = 0;
    if (existsSync(ssePath)) {
      const sseExpected = readFileSync(ssePath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as unknown);
      const actualSse = deriveSseTranscript(parsed.events) as unknown[];
      sseCount = actualSse.length;
      sseDiv = compareLists(`${entry.id} :: sse-transcript`, sseExpected, actualSse, "self-check-divergence");
    } else {
      findings.push({
        scope: `${entry.id} :: sse-transcript`,
        kind: "info",
        detail: "derived transcript not stored (large session); regenerated in-memory for this run",
      });
      sseCount = deriveSseTranscript(parsed.events).length;
    }

    sessions.push({
      id: entry.id,
      slug: entry.slug,
      roles: entry.roles,
      events: parsed.events.length,
      turns: stats.turnStarts,
      danglingToolCalls: stats.danglingToolCalls.length,
      orphanToolResults: stats.orphanToolResults.length,
      subCalls: stats.subCalls,
      tornTail: stats.tornTail !== null,
      turnIdMonotonic: stats.turnIds.nonMonotonic.length === 0 && stats.turnIds.duplicates.length === 0,
      outcomes: stats.outcomes,
      messages: { golden: golden.length, actual: actualMessages.length, divergences: msgDiv },
      derived: { expected: derivedExpected.length, actual: actualDerived.length, divergences: derivedDiv },
      sse: { expected: sseCount, actual: sseCount, divergences: sseDiv },
      goldenVerdict: msgDiv === 0 ? "match" : "divergence",
    });
  }

  // D. providers public_view must stay api_key-free
  const providersPath = join(FIXTURES, "providers", "public-view.json");
  let providerCount = 0;
  if (existsSync(providersPath)) {
    const text = readFileSync(providersPath, "utf8");
    if (text.includes('"api_key"')) findings.push({ scope: "providers public_view", kind: "error", detail: 'contains the string "api_key"' });
    const body = readJson<{ body: { providers: Array<Record<string, unknown>> } }>(providersPath).body;
    providerCount = body.providers.length;
    const allowed = new Set(["id", "name", "note", "base_url", "request_format", "models", "is_default", "has_key"]);
    for (const p of body.providers) {
      for (const k of Object.keys(p)) if (!allowed.has(k)) findings.push({ scope: `providers public_view ${String(p["id"])}`, kind: "error", detail: `unexpected key '${k}'` });
    }
    findings.push({ scope: "providers public_view", kind: "info", detail: `${providerCount} provider(s), 0 api_key keys` });
  }

  // E. registry.tsv round-trip
  const registryTsv = join(FIXTURES, "workers", "registry.tsv");
  let registryRows = 0;
  if (existsSync(registryTsv)) {
    const raw = readFileSync(registryTsv, "utf8");
    const reparsed = parseRegistryTsv(raw);
    registryRows = reparsed.entries.length;
    const stored = readJson<{ entries: unknown[]; summary: unknown }>(join(FIXTURES, "workers", "registry-parsed.json"));
    compareLists("registry.tsv :: parse", stored.entries, reparsed.entries, "self-check-divergence");
    const roundTrip = serializeRegistryTsv(reparsed.entries);
    if (roundTrip !== raw) findings.push({ scope: "registry.tsv :: round-trip", kind: "self-check-divergence", detail: "serialize(parse(x)) != x" });
    const sum = summarize(reparsed.entries);
    findings.push({ scope: "registry.tsv", kind: "info", detail: `${registryRows} row(s) by_status=${JSON.stringify(sum.by_status)}` });
  }

  const goldenDivergences = sessions.reduce((n, s) => n + s.messages.divergences, 0);
  const selfDivergences = sessions.reduce((n, s) => n + s.derived.divergences + s.sse.divergences, 0);
  const errors = findings.filter((f) => f.kind === "error").length;

  const report = {
    generatedAt: new Date().toISOString(),
    fixtures: FIXTURES,
    fixturesGeneratedAt: manifest.generatedAt,
    strict: STRICT,
    summary: {
      sessions: sessions.length,
      goldenComparisons: sessions.length,
      goldenDivergences,
      selfCheckDivergences: selfDivergences,
      errors,
      verdict: errors > 0 ? "error" : goldenDivergences > 0 ? "divergence" : "match",
    },
    sessions,
    findings,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(REPORTS, "replay-diff.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(REPORTS, `replay-diff-${stamp}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(REPORTS, "replay-diff.md"), renderMarkdown(report));

  console.log(`[compare-replay] sessions=${sessions.length} goldenDivergences=${goldenDivergences} selfCheckDivergences=${selfDivergences} errors=${errors}`);
  for (const s of sessions) {
    console.log(
      `  ${s.goldenVerdict === "match" ? "OK  " : "DIFF"} ${s.id} events=${s.events} turns=${s.turns} messages=${s.messages.actual}/${s.messages.golden} dangling=${s.danglingToolCalls} subCalls=${s.subCalls}`,
    );
  }
  console.log(`[compare-replay] wrote ${join(REPORTS, "replay-diff.md")}`);

  if (errors > 0) process.exit(2);
  if (STRICT && goldenDivergences > 0) process.exit(1);
}

interface ReportShape {
  generatedAt: string;
  fixturesGeneratedAt: string;
  strict: boolean;
  summary: { sessions: number; goldenComparisons: number; goldenDivergences: number; selfCheckDivergences: number; errors: number; verdict: string };
  sessions: SessionReport[];
  findings: Finding[];
}

function renderMarkdown(r: ReportShape): string {
  const lines: string[] = [];
  lines.push("# Replay diff report (P0 toolchain)");
  lines.push("");
  lines.push(`- generated: ${r.generatedAt}`);
  lines.push(`- fixtures generated: ${r.fixturesGeneratedAt}`);
  lines.push(`- strict: ${r.strict}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| sessions replayed | ${r.summary.sessions} |`);
  lines.push(`| golden comparisons (Studio messages projection) | ${r.summary.goldenComparisons} |`);
  lines.push(`| **golden divergences** | **${r.summary.goldenDivergences}** |`);
  lines.push(`| self-check divergences | ${r.summary.selfCheckDivergences} |`);
  lines.push(`| structural errors | ${r.summary.errors} |`);
  lines.push(`| verdict | ${r.summary.verdict} |`);
  lines.push("");
  lines.push("## Sessions");
  lines.push("");
  lines.push("| session | roles | events | turns | dangling tool_call | sub-calls (parent_id) | torn tail | turn ids monotonic | outcomes | messages (ts/golden) | golden |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.sessions) {
    lines.push(
      `| ${s.id} | ${s.roles.join(", ")} | ${s.events} | ${s.turns} | ${s.danglingToolCalls} | ${s.subCalls} | ${s.tornTail ? "yes" : "no"} | ${s.turnIdMonotonic ? "yes" : "NO"} | ${JSON.stringify(s.outcomes)} | ${s.messages.actual}/${s.messages.golden} | ${s.goldenVerdict} |`,
    );
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (r.findings.length === 0) lines.push("_none_");
  else {
    lines.push("| scope | kind | detail |");
    lines.push("|---|---|---|");
    for (const f of r.findings) lines.push(`| ${f.scope} | ${f.kind} | ${f.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## What is (and is not) golden at P0");
  lines.push("");
  lines.push("- **Golden (from the running Rust implementation)**: the Studio `messages` projection via `GET /api/sessions/{id}/messages`.");
  lines.push("- **Self-check only**: engine `derive_messages` and the SSE transcript — the engine exposes no HTTP surface for them, so the TS reference implementation is compared against its own stored derivation. P1 turns both into golden comparisons.");
  lines.push("- A non-empty diff at this stage is expected to be reported, not hidden: `pnpm replay:compare --strict` fails the run when the golden comparison diverges.");
  lines.push("");
  return lines.join("\n");
}

main();
