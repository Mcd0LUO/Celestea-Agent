/**
 * W761 reporting: machine facts, the printed table, and the baseline document.
 *
 * The baseline is one JSON document (`benchmarks/baseline-v2.6.0.json`) plus the
 * human-readable twin (`docs/performance-baseline.md`); both are written from
 * the SAME run, so the doc can never drift from the numbers it describes.
 */

import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem, arch } from "node:os";
import type { BenchCase } from "./timing.js";
import type { Fixture } from "./fixtures.js";
import { scaleLabel } from "./fixtures.js";

/** Baseline schema id (bump when the shape changes; compare.ts reads it). */
export const BASELINE_SCHEMA = "celestea-studio-ts.bench-baseline/1";
/** The release these numbers are the baseline FOR. */
export const BASELINE_VERSION = "v2.6.0";
/** Command a reproduction has to run. */
export const BENCH_COMMAND = "pnpm bench";

export interface MachineInfo {
  cpu: string;
  cores: number;
  total_memory_bytes: number;
  total_memory_gib: number;
  node: string;
  platform: string;
  kernel: string;
  arch: string;
  commit: string;
}

export interface FixtureSummary {
  scale: number;
  label: string;
  events: number;
  messages: number;
  estimate_tokens: number;
  /** Events the REAL loop produced / turns the amplification replayed. */
  loop_events: number;
  appended_events: number;
  amplification_turns: number;
  build_ms: number;
  loop_ms: number;
}

export interface Baseline {
  schema: string;
  version: string;
  generated_at: string;
  command: string;
  unit: "ms";
  /** Wall-clock of the measurement phase (fixtures + cases), not of writing. */
  duration_ms: number;
  machine: MachineInfo;
  fixtures: FixtureSummary[];
  cases: BenchCase[];
}

/** `git rev-parse --short HEAD`, or `"unknown"` (the task's rule). */
export function commitOf(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function gib(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/** CPU / memory / runtime facts, all from `node:os` + `process`. */
export function machineInfo(): MachineInfo {
  const first = cpus()[0];
  return {
    cpu: first?.model ?? "unknown",
    cores: cpus().length,
    total_memory_bytes: totalmem(),
    total_memory_gib: gib(totalmem()),
    node: process.version,
    platform: platform(),
    kernel: release(),
    arch: arch(),
    commit: commitOf(),
  };
}

export function fixtureSummaries(fixtures: readonly Fixture[]): FixtureSummary[] {
  return fixtures.map((fixture) => ({
    scale: fixture.scale,
    label: scaleLabel(fixture),
    events: fixture.events,
    messages: fixture.messages,
    estimate_tokens: fixture.estimate_tokens,
    loop_events: fixture.template_events,
    appended_events: fixture.appended_events,
    amplification_turns: fixture.amplification_turns,
    build_ms: fixture.build_ms,
    loop_ms: fixture.loop_ms,
  }));
}

export function buildBaseline(fixtures: readonly Fixture[], cases: readonly BenchCase[], durationMs: number): Baseline {
  return {
    schema: BASELINE_SCHEMA,
    version: BASELINE_VERSION,
    generated_at: new Date().toISOString(),
    command: BENCH_COMMAND,
    unit: "ms",
    duration_ms: durationMs,
    machine: machineInfo(),
    fixtures: fixtureSummaries(fixtures),
    cases: [...cases],
  };
}

const COLUMNS: ReadonlyArray<{ key: string; label: string; width: number; right: boolean }> = [
  { key: "name", label: "case", width: 34, right: false },
  { key: "scale", label: "scale", width: 22, right: false },
  { key: "iterations", label: "iters", width: 7, right: true },
  { key: "rounds", label: "rnd", width: 4, right: true },
  { key: "median_ms", label: "median ms", width: 11, right: true },
  { key: "min_ms", label: "min ms", width: 11, right: true },
  { key: "ops_per_s", label: "ops/s", width: 12, right: true },
];

function cell(value: string, width: number, right: boolean): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function rowOf(cells: readonly string[]): string {
  return COLUMNS.map((column, i) => cell(cells[i] ?? "", column.width, column.right)).join(" | ");
}

/** Sub-microsecond rows need more digits than millisecond rows, or they print as 0. */
function fixed(value: number): string {
  if (!Number.isFinite(value)) return "inf";
  if (value === 0) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  return value.toFixed(Math.max(0, Math.min(9, 4 - 1 - magnitude)));
}

function valuesOf(item: BenchCase): string[] {
  return [
    item.name,
    item.scale,
    String(item.iterations),
    String(item.rounds),
    fixed(item.median_ms),
    fixed(item.min_ms),
    item.ops_per_s.toFixed(2),
  ];
}

/** The ASCII table printed to stdout (one line per measured case). */
export function renderTable(cases: readonly BenchCase[]): string {
  const header = rowOf(COLUMNS.map((c) => c.label));
  const rule = COLUMNS.map((c) => "-".repeat(c.width)).join("-+-");
  return [header, rule, ...cases.map((item) => rowOf(valuesOf(item)))].join("\n");
}

/** The same table as markdown (the doc keeps a readable copy). */
export function renderMarkdownTable(cases: readonly BenchCase[]): string {
  const header = `| ${COLUMNS.map((c) => c.label).join(" | ")} |`;
  const rule = `| ${COLUMNS.map((c) => (c.right ? "---:" : "---")).join(" | ")} |`;
  const rows = cases.map((item) => `| ${valuesOf(item).join(" | ")} |`);
  return [header, rule, ...rows].join("\n");
}
