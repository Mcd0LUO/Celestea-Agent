// scripts/perf/lib/stats.mjs — 统计与结果落盘（原始 JSON + CSV 表格）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RESULTS_DIR = process.env.W9111_RESULTS ?? 'results/perf-w9111';

export function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function pct(xs, p) {
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 0) return 0;
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}
export function max(xs) { return xs.length ? Math.max(...xs) : 0; }
export function min(xs) { return xs.length ? Math.min(...xs) : 0; }

/** 中位数 + 最大值 + 样本数（报告里的标准三件套）。 */
export function mm(xs) { return { n: xs.length, median: median(xs), max: max(xs), p95: pct(xs, 0.95), mean: mean(xs) }; }

export function saveRaw(name, data) {
  const path = join(RESULTS_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  return path;
}

/** 简易 markdown 表。 */
export function mdTable(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.map((c) => String(c)).join(' | ') + ' |');
  return out.join('\n');
}

export function fmt(n, d = 2) { return Number.isFinite(n) ? Number(n).toFixed(d) : String(n); }
