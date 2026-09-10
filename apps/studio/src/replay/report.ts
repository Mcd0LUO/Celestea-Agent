/**
 * Markdown / console rendering of the P5 double-run report.
 *
 * The markdown is the deliverable of the replay: it states, per finding, WHICH
 * evidence class backs the claim (byte-exact / Rust golden / spec-derived /
 * self-check) so a reader can tell a proven byte-level match from a
 * self-consistency check, and it lists the P6 gaps next to the verdict.
 */

import type { Finding } from "./compare.js";
import type { ReplayE2EReport } from "./e2e-replay.js";

const KIND_LABEL: Record<Finding["kind"], string> = {
  "byte-exact": "逐字节",
  golden: "Rust 黄金",
  "spec-derived": "独立重推导",
  "self-check": "自洽校验",
  info: "信息",
};

const VERDICT_LABEL: Record<Finding["verdict"], string> = { match: "一致", diff: "差异", skip: "跳过" };

function escape(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function verdictTable(report: ReplayE2EReport): string[] {
  const s = report.summary;
  return [
    "| 指标 | 值 |",
    "|---|---|",
    `| 回放会话数 | ${s.sessions} |`,
    `| 比对项（findings） | ${s.findings} |`,
    `| 一致 | ${s.matched}（其中逐字节 ${s.byteExact} / Rust 黄金 ${s.golden}） |`,
    `| **差异** | **${s.diffed}** |`,
    `| 跳过（结构性说明） | ${s.skipped} |`,
    `| harness 错误 | ${s.errors} |`,
    `| 结论 | ${s.verdict} |`,
    "",
  ];
}

function findingsTable(title: string, findings: readonly Finding[], predicate: (f: Finding) => boolean): string[] {
  const rows = findings.filter(predicate);
  const out = [`### ${title}（${rows.length}）`, ""];
  if (rows.length === 0) return [...out, "_无_", ""];
  out.push("| scope | 证据类别 | 说明 |", "|---|---|---|");
  for (const f of rows) out.push(`| ${escape(f.scope)} | ${KIND_LABEL[f.kind]} | ${escape(f.detail)} |`);
  out.push("");
  return out;
}

function sessionTable(report: ReplayE2EReport): string[] {
  const out = ["| 会话 | roles | events | turns | 比对项 | 差异 | 结论 |", "|---|---|---|---|---|---|---|"];
  for (const s of report.sessions) {
    const diffed = s.findings.filter((f) => f.verdict === "diff").length;
    out.push(`| ${s.id} | ${s.roles.join(", ")} | ${s.events} | ${s.turns} | ${s.findings.length} | ${diffed} | ${s.verdict} |`);
  }
  out.push("");
  return out;
}

function diffSection(report: ReplayE2EReport): string[] {
  const diffs = report.findings.filter((f) => f.verdict === "diff");
  const out = ["## 差异清单与原因", ""];
  if (diffs.length === 0) return [...out, "**无差异**：所有比对项一致。", ""];
  out.push("| scope | 证据类别 | 差异 | 首个分歧 |", "|---|---|---|---|");
  for (const f of diffs) out.push(`| ${escape(f.scope)} | ${KIND_LABEL[f.kind]} | ${escape(f.detail)} | ${escape(f.diffs?.[0] ?? "-")} |`);
  out.push("");
  return out;
}

/** The full markdown report. */
export function renderReplayMarkdown(report: ReplayE2EReport): string {
  const lines: string[] = [];
  lines.push("# P5 双跑对拍报告（replay:e2e）", "");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- fixtures：\`${report.fixtures}\`（导出时间 ${report.fixturesGeneratedAt}）`);
  lines.push(`- 探针输入：\`${report.probeInput}\`（真实 agent-loop + 离线 mock LLM，禁真网）`);
  lines.push("");
  lines.push("## 结论", "");
  lines.push(...verdictTable(report));
  if (report.errors.length > 0) {
    lines.push("### harness 错误", "");
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push("");
  }
  lines.push("## 会话总览", "");
  lines.push(...sessionTable(report));
  lines.push(...findingsTable("已逐字节一致项", report.findings, (f) => f.verdict === "match" && f.kind === "byte-exact"));
  lines.push(...findingsTable("Rust 黄金一致项", report.findings, (f) => f.verdict === "match" && f.kind === "golden"));
  lines.push(...findingsTable("独立重推导 / 自洽校验一致项", report.findings, (f) => f.verdict === "match" && (f.kind === "spec-derived" || f.kind === "self-check")));
  lines.push(...diffSection(report));
  lines.push("## P6 前还差什么", "");
  for (const gap of report.gaps) lines.push(`- ${gap}`);
  lines.push("");
  lines.push("## 全部比对项", "");
  lines.push("| scope | 证据类别 | 结论 | 说明 |", "|---|---|---|---|");
  for (const f of report.findings) lines.push(`| ${escape(f.scope)} | ${KIND_LABEL[f.kind]} | ${VERDICT_LABEL[f.verdict]} | ${escape(f.detail)} |`);
  lines.push("");
  return lines.join("\n");
}

/** One-line console summary (the CLI prints this plus the session rows). */
export function renderReplayConsole(report: ReplayE2EReport): string {
  const s = report.summary;
  return `[replay:e2e] sessions=${s.sessions} findings=${s.findings} matched=${s.matched} (byte-exact=${s.byteExact}, golden=${s.golden}) diffed=${s.diffed} skipped=${s.skipped} errors=${s.errors} verdict=${s.verdict}`;
}
