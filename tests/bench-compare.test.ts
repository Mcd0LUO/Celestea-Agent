// @vitest-environment node
/**
 * The bench comparison view: environment guard + noise tiers.
 *
 * The comparison used to mark anything under 0.5% as "within noise" and call
 * everything else a movement. Two consecutive runs of ONE commit differ by
 * p50 2.6% / p90 12.6% per case, so that threshold called ~a quarter of the rows
 * real changes. It also compared a node v24 baseline with a node v26 run without
 * saying so. Both are now pinned here.
 */
import { describe, expect, it } from 'vitest';
import { compareBaselines, environmentDeltas, renderComparison } from '../scripts/bench/compare.js';
import type { Baseline } from '../scripts/bench/report.js';
import type { BenchCase } from '../scripts/bench/timing.js';

function row(name: string, median: number): BenchCase {
  return { name, scale: 'x', unit: 'ms', iterations: 100, rounds: 5, median_ms: median, min_ms: median, ops_per_s: 0 };
}

function baseline(commit: string, node: string, cases: BenchCase[]): Baseline {
  return {
    schema: 'celestea-studio-ts.bench-baseline/1',
    version: 'v9.9.9',
    generated_at: '2026-01-01T00:00:00.000Z',
    command: 'pnpm bench',
    unit: 'ms',
    duration_ms: 1,
    machine: { cpu: 'CPU', cores: 8, total_memory_bytes: 1, total_memory_gib: 1, node, platform: 'linux', kernel: 'k', arch: 'x64', commit },
    fixtures: [],
    cases,
  } as Baseline;
}

describe('bench compare', () => {
  it('reports the environment change that makes deltas un-attributable', () => {
    const before = baseline('aaa', 'v24.19.0', [row('c', 1)]);
    const after = baseline('bbb', 'v26.8.2', [row('c', 1)]);
    const deltas = environmentDeltas(before, after);
    expect(deltas.map((d) => d.field)).toEqual(['node']);
    expect(deltas[0]?.before).toBe('v24.19.0');
    // commit is what we are comparing, never an environment change
    expect(deltas.some((d) => d.field === 'commit')).toBe(false);
    expect(renderComparison(before, after)).toContain('ENVIRONMENT CHANGED');
  });

  it('says so when the environment is identical', () => {
    const same = baseline('aaa', 'v26.8.2', [row('c', 1)]);
    const text = renderComparison(same, baseline('bbb', 'v26.8.2', [row('c', 1)]));
    expect(text).toContain('environment: identical');
    expect(text).not.toContain('ENVIRONMENT CHANGED');
  });

  it('classifies a delta against the MEASURED noise floor, not a 0.5% constant', () => {
    const before = baseline('a', 'v1', [row('tiny', 100), row('band', 100), row('big', 100)]);
    const after = baseline('b', 'v1', [row('tiny', 101), row('band', 105), row('big', 130)]);
    const byName = new Map(compareBaselines(before, after).map((r) => [r.name, r]));
    expect(byName.get('tiny')?.status).toBe('same');
    expect(byName.get('band')?.status).toBe('unclear');
    expect(byName.get('big')?.status).toBe('signal');
    // 5% used to be reported as a movement; it is inside the noise band.
    expect(byName.get('band')?.change_pct).toBe(5);
  });

  it('warns when the two sides used different repeat counts (method, not code)', () => {
    const one = baseline('a', 'v1', [row('c', 100)]);
    const three = { ...baseline('b', 'v1', [row('c', 90)]), repeats: 3 };
    const text = renderComparison(one, three);
    expect(text).toContain('method: best-of-1 vs best-of-3');
    expect(text).toContain('repeat counts differ');
    // Same repeat count on both sides: no method warning.
    const alsoThree = { ...baseline('c', 'v1', [row('c', 90)]), repeats: 3 };
    expect(renderComparison(three, alsoThree)).not.toContain('repeat counts differ');
  });

  it('a big move is labelled as beyond noise, not just faster/slower', () => {
    const text = renderComparison(baseline('a', 'v1', [row('c', 100)]), baseline('b', 'v1', [row('c', 50)]));
    expect(text).toContain('beyond run-to-run noise');
  });
});
