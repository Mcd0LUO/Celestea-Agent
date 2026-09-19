#!/usr/bin/env tsx
/**
 * W761 — engine performance benchmark suite (`pnpm bench`).
 *
 * Run it for a baseline; run it again after a change and compare with
 * `pnpm bench -- --compare benchmarks/baseline-<previous>.json`. A plain run writes
 * `benchmarks/baseline-v<current>.json` (machine-readable, derived from the repo
 * version) and `docs/performance-baseline.md` (the human twin) from the same run.
 *
 * Covered (each row: name / scale / iterations / median ms / ops per s):
 *   a. `contextSnapshot()` and `statusline()` over real 1k/10k/50k-event
 *      sessions — the per-tick cost W755 added, plus an A/B row pair that
 *      isolates it, plus the over-budget (trim-engaged) regime;
 *   b. `estimateTokens` / `estimateMessagesTokens`, ASCII and CJK, with the
 *      measured chars/token and bytes/token出 in `extra`;
 *   c. `trimContext` over a real projected history at growing sizes;
 *   d. the session-log projection (`deriveMessages` / `events`) and the append
 *      replay path;
 *   e. SSE envelope encode (host bus) and wire decode (`parseWire`).
 *
 * Flags: `--compare <baseline.json>` (print % deltas), `--out <path>`,
 * `--doc <path>`, `--no-write` (measure only), `--scales 1000,10000`,
 * `--repeat N` (whole-suite repeats; keep the best median per case; default 1 —
 * see `collectCasesRepeated` for why N is the only lever on run-to-run noise).
 */

import { existsSync } from "node:fs";
import { fixturesFor, SCALES, type Fixture } from "./fixtures.js";
import { contextCases } from "./cases-context.js";
import { tokenCases, trimCases } from "./cases-tokens.js";
import { appendCases, logCases } from "./cases-log.js";
import { sseCases } from "./cases-sse.js";
import { buildBaseline, renderTable, type Baseline } from "./report.js";
import { DOC_PATH, baselinePath, writeBaseline, writeDoc } from "./doc.js";
import { loadBaseline, renderComparison } from "./compare.js";
import { drainedValue, nowNs, type BenchCase } from "./timing.js";

interface Options {
  out: string;
  doc: string;
  write: boolean;
  compare: string | null;
  scales: number[];
  /** Whole-suite repeats; the per-case result is the best of these. */
  repeat: number;
}

function optionValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function parseOptions(argv: readonly string[]): Options {
  const scales = optionValue(argv, "--scales");
  return {
    out: optionValue(argv, "--out") ?? baselinePath(),
    doc: optionValue(argv, "--doc") ?? DOC_PATH,
    write: !argv.includes("--no-write"),
    compare: optionValue(argv, "--compare"),
    scales: scales === null ? [...SCALES] : scales.split(",").map((n) => Number(n.trim())).filter((n) => n > 0),
    repeat: repeatCount(optionValue(argv, "--repeat")),
  };
}

/** `--repeat N`: 1 (default) .. 10; anything unparseable means 1. */
function repeatCount(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(10, Math.floor(n));
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function collectCases(fixtures: readonly Fixture[]): Promise<BenchCase[]> {
  section("(a) context snapshot + statusline");
  const context = contextCases(fixtures);
  console.log(renderTable(context));
  section("(b) token estimation");
  const tokens = tokenCases();
  console.log(renderTable(tokens));
  const largest = fixtures[fixtures.length - 1];
  section("(c) trimContext");
  const trim = largest === undefined ? [] : trimCases(largest);
  console.log(renderTable(trim));
  section("(d) session log projection + replay");
  const log = largest === undefined ? logCases(fixtures) : [...logCases(fixtures), ...appendCases(largest)];
  console.log(renderTable(log));
  section("(e) SSE envelope encode/decode");
  const sse = await sseCases();
  console.log(renderTable(sse));
  return [...context, ...tokens, ...trim, ...log, ...sse];
}

function reportFixtures(fixtures: readonly Fixture[]): void {
  section("fixtures (real loop output, amplified to scale)");
  for (const fixture of fixtures) {
    console.log(
      `  ${fixture.events.toLocaleString("en-US").padStart(7)} events | ${String(fixture.messages).padStart(6)} derived messages | ` +
        `~${fixture.estimate_tokens.toLocaleString("en-US").padStart(7)} est tokens | built in ${fixture.build_ms} ms ` +
        `(${fixture.template_events} loop events + ${fixture.amplification_turns} amplified turns)`,
    );
  }
}

function writeArtifacts(options: Options, baseline: Baseline): void {
  if (!options.write) {
    console.log("\n--no-write: artifacts not written");
    return;
  }
  writeBaseline(options.out, baseline);
  writeDoc(options.doc, baseline, options.out);
  console.log(`\nwrote ${options.out} and ${options.doc}`);
}

/**
 * Run the whole suite `repeat` times and keep, per case, the run with the
 * smallest median ("best of N").
 *
 * Why this is the only lever that helps: two runs of ONE commit differ by
 * p50 2.6% / p90 12.6% per case, and the dominant noise is BETWEEN runs (CPU
 * boost state, cache/ASLR layout, neighbours). Every statistic computed from a
 * single run inherits that variance, so the fix is to make more than one run and
 * keep the least-interfered one.
 *
 * The cost is N x wall-clock, which is why the default is 1 and the count is
 * recorded on every row and in the baseline: a best-of-N row is systematically
 * faster than a best-of-1 row, so `compare` refuses to read the difference as
 * a code change.
 */
async function collectCasesRepeated(fixtures: readonly Fixture[], repeat: number): Promise<BenchCase[]> {
  if (repeat <= 1) return collectCases(fixtures);
  const best = new Map<string, BenchCase>();
  for (let i = 0; i < repeat; i++) {
    section(`repeat ${i + 1}/${repeat} (best of ${repeat} wins per case)`);
    for (const row of await collectCases(fixtures)) {
      const key = `${row.name}|${row.scale}`;
      const previous = best.get(key);
      if (previous === undefined || row.median_ms < previous.median_ms) best.set(key, row);
    }
  }
  return [...best.values()].map((row) => ({ ...row, repeats: repeat }));
}

function compare(options: Options, baseline: Baseline): void {
  if (options.compare === null) return;
  section("comparison");
  if (!existsSync(options.compare)) {
    console.log(`baseline not found: ${options.compare} (nothing to compare against)`);
    return;
  }
  console.log(renderComparison(loadBaseline(options.compare), baseline));
}

async function main(): Promise<void> {
  const startedAt = nowNs();
  const options = parseOptions(process.argv.slice(2));
  console.log(`celestea-studio-ts bench | node ${process.version} | scales: ${options.scales.join(", ")} events`);
  const fixtures = await fixturesFor(options.scales);
  reportFixtures(fixtures);
  const cases = await collectCasesRepeated(fixtures, options.repeat);
  const durationMs = Math.round(Number(nowNs() - startedAt) / 1e6);
  const baseline = buildBaseline(fixtures, cases, durationMs);
  console.log(`\n${cases.length} cases | result drain ${drainedValue().toFixed(3)} (measured calls stay observable: V8 may not elide them)`);
  writeArtifacts(options, baseline);
  compare(options, baseline);
}

await main();
