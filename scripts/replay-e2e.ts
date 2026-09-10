#!/usr/bin/env tsx
/**
 * P5 end-to-end replay (`pnpm replay:e2e`).
 *
 * Golden fixtures (from the running Rust implementation) are replayed through the
 * TS host — real runtime, real agent loop, real JSONL session log, offline LLM
 * (NO network) — and compared artifact by artifact:
 *
 *   session log JSONL (byte-exact) · SSE sequence · messages projection ·
 *   post-compaction log (independent re-derivation) · probe turn append
 *
 * Output: `reports/replay-e2e.json` + `reports/replay-e2e.md`. A single diff
 * exits 1 (the artifacts are written first); a harness failure exits 2.
 * `--report-only` keeps the exit code at 0 so the report can be inspected while
 * a known gap is being worked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exitCodeOf, renderReplayConsole, renderReplayMarkdown, runReplayE2E } from "@celestea/studio";
import { bool, num, parseArgs, str } from "./lib/args.js";

const args = parseArgs(process.argv.slice(2));
const FIXTURES = resolve(str(args, "fixtures", "fixtures"));
const REPORTS = resolve(str(args, "reports", "reports"));
const PROBE_INPUT = str(args, "probe-input", "P5 重放探针");
const MAX_SESSIONS = num(args, "max-sessions", Number.MAX_SAFE_INTEGER);
const REPORT_ONLY = bool(args, "report-only");

async function main(): Promise<void> {
  mkdirSync(REPORTS, { recursive: true });
  const report = await runReplayE2E({ fixturesDir: FIXTURES, probeInput: PROBE_INPUT, maxSessions: MAX_SESSIONS });
  const jsonPath = resolve(REPORTS, "replay-e2e.json");
  const mdPath = resolve(REPORTS, "replay-e2e.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderReplayMarkdown(report));

  console.log(renderReplayConsole(report));
  for (const s of report.sessions) {
    const diffed = s.findings.filter((f) => f.verdict === "diff").length;
    console.log(`  ${diffed === 0 ? "OK  " : "DIFF"} ${s.id} findings=${s.findings.length} diff=${diffed}`);
  }
  for (const e of report.errors) console.error(`  ERROR ${e}`);
  console.log(`[replay:e2e] wrote ${mdPath}`);

  const code = exitCodeOf(report);
  if (code !== 0 && !REPORT_ONLY) process.exit(code);
  if (code !== 0) console.log(`[replay:e2e] --report-only: exiting 0 despite verdict=${report.summary.verdict}`);
}

main().catch((e: unknown) => {
  console.error(`[replay:e2e] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
