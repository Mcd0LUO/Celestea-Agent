/**
 * W761 benchmark timing core — `process.hrtime.bigint()` only, no new deps.
 *
 * Shape of a measurement: warm the JIT up, CALIBRATE how many iterations fit
 * into a ~40ms slice (so a 3µs estimate and a 1.4s trim pass are both measured
 * with a sane number of samples), then take `rounds` slices and report the
 * MEDIAN and the MIN per-operation cost. The median is the headline (robust
 * against a stray GC pause); the min is the "no interference" floor.
 *
 * Everything here is deliberately synchronous: `contextSnapshot()`,
 * `statusline()`, `trimContext()` and the projection are all sync calls, and an
 * async harness would measure the scheduler instead of the code.
 *
 * Measured callbacks RETURN a number, and the numbers are accumulated into a
 * module-level drain: a `void` call whose result nobody reads is a call V8 is
 * free to inline away, which would report a fake 100M ops/s for the cheapest
 * cases. The drain is printed once at the end of the run.
 */

/** One measured case: the row of the report and of the machine-readable JSON. */
export interface BenchCase {
  name: string;
  /** What was measured at which size (`"50k events"`, `"8k ASCII chars"`, …). */
  scale: string;
  unit: "ms";
  iterations: number;
  rounds: number;
  median_ms: number;
  min_ms: number;
  ops_per_s: number;
  /** Free-form honesty note (stubs, fallbacks, skipped regimes). */
  note?: string;
  /** Extra measured quantities (ratios, token estimates, growth exponents). */
  extra?: Record<string, number | string | boolean>;
}

/** A case without the two labels its runner supplies. */
export type Timing = Omit<BenchCase, "name" | "scale">;

export interface TimeOptions {
  /** Per-slice budget; the iteration count is calibrated to it. */
  targetMs?: number;
  /** Slices per case (median over them). */
  rounds?: number;
  maxIterations?: number;
  warmupMs?: number;
}

/** Nanosecond-resolution clock. */
export function nowNs(): bigint {
  return process.hrtime.bigint();
}

/** Sink for measured results: keeps every measured call observable. */
let drained = 0;

/** The accumulated result drain (printed at the end of a run). */
export function drainedValue(): number {
  return drained;
}

/** One call, in milliseconds. */
export function timeOnce(fn: () => number): number {
  const start = nowNs();
  drained = (drained + fn()) % 1e9;
  return Number(nowNs() - start) / 1e6;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Round to `digits` SIGNIFICANT digits. Fixed decimal places would erase the
 * cheapest rows entirely (45ns = 0.000045ms, which 4 decimals rounds to 0).
 */
function round(value: number, digits = 4): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

/** Repeat `fn` until at least `budgetMs` elapsed (bounded), discarding timings. */
function warmup(fn: () => number, budgetMs: number): void {
  const start = nowNs();
  let calls = 0;
  while (calls < 3 || Number(nowNs() - start) / 1e6 < budgetMs) {
    drained = (drained + fn()) % 1e9;
    calls += 1;
    if (calls > 10_000) return;
  }
}

/** How many iterations fit the slice budget, clamped to `[1, maxIterations]`. */
function calibrate(fn: () => number, targetMs: number, maxIterations: number): number {
  const one = Math.max(timeOnce(fn), 0.000_001);
  return Math.max(1, Math.min(maxIterations, Math.floor(targetMs / one)));
}

/** Median per-operation cost of one slice of `iterations` calls. */
function slicePerOp(fn: () => number, iterations: number): number {
  const start = nowNs();
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += fn();
  const perOp = Number(nowNs() - start) / 1e6 / iterations;
  drained = (drained + acc) % 1e9;
  return perOp;
}

/**
 * Measure one synchronous operation. Slow operations (>200ms per call) are
 * measured with ONE iteration per slice and fewer slices, so a quadratic case
 * cannot turn the suite into a multi-minute run.
 */
export function timeValue(fn: () => number, opts: TimeOptions = {}): Timing {
  const targetMs = opts.targetMs ?? 60;
  const maxIterations = opts.maxIterations ?? 500_000;
  warmup(fn, opts.warmupMs ?? 20);
  const iterations = calibrate(fn, targetMs, maxIterations);
  // Slow cases get one call per slice; five slices still bound the noise (a
  // 20ms snapshot is cheap to repeat, a 1s trim pass is not — that one is
  // explicitly measured with fewer slices by its case).
  const rounds = opts.rounds ?? 5;
  const samples: number[] = [];
  for (let r = 0; r < rounds; r += 1) samples.push(slicePerOp(fn, iterations));
  const med = median(samples);
  return {
    unit: "ms",
    iterations,
    rounds,
    median_ms: round(med),
    min_ms: round(Math.min(...samples)),
    ops_per_s: med === 0 ? Number.POSITIVE_INFINITY : Math.round((1_000 / med) * 100) / 100,
  };
}

/** `{...timing, name, scale, note}` — the row builders use this. */
export function caseOf(
  name: string,
  scale: string,
  timing: Timing,
  note?: string,
  extra?: Record<string, number | string | boolean>,
): BenchCase {
  return {
    name,
    scale,
    ...timing,
    ...(note === undefined ? {} : { note }),
    ...(extra === undefined ? {} : { extra }),
  };
}

/**
 * Log-log slope of `y` over `x` (least squares): ~1 = linear, ~2 = quadratic.
 * Used to report the empirical growth of the trim pass instead of asserting it.
 */
export function growthExponent(points: ReadonlyArray<{ x: number; y: number }>): number {
  const usable = points.filter((p) => p.x > 0 && p.y > 0);
  if (usable.length < 2) return 0;
  const lx = usable.map((p) => Math.log(p.x));
  const ly = usable.map((p) => Math.log(p.y));
  const meanX = lx.reduce((a, b) => a + b, 0) / lx.length;
  const meanY = ly.reduce((a, b) => a + b, 0) / ly.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < lx.length; i += 1) {
    num += ((lx[i] ?? 0) - meanX) * ((ly[i] ?? 0) - meanY);
    den += ((lx[i] ?? 0) - meanX) ** 2;
  }
  return den === 0 ? 0 : round(num / den, 2);
}
