/**
 * Comparison primitives + the finding vocabulary of the P5 report.
 *
 * Four evidence classes, deliberately distinguished (the point of a double-run
 * report is to say WHICH claims are golden and which are self-consistency):
 *   - `byte-exact`   the artifact was reproduced byte for byte (JSONL logs,
 *                    SSE wire frames, backups);
 *   - `golden`       compared against a capture of the RUNNING Rust
 *                    implementation (`messages-expected.json`);
 *   - `spec-derived` compared against an independent re-derivation of the
 *                    frozen spec (compaction planning), i.e. cross-implementation;
 *   - `self-check`   compared against a TS-derived artifact (SSE transcript of a
 *                    session whose transcript was never captured from Rust);
 *   - `info` / `skip` — reported, never a failure.
 */

import { createHash } from "node:crypto";
import { firstJsonDiff, stableStringify } from "@celestea/core";

export type FindingKind = "byte-exact" | "golden" | "spec-derived" | "self-check" | "info";
export type FindingVerdict = "match" | "diff" | "skip";

export interface Finding {
  scope: string;
  kind: FindingKind;
  verdict: FindingVerdict;
  detail: string;
  /** Up to a handful of concrete divergences (paths + values). */
  diffs?: string[];
}

/** sha256 of a text or buffer (fixture manifests are hash-checked). */
export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Short single-line rendering of a value for a diff detail line. */
export function brief(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : stableStringify(value ?? null);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** First index where two byte strings differ (-1 = equal). */
export function firstByteDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** Byte-level comparison of two artifacts. */
export function compareBytes(scope: string, expected: string, actual: string, note: string): Finding {
  if (expected === actual) {
    return { scope, kind: "byte-exact", verdict: "match", detail: `${note}: ${Buffer.byteLength(actual)} bytes identical (sha256 ${sha256(actual).slice(0, 12)})` };
  }
  const at = firstByteDiff(expected, actual);
  return {
    scope,
    kind: "byte-exact",
    verdict: "diff",
    detail: `${note}: byte ${at} differs (expected ${Buffer.byteLength(expected)} B, actual ${Buffer.byteLength(actual)} B)`,
    diffs: [
      `expected@${at}: ${brief(expected.slice(Math.max(0, at - 40), at + 80))}`,
      `actual@${at}:   ${brief(actual.slice(Math.max(0, at - 40), at + 80))}`,
    ],
  };
}

/** How many concrete divergences one finding carries (keeps reports readable). */
export const MAX_DIFFS = 3;

/** Element-wise JSON comparison with the first [MAX_DIFFS] divergences. */
export function compareJson(scope: string, kind: FindingKind, expected: unknown, actual: unknown, note: string): Finding {
  const max = MAX_DIFFS;
  if (stableStringify(expected) === stableStringify(actual)) {
    const size = Array.isArray(actual) ? `${actual.length} item(s)` : "value";
    return { scope, kind, verdict: "match", detail: `${note}: ${size} identical` };
  }
  const diffs: string[] = [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) diffs.push(`length ${expected.length} != ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length) && diffs.length < max; i++) {
      const d = firstJsonDiff(expected[i], actual[i], `$[${i}]`);
      if (d !== null) diffs.push(d);
    }
  } else {
    diffs.push(firstJsonDiff(expected, actual, "$") ?? "values differ");
  }
  return { scope, kind, verdict: "diff", detail: `${note}: ${diffs.length} divergence(s)`, diffs };
}

/** A `skip`/`info` finding (never fails the run). */
export function note(scope: string, kind: FindingKind, detail: string, verdict: FindingVerdict = "skip"): Finding {
  return { scope, kind, detail, verdict };
}

/** Count findings by verdict. */
export function tally(findings: readonly Finding[]): { matched: number; diffed: number; skipped: number; byteExact: number; golden: number } {
  return {
    matched: findings.filter((f) => f.verdict === "match").length,
    diffed: findings.filter((f) => f.verdict === "diff").length,
    skipped: findings.filter((f) => f.verdict === "skip").length,
    byteExact: findings.filter((f) => f.verdict === "match" && f.kind === "byte-exact").length,
    golden: findings.filter((f) => f.verdict === "match" && f.kind === "golden").length,
  };
}
