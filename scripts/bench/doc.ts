/**
 * W761 artifact writers: the machine-readable baseline and its human twin.
 *
 * `docs/performance-baseline.md` is GENERATED from the same run as the JSON, so
 * re-running `pnpm bench` refreshes both. Nothing here decides anything about
 * the engine: it only formats measurements and the honest caveats around them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BASELINE_SCHEMA, renderMarkdownTable, type Baseline } from "./report.js";
import type { BenchCase } from "./timing.js";

/** Default artifact paths (relative to the repo root, the cwd of `pnpm bench`). */
export const BASELINE_PATH = "benchmarks/baseline-v2.6.0.json";
export const DOC_PATH = "docs/performance-baseline.md";

function find(baseline: Baseline, name: string, scalePart?: string): BenchCase | undefined {
  return baseline.cases.find((row) => row.name === name && (scalePart === undefined || row.scale.includes(scalePart)));
}

/** The LAST row with this name: the case modules emit ascending scales. */
function findLast(baseline: Baseline, name: string): BenchCase | undefined {
  const rows = baseline.cases.filter((row) => row.name === name);
  return rows[rows.length - 1];
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value}%`;
}

function number(value: number | string | boolean | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

/** Findings the numbers themselves state — computed, never hand-written. */
function findings(baseline: Baseline): string[] {
  const lines: string[] = [];
  for (const fixture of baseline.fixtures) {
    const tick = find(baseline, "statusline()", fixture.label);
    const snapshot = find(baseline, "contextSnapshot()", fixture.label);
    if (tick === undefined || snapshot === undefined) continue;
    const share = tick.extra?.["snapshot_share_pct"];
    lines.push(
      `- **${fixture.label}** (${fixture.messages.toLocaleString("en-US")} messages, ~${fixture.estimate_tokens.toLocaleString("en-US")} estimated tokens): ` +
        `one \`statusline()\` tick costs **${tick.median_ms.toFixed(3)} ms**, of which **${snapshot.median_ms.toFixed(3)} ms** (${pct(typeof share === "number" ? share : undefined)}) ` +
        `is the W755 \`contextSnapshot()\` the tick now performs — at the 2s SSE tick cadence that is ~${(snapshot.median_ms / 2).toFixed(2)}% of one core per session.`,
    );
  }
  const ascii = find(baseline, "estimateTokens() ASCII");
  const cjk = find(baseline, "estimateTokens() CJK");
  if (ascii !== undefined && cjk !== undefined) {
    lines.push(
      `- **Estimator口径**: ASCII measures **${number(ascii.extra?.["chars_per_token"])} chars/token** (${number(ascii.extra?.["bytes_per_token"])} bytes/token); ` +
        `CJK measures **${number(cjk.extra?.["chars_per_token"])} chars/token** (${number(cjk.extra?.["bytes_per_token"])} bytes/token). ` +
        "A real BPE tokenizer spends roughly one token per CJK character, so `bytes/4` under-counts CJK history by about a quarter — the trim budget and the " +
        "no-usage-frame statusline estimate inherit that bias for CJK sessions.",
    );
  }
  const trimRows = baseline.cases.filter((row) => row.name.startsWith("trimContext() [over budget]"));
  const largest = trimRows[trimRows.length - 1];
  if (largest !== undefined) {
    lines.push(
      `- **Trim pass**: over budget, \`trimContext()\` costs **${largest.median_ms.toFixed(3)} ms** at ${largest.scale} with a measured log-log growth exponent of ` +
        `**${Number(largest.extra?.["growth_exponent_loglog"] ?? 0).toFixed(2)}** — the pass re-estimates the whole suffix per candidate cut, so an over-budget session pays that on every statusline tick.`,
    );
  }
  const tight = findLast(baseline, "contextSnapshot() [over budget]");
  if (tight !== undefined) {
    lines.push(
      `- **Over budget tick**: with a 2,000-token window the same snapshot costs **${tight.median_ms.toFixed(3)} ms** at ${tight.scale} — the trim pass, not the projection, is the cliff.`,
    );
  }
  return lines;
}

