/**
 * The P5 double-run driver: replay every golden session through the TS host and
 * aggregate the structured report.
 *
 * The run is SEQUENTIAL on purpose (one host, one engine generation, one session
 * at a time): a replay mutates the session copy it works on (probe turn +
 * compaction), and a shared host would let one session's compaction be observed
 * by another's comparison.
 */

import { resolve } from "node:path";
import { note, tally, type Finding } from "./compare.js";
import { loadManifest, splitSessionId, type FixtureSession } from "./fixtures.js";
import { createReplayHost } from "./host.js";
import { replaySession, type SessionE2E } from "./session-e2e.js";

export interface ReplayE2EOptions {
  fixturesDir?: string;
  /** Input of the real probe turn appended to every session copy. */
  probeInput?: string;
  /** Replay only the first N sessions (smoke runs). */
  maxSessions?: number;
}

export interface ReplayE2ESummary {
  sessions: number;
  findings: number;
  matched: number;
  byteExact: number;
  golden: number;
  diffed: number;
  skipped: number;
  errors: number;
  verdict: "match" | "diff" | "error";
}

export interface ReplayE2EReport {
  generatedAt: string;
  fixtures: string;
  fixturesGeneratedAt: string;
  probeInput: string;
  summary: ReplayE2ESummary;
  sessions: SessionE2E[];
  findings: Finding[];
  errors: string[];
  gaps: string[];
}

/** What is NOT yet golden after P5 (each item names the missing capture). */
export const P6_GAPS: readonly string[] = [
  "compact 后日志：TS 侧与「独立重推导（spec-derived）」逐字节一致，但 Rust 实机 compact 产物尚未捕获 —— P6 需在 Rust 侧用打桩上游（非流式摘要）跑一次 compact，导出 compact-expected.jsonl 作为真黄金。",
  "SSE 序列：逐帧对比的黄金是 TS 自推导 transcript（P0 导出器生成），fixtures/sse/live-capture.raw.txt 为 0 字节（P0 禁止 POST /api/turn）—— P6 需驱动一次 Rust 真实 turn 抓取 live SSE（8 事件 + lagged 降级），并把 JSONL transcript 换成 Rust 原生产物。",
  "LLM 是离线确定性 mock：usage / cache_hit_ratio / context_usage 的数值来自 mock 的 usage 帧，未经真实 provider 的 SSE/usage 解析链路 —— P6 需接 packages/llm 的 mock-upstream（本地假上游，仍禁真网）验证解析与状态线口径。",
  "live/*.json（Rust 实机只读快照）尚未纳入 e2e 逐字段对拍（本阶段只验形状与口径）—— P6 把 status/config/tools/health 快照纳入逐字段对比。",
  "worker 编排：spawn/send/status 走真实 registry 且 driven=true，但表是内存实现（tsvPath=null，不写共享 registry.tsv），receipt/report 文件协议未对拍 —— P6 与 Rust 的 registry.tsv / WORKER_<wid>_DONE 回执对拍。",
  "compact 摘要正文由 mock 生成，只做结构性校验（头部轮、保留轮、重编号、备份）—— P6 接入真实/打桩摘要后再逐字节对拍摘要正文。",
  "大 fixture 的 SSE 采用分批推送（每批 < 总线容量 512），未覆盖容量溢出后的 lagged 降级 —— 该路径由 apps/studio/src/sse.test.ts 覆盖，P6 需在 e2e 中补一条真机溢出用例。",
];

/** Replay all fixture sessions and aggregate the report. */
export async function runReplayE2E(opts: ReplayE2EOptions = {}): Promise<ReplayE2EReport> {
  const fixturesDir = resolve(opts.fixturesDir ?? "fixtures");
  const manifest = loadManifest(fixturesDir);
  const entries = (opts.maxSessions === undefined ? manifest.sessions : manifest.sessions.slice(0, opts.maxSessions)) as FixtureSession[];
  const host = createReplayHost({ workspaces: [...new Set(entries.map((e) => splitSessionId(e.id).workspace))] });
  const probeInput = opts.probeInput ?? "P5 重放探针";
  const sessions: SessionE2E[] = [];
  const errors: string[] = [];
  try {
    for (const entry of entries) sessions.push(await replayOne(host, fixturesDir, entry, probeInput, errors));
  } finally {
    host.cleanup();
  }
  return buildReport({ fixturesDir, manifestGeneratedAt: manifest.generatedAt, probeInput, sessions, errors });
}

async function replayOne(host: ReturnType<typeof createReplayHost>, fixturesDir: string, entry: FixtureSession, probeInput: string, errors: string[]): Promise<SessionE2E> {
  try {
    return await replaySession({ host, fixturesDir, entry, probeInput });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(`${entry.id}: ${message}`);
    return {
      id: entry.id,
      slug: entry.slug,
      roles: entry.roles,
      events: entry.events,
      turns: entry.turns,
      findings: [note(`${entry.id} :: replay`, "info", `replay aborted: ${message}`, "diff")],
      verdict: "diff",
    };
  }
}

function buildReport(input: {
  fixturesDir: string;
  manifestGeneratedAt: string;
  probeInput: string;
  sessions: SessionE2E[];
  errors: string[];
}): ReplayE2EReport {
  const findings = input.sessions.flatMap((s) => s.findings);
  const counts = tally(findings);
  return {
    generatedAt: new Date().toISOString(),
    fixtures: input.fixturesDir,
    fixturesGeneratedAt: input.manifestGeneratedAt,
    probeInput: input.probeInput,
    summary: {
      sessions: input.sessions.length,
      findings: findings.length,
      matched: counts.matched,
      byteExact: counts.byteExact,
      golden: counts.golden,
      diffed: counts.diffed,
      skipped: counts.skipped,
      errors: input.errors.length,
      verdict: input.errors.length > 0 ? "error" : counts.diffed > 0 ? "diff" : "match",
    },
    sessions: input.sessions,
    findings,
    errors: input.errors,
    gaps: [...P6_GAPS],
  };
}

/** Exit code of a report: 0 match, 1 diff, 2 harness error. */
export function exitCodeOf(report: ReplayE2EReport): number {
  if (report.summary.errors > 0) return 2;
  return report.summary.diffed > 0 ? 1 : 0;
}
