/**
 * W761 regression view: baseline JSON vs a fresh run — percentages only.
 *
 * There is deliberately NO pass/fail threshold. A benchmark on a shared machine
 * jitters (turbo, neighbours, GC); a hard gate would fail honest commits and get
 * disabled within a week. The comparison is for a human reading a diff: it shows
 * the median change per case, sorted by the largest movement, and marks rows
 * that appear only on one side.
 */

import { readFileSync } from "node:fs";
import type { Baseline } from "./report.js";

/**
 * Run-to-run noise floor, MEASURED rather than guessed.
 *
 * Method: two consecutive `pnpm bench` runs on the SAME commit (a7ea4d3), same
 * machine, load 0.6-1.0 on 28 cores. Per-case |delta| between the two runs gave
 * p50 2.6% / p90 12.6% / max 20.7% on the median. The minimum was no better
 * (2.5% / 12.8% / 15.5%), which is the point: the dominant noise is between
 * runs (CPU boost state, cache/ASLR layout, neighbours), not within a run, so
 * no statistic computed from one run can remove it.
 *
 * The old threshold was a hardcoded 0.5% labelled "(within noise)" — about 5x
 * tighter than the real median noise and 25x tighter than p90, i.e. it called
 * roughly a quarter of all rows real movements. These two numbers replace it.
 */
export const NOISE_TYPICAL_PCT = 2.5;
export const NOISE_P90_PCT = 12.6;

export interface DeltaRow {
  name: string;
  scale: string;
  baseline_ms: number;
  current_ms: number;
  /** Signed percentage change of the median (positive = slower now). */
  change_pct: number;
  /** signal: beyond p90 noise. unclear: inside the noise band. same: typical. */
  status: "signal" | "unclear" | "same" | "new" | "gone";
}

/** Rows the two runs share, plus the ones only one side has. */
export function compareBaselines(baseline: Baseline, current: Baseline): DeltaRow[] {
  const rows: DeltaRow[] = [];
  const seen = new Set<string>();
  for (const row of current.cases) {
    const key = `${row.name}|${row.scale}`;
    seen.add(key);
    const before = baseline.cases.find((b) => `${b.name}|${b.scale}` === key);
    if (before === undefined) {
      rows.push({ name: row.name, scale: row.scale, baseline_ms: 0, current_ms: row.median_ms, change_pct: 0, status: "new" });
      continue;
    }
    const change = before.median_ms === 0 ? 0 : ((row.median_ms - before.median_ms) / before.median_ms) * 100;
    rows.push({
      name: row.name,
      scale: row.scale,
      baseline_ms: before.median_ms,
      current_ms: row.median_ms,
      change_pct: Math.round(change * 10) / 10,
      status: Math.abs(change) >= NOISE_P90_PCT ? "signal" : Math.abs(change) >= NOISE_TYPICAL_PCT ? "unclear" : "same",
    });
  }
  for (const row of baseline.cases) {
    if (!seen.has(`${row.name}|${row.scale}`)) {
      rows.push({ name: row.name, scale: row.scale, baseline_ms: row.median_ms, current_ms: 0, change_pct: 0, status: "gone" });
    }
  }
  return rows.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
}

/** One environment fact that differs between the two runs. */
export interface EnvDelta {
  field: string;
  before: string;
  after: string;
}

/**
 * Environment facts whose change makes a percentage delta un-attributable to the
 * code. `commit` is deliberately excluded (that is what we are comparing) and so
 * is `kernel` (it moves without changing what V8 does).
 *
 * Why this exists: the v2.6.2 baseline was measured on node v24 and the v2.7.2
 * run on node v26, and the comparison happily printed "estimateTokens -89.9%".
 * A V8 upgrade is not a commit, and reporting it as one is worse than reporting
 * nothing.
 */
