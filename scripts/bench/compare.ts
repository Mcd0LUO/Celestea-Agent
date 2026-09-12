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

export interface DeltaRow {
  name: string;
  scale: string;
  baseline_ms: number;
  current_ms: number;
  /** Signed percentage change of the median (positive = slower now). */
  change_pct: number;
  status: "moved" | "same" | "new" | "gone";
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
      status: Math.abs(change) < 0.5 ? "same" : "moved",
    });
  }
  for (const row of baseline.cases) {
    if (!seen.has(`${row.name}|${row.scale}`)) {
      rows.push({ name: row.name, scale: row.scale, baseline_ms: row.median_ms, current_ms: 0, change_pct: 0, status: "gone" });
    }
  }
  return rows.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
}

export function loadBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

function line(row: DeltaRow): string {
  const label = `${row.name} @ ${row.scale}`.padEnd(58);
  if (row.status === "new") return `${label} NEW (${row.current_ms.toFixed(4)} ms)`;
  if (row.status === "gone") return `${label} GONE (was ${row.baseline_ms.toFixed(4)} ms)`;
  const sign = row.change_pct > 0 ? "+" : "";
  const verdict = row.status === "same" ? "  (within noise)" : row.change_pct > 0 ? "  slower" : "  faster";
  return `${label} ${row.baseline_ms.toFixed(4)} -> ${row.current_ms.toFixed(4)} ms  ${sign}${row.change_pct}%${verdict}`;
}

/** Human-readable comparison; no exit code, no threshold. */
export function renderComparison(baseline: Baseline, current: Baseline): string {
  const rows = compareBaselines(baseline, current);
  const moved = rows.filter((row) => row.status === "moved").length;
  return [
    `compare: ${baseline.version} baseline (${baseline.machine.commit}, ${baseline.generated_at})`,
    `     vs: this run (${current.machine.commit}, ${current.generated_at})`,
    `cases: ${rows.length} (${moved} moved by more than 0.5%)`,
    "",
    ...rows.map(line),
    "",
    "no threshold is applied by design: judge the size of a move, not its existence.",
  ].join("\n");
}