function fixtureSection(baseline: Baseline): string {
  const rows = baseline.fixtures.map(
    (fixture) =>
      `| ${fixture.label} | ${fixture.events.toLocaleString("en-US")} | ${fixture.messages.toLocaleString("en-US")} | ${fixture.estimate_tokens.toLocaleString("en-US")} | ` +
      `${fixture.loop_events.toLocaleString("en-US")} | ${fixture.appended_events.toLocaleString("en-US")} | ${fixture.amplification_turns.toLocaleString("en-US")} | ${fixture.build_ms} ms |`,
  );
  return [
    "| scale | events | derived messages | estimated tokens | loop events | appended | amplified turns | fixture build |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}

function machineSection(baseline: Baseline): string {
  const machine = baseline.machine;
  return [
    "| fact | value |",
    "| --- | --- |",
    `| CPU | ${machine.cpu} |`,
    `| cores | ${machine.cores} |`,
    `| memory | ${machine.total_memory_gib} GiB (${machine.total_memory_bytes} bytes) |`,
    `| node | ${machine.node} |`,
    `| platform | ${machine.platform} ${machine.arch} (${machine.kernel}) |`,
    `| git commit | \`${machine.commit}\` |`,
    `| date | ${baseline.generated_at} |`,
    `| command | \`${baseline.command}\` |`,
    `| suite runtime | ${(baseline.duration_ms / 1000).toFixed(1)} s (fixtures + all cases) |`,
  ].join("\n");
}

const METHOD = [
  "## Method",
  "",
  "- Timing: `process.hrtime.bigint()`, one warmup pass, then an iteration count **calibrated** to a ~40ms slice per case and `rounds` slices per case; the table reports the **median** and the **minimum** per-operation cost, plus ops/s from the median.",
  "- Fixtures: a REAL `DefaultAgentLoop` (composed through `@celestea/runtime`'s `compose()`, driven by `Runtime.runTurn`) generates the first ~1,000 events of every scale over a real `projectingSessionLog(memoryEventStore())`; larger scales replay that engine output turn-by-turn with uniquified ids (see the fixture table). Every measured function is the production body — no stubs.",
  "- Faked at `core` seams only: the `Llm` (an offline scripted stream: a benchmark must not depend on a provider) and the `Tool` set (two `fnTool` closures with realistic schemas).",
  "- The suite is deliberately NOT part of `pnpm check`: it is a measurement harness, not a gate.",
].join("\n");

/** The full markdown document (the human twin of the JSON baseline). */
export function renderDoc(baseline: Baseline): string {
  return [
    `# Engine performance baseline — ${baseline.version} (W761)`,
    "",
    `Generated by \`${baseline.command}\` on ${baseline.generated_at}. Machine-readable twin: \`${BASELINE_SCHEMA}\` in \`benchmarks/baseline-v2.6.0.json\`.`,
    "",
    "The baseline pins the cost of the engine's hot paths so a later regression can be argued with numbers: the W755 statusline tick (which now",
    "performs a full context snapshot per tick), the token estimator and the trim pass, the session-log projection, and SSE envelope encoding/decoding.",
    "",
    "## Machine",
    "",
    machineSection(baseline),
    "",
    METHOD,
    "",
    "## Fixtures",
    "",
    fixtureSection(baseline),
    "",
    "## Results",
    "",
    renderMarkdownTable(baseline.cases),
    "",
    "## What the numbers say",
    "",
    ...findings(baseline),
    "",
    "## Known noise and limitations",
    "",
    "- Single machine, single process, no CPU pinning: absolute numbers move with turbo/thermal state; the **median of 5 slices** plus the min column is what to compare, not a single run.",
    "- The 50k-event tick is allocation/GC dominated (it rebuilds ~28.6k `Message` objects per call): across runs of this same suite it measured 25-39 ms for the same code, so only a change outside that band means anything at that scale.",
    "- The fixtures are synthetic conversations (one tool step + one answer per turn): real sessions mix long tool outputs, retries and compactions, so the per-event cost is representative but the event mix is not universal.",
    "- Amplified scales repeat engine-emitted turns, so a 50k-event log is a replay of ~1,000 real events rather than 50k independently generated ones; the projection/estimate cost depends on the event SHAPES and count, which the amplitude preserves.",
    "- The over-budget trim rows slice a real projected history; the cut-boundary structure (user/assistant alternation) is genuine, but a pathological all-tool history would cut differently.",
    "- UTF-8/4 estimates are reported as measured ratios only: no real tokenizer runs here (no dependency, no network), so the CJK comparison is against the documented BPE behaviour, not against a tokenizer measured on this machine.",
    "- `SSE wire decode` parses one 200-frame document per iteration; per-frame cost assumes frames stay comparable in size.",
    "- Fixture build time includes the loop's own O(history) per-step derivation; it is reported for transparency, never as a measured hot path.",
    "",
    "## Re-running and comparing",
    "",
    "```bash",
    "# refresh both artifacts (JSON + this document)",
    "pnpm bench",
    "",
    "# measure again and print the change against the v2.6.0 baseline (no hard threshold: CI jitter must not fail a build)",
    "pnpm bench -- --compare benchmarks/baseline-v2.6.0.json",
    "```",
    "",
  ].join("\n");
}

/** Write the machine-readable baseline (creating `benchmarks/` if needed). */
export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/** Write the generated markdown twin (creating `docs/` if needed). */
export function writeDoc(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderDoc(baseline), "utf8");
}