export function environmentDeltas(baseline: Baseline, current: Baseline): EnvDelta[] {
  const pairs: Array<[string, string, string]> = [
    ["node", baseline.machine.node, current.machine.node],
    ["cpu", baseline.machine.cpu, current.machine.cpu],
    ["cores", String(baseline.machine.cores), String(current.machine.cores)],
    ["platform", baseline.machine.platform, current.machine.platform],
    ["arch", baseline.machine.arch, current.machine.arch],
  ];
  return pairs
    .filter(([, before, after]) => before !== after)
    .map(([field, before, after]) => ({ field, before, after }));
}

export function loadBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

function line(row: DeltaRow): string {
  const label = `${row.name} @ ${row.scale}`.padEnd(58);
  if (row.status === "new") return `${label} NEW (${row.current_ms.toFixed(4)} ms)`;
  if (row.status === "gone") return `${label} GONE (was ${row.baseline_ms.toFixed(4)} ms)`;
  const sign = row.change_pct > 0 ? "+" : "";
  const dir = row.change_pct > 0 ? "slower" : "faster";
  const verdict =
    row.status === "signal"
      ? `  ${dir} — beyond run-to-run noise`
      : row.status === "unclear"
        ? `  ${dir}? inside the noise band (p50 ${NOISE_TYPICAL_PCT}% / p90 ${NOISE_P90_PCT}%) — re-run to confirm`
        : "  (typical noise)";
  return `${label} ${row.baseline_ms.toFixed(4)} -> ${row.current_ms.toFixed(4)} ms  ${sign}${row.change_pct}%${verdict}`;
}

/** Human-readable comparison; no exit code, no threshold. */
/** The loud block printed when the two runs did not share an environment. */
function environmentSection(baseline: Baseline, current: Baseline): string[] {
  const deltas = environmentDeltas(baseline, current);
  if (deltas.length === 0) return ["environment: identical (node / cpu / cores / platform / arch)"];
  return [
    "!! ENVIRONMENT CHANGED since the baseline — every percentage below mixes the",
    "!! code change with the environment change and cannot be attributed to a commit:",
    ...deltas.map((d) => `!!   ${d.field.padEnd(9)} ${d.before} -> ${d.after}`),
    "!! Re-baseline on this machine (pnpm bench) before reading anything into these",
    "!! numbers, or compare two runs made on the SAME node build.",
  ];
}

/** Human-readable comparison; no exit code, no threshold. */
export function renderComparison(baseline: Baseline, current: Baseline): string {
  const rows = compareBaselines(baseline, current);
  const signal = rows.filter((row) => row.status === "signal").length;
  const unclear = rows.filter((row) => row.status === "unclear").length;
  const repeatsBefore = baseline.repeats ?? 1;
  const repeatsNow = current.repeats ?? 1;
  return [
    `compare: ${baseline.version} baseline (${baseline.machine.commit}, ${baseline.generated_at})`,
    `     vs: this run (${current.machine.commit}, ${current.generated_at})`,
    `method: best-of-${repeatsBefore} vs best-of-${repeatsNow}`,
    ...environmentSection(baseline, current),
    ...(repeatsBefore === repeatsNow
      ? []
      : [
          `!! repeat counts differ — a best-of-${Math.max(repeatsBefore, repeatsNow)} row is systematically`,
          "!! faster than a best-of-1 row, so part of every delta below is method, not code.",
        ]),
    `cases: ${rows.length} — ${signal} beyond noise (>=${NOISE_P90_PCT}%), ${unclear} inside the noise band (${NOISE_TYPICAL_PCT}-${NOISE_P90_PCT}%)`,
    "",
    ...rows.map(line),
    "",
    `no pass/fail by design. The floor is MEASURED: two runs of one commit differ by`,
    `p50 ${NOISE_TYPICAL_PCT}% / p90 ${NOISE_P90_PCT}% per case, so a single-vs-single delta below`,
    `${NOISE_P90_PCT}% is not evidence of a code change — re-run, or re-baseline on this machine.`,
  ].join("\n");
}
