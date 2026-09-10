/**
 * Self-test of the P5 double-run harness.
 *
 * A synthetic fixture set is written to a temp dir (12 complete turns, the two
 * message projections and a derived SSE transcript), then:
 *   - a clean replay must report `match` with byte-exact evidence, and
 *   - a DELIBERATELY corrupted golden must be DETECTED (verdict `diff`, exit 1).
 *
 * The second case is the important one: a comparison harness that cannot fail is
 * not evidence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveMessages, deriveSseTranscript, projectMessages } from "@celestea/session";
import { serializeEventLog } from "@celestea/runtime";
import type { SessionEvent } from "@celestea/core";
import { exitCodeOf, runReplayE2E, type ReplayE2EReport } from "./e2e-replay.js";
import { renderReplayMarkdown } from "./report.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-fixtures-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 12 complete turns with one tool call every other turn. */
function syntheticLog(): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `turn-${i}`;
    out.push({ type: "turn_start", id }, { type: "user_message", text: `问 ${i}` });
    if (i % 2 === 0) out.push({ type: "tool_call", id: `c${i}`, name: "read_file", args: { path: `/tmp/f${i}` } }, { type: "tool_result", id: `c${i}`, value: { ok: true }, error: null });
    out.push({ type: "assistant_message", text: `答 ${i}` }, { type: "turn_end", id, outcome: "completed" });
  }
  return out;
}

/** Write a complete fixture set (index + one session) and return its root. */
function writeFixtures(root: string, events: readonly SessionEvent[]): void {
  const dir = join(root, "sessions", "synth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), serializeEventLog(events));
  writeFileSync(join(dir, "messages-expected.json"), `${JSON.stringify({ messages: projectMessages(events) }, null, 2)}\n`);
  writeFileSync(join(dir, "derive-messages-expected.json"), `${JSON.stringify({ messages: deriveMessages(events) }, null, 2)}\n`);
  writeFileSync(join(dir, "sse-transcript-derived.jsonl"), `${deriveSseTranscript(events).map((f) => JSON.stringify(f)).join("\n")}\n`);
  const manifest = {
    generatedAt: "2026-09-10T00:00:00.000Z",
    studio: "synthetic",
    sessions: [{ id: "sample-ws/synth", slug: "synth", roles: ["session-log"], events: events.length, turns: 12, danglingToolCalls: 0, subCalls: 0, expectedMessages: projectMessages(events).length, sseFrames: deriveSseTranscript(events).length }],
    counts: {},
  };
  writeFileSync(join(root, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replay(root: string): Promise<ReplayE2EReport> {
  return runReplayE2E({ fixturesDir: root, probeInput: "自我测试探针" });
}

describe("P5 replay harness", () => {
  it("reports a byte-exact match over a synthetic fixture set", async () => {
    const root = tempRoot();
    writeFixtures(root, syntheticLog());
    const report = await replay(root);

    expect(report.summary.verdict).toBe("match");
    expect(exitCodeOf(report)).toBe(0);
    const scopes = report.findings.map((f) => f.scope);
    expect(scopes).toContain("sample-ws/synth :: session-log-jsonl");
    expect(scopes).toContain("sample-ws/synth :: messages-projection");
    expect(scopes).toContain("sample-ws/synth :: sse-transcript");
    expect(scopes).toContain("sample-ws/synth :: compact-log");
    expect(report.findings.filter((f) => f.verdict === "match" && f.kind === "byte-exact").length).toBeGreaterThanOrEqual(8);
    expect(report.findings.filter((f) => f.kind === "golden" && f.verdict === "match").map((f) => f.scope)).toContain("sample-ws/synth :: compact-response");
    expect(renderReplayMarkdown(report)).toContain("**无差异**");
  });

  it("detects a corrupted golden projection (verdict diff, exit 1)", async () => {
    const root = tempRoot();
    const events = syntheticLog();
    writeFixtures(root, events);
    const golden = projectMessages(events);
    writeFileSync(join(root, "sessions", "synth", "messages-expected.json"), `${JSON.stringify({ messages: golden.slice(1) }, null, 2)}\n`);

    const report = await replay(root);
    expect(report.summary.verdict).toBe("diff");
    expect(exitCodeOf(report)).toBe(1);
    const diff = report.findings.find((f) => f.verdict === "diff");
    expect(diff?.scope).toBe("sample-ws/synth :: messages-projection");
    expect(diff?.kind).toBe("golden");
    expect(renderReplayMarkdown(report)).toContain("## 差异清单与原因");
  });

  it("refuses to run without a fixtures manifest", async () => {
    await expect(replay(tempRoot())).rejects.toThrow(/fixtures manifest not found/);
  });
});
