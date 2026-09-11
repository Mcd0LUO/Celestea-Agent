/**
 * The worker receipt protocol (Rust W235/W241, registry.rs:551-620).
 *
 * When a spawn carried a non-empty `report_to`, the driver mechanically closes
 * the loop after the brief turn — Ok or Err alike, once, without any model
 * cooperation:
 *   1. write `results/<wid>-<short>.md` (the deliverable the coordinator reads);
 *   2. enqueue ONE mailbox receipt into `report_to`, a single line starting
 *      `WORKER_<wid>_DONE` / `WORKER_<wid>_FAILED`, with the report path and a
 *      summary of the worker's last assistant message (`答复: …`, W241).
 *
 * File-stem sanitization is the anti-traversal guard: anything outside
 * `[A-Za-z0-9._-]` becomes `_`, so a hostile `wid` cannot escape the results dir.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionEvent, SessionLog } from "@celestea/core";
import { truncateChars } from "./types.js";

/** Everything the protocol needs about one worker. */
export interface ReceiptRequest {
  wid: string;
  /** Session title token (`<wid>·<short>` suffix); falls back to the wid. */
  short: string;
  startedAt: string;
  brief: string;
  reportTo: string;
  /** Worker conversation id (the receipt's `from_label`). */
  sid: string;
  resultsDir: string;
  log: SessionLog | undefined;
  /** Turn verdict: null = ok, otherwise the failure text. */
  failure: string | null;
  /**
   * W729 §2.3: the worker's working mode, rendered as a `- mode: <mode>` line in
   * the report header (plain text — the receipt protocol itself is unchanged).
   * `null` = the caller declared none, so no line is written.
   */
  mode?: string | null;
}

export interface ReceiptResult {
  /** Report path relative to the results base dir (`results/<stem>.md`). */
  relPath: string;
  /** Absolute path the report was written to. */
  absPath: string;
  /** One-line receipt content enqueued into `reportTo`. */
  content: string;
  /** Non-empty when the report file could not be written (receipt still sent). */
  warn: string;
}

/** Replace everything outside `[A-Za-z0-9._-]` with `_` (path-traversal guard). */
export function sanitizeFileStem(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** W241: last `assistant_message` text, ~200 chars, newlines folded to spaces. */
export function lastAssistantSummary(events: readonly SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.type === "assistant_message") {
      return truncateChars(ev.text, 200).replace(/\n/g, " ");
    }
  }
  return null;
}

/** `<results dir name>/<wid>-<short>.md` — the path reported back to the host. */
export function reportRelPath(resultsDir: string, stem: string): string {
  return `${basename(resultsDir) || "results"}/${stem}.md`;
}

/** Run the protocol: write the report, then return the receipt line. */
export function executeReceipt(req: ReceiptRequest): ReceiptResult {
  const stem = `${sanitizeFileStem(req.wid)}-${sanitizeFileStem(req.short)}`;
  const absPath = join(req.resultsDir, `${stem}.md`);
  const relPath = reportRelPath(req.resultsDir, stem);
  const ok = req.failure === null;
  const status = ok ? "OK" : `ERR: ${req.failure}`;
  const body = renderWorkerReport(req, status, relPath);
  let warn = "";
  try {
    mkdirSync(req.resultsDir, { recursive: true });
    writeFileSync(absPath, body, "utf8");
  } catch (error) {
    warn = ` warn: ${error instanceof Error ? error.message : String(error)}`;
  }
  const answer = req.log === undefined ? "" : summarySuffix(req.log);
  const content = ok
    ? `WORKER_${req.wid}_DONE OK 报告 ${relPath}（完成）${warn}${answer}`
    : `WORKER_${req.wid}_FAILED ERR ${req.failure} 报告 ${relPath}（失败：${req.failure}）${warn}${answer}`;
  return { relPath, absPath, content, warn };
}

function summarySuffix(log: SessionLog): string {
  const summary = lastAssistantSummary(log.events());
  return summary === null ? "" : ` 答复: ${summary}`;
}

function renderWorkerReport(req: ReceiptRequest, status: string, relPath: string): string {
  // W729 §2.3: the worker's working mode is a plain header line (the rest of
  // the receipt protocol is untouched); `null` = the caller declared none.
  const mode = req.mode === undefined || req.mode === null || req.mode === "" ? "" : `- mode: ${req.mode}\n`;
  const head =
    `# Worker ${req.wid} 完成报告\n\n` +
    `- wid: ${req.wid}\n- title: ${req.short}\n- status: ${status}\n` +
    `- started_at: ${req.startedAt}\n${mode}- report: ${relPath}\n\n` +
    `## 简报摘要\n\n${truncateChars(req.brief.trim(), 200)}\n\n## 会话尾记录\n\n`;
  return head + renderTail(req.log);
}

/** The last 20 renderable events, one `- role: text` line each (W235). */
function renderTail(log: SessionLog | undefined): string {
  if (log === undefined) return "（无记录）\n";
  const events = log.events();
  const tail = events.slice(Math.max(0, events.length - 20));
  const lines: string[] = [];
  for (const ev of tail) {
    const line = renderEventLine(ev);
    if (line !== null) lines.push(line);
  }
  return lines.length === 0 ? "（无记录）\n" : `${lines.join("\n")}\n`;
}

function renderEventLine(ev: SessionEvent): string | null {
  switch (ev.type) {
    case "user_message":
      return `- user: ${oneLine(ev.text)}`;
    case "assistant_message":
      return `- assistant: ${oneLine(ev.text)}`;
    case "thinking_delta":
      return `- thinking: ${oneLine(ev.text)}`;
    case "tool_call":
      return `- tool_call ${ev.name}: ${oneLine(jsonText(ev.args))}`;
    case "tool_result":
      return ev.error === null
        ? `- tool_result ${ev.id}: ${oneLine(jsonText(ev.value))}`
        : `- tool_result ${ev.id} error: ${oneLine(ev.error)}`;
    case "turn_start":
      return `- turn_start ${ev.id}`;
    case "turn_end":
      return `- turn_end ${ev.id}`;
    default:
      return null;
  }
}

function oneLine(s: string): string {
  return truncateChars(s, 200).replace(/\n/g, " ");
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}
