import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import {
  COMPACT_BACKUP_FILE,
  COMPACT_HEAD_ASSISTANT,
  COMPACT_HEAD_PREFIX,
  COMPACT_KEEP_TURNS,
  COMPACT_NOTE_SKIPPED,
  COMPACT_THRESHOLD,
  COMPACT_TMP_PREFIX,
  compactNote,
  compactTurnId,
  countCompleteTurns,
  parseEventLog,
  planCompaction,
  renderTranscript,
  rewriteAtomic,
  runCompaction,
  serializeEventLog,
  splitCompleteTurns,
  SUMMARY_INPUT_MAX_CHARS,
} from "./index.js";

/** One complete turn: start + user + [thinking + tool_call + tool_result] + assistant + end. */
function fullTurn(n: number, withTools: boolean): SessionEvent[] {
  const id = `turn-${n}`;
  const v: SessionEvent[] = [
    { type: "turn_start", id },
    { type: "user_message", text: `用户第 ${n} 问` },
  ];
  if (withTools) {
    v.push({ type: "thinking_delta", text: `思考 ${n}` });
    v.push({ type: "tool_call", id: `c${n}`, name: "read_file", args: { path: `/tmp/f${n}.rs` } });
    v.push({ type: "tool_result", id: `c${n}`, value: { ok: true }, error: null });
  }
  v.push({ type: "assistant_message", text: `助手第 ${n} 答` });
  v.push({ type: "turn_end", id, outcome: "completed" });
  return v;
}

function logOf(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...fullTurn(i, i % 2 === 0));
  return out;
}

function turnIds(events: readonly SessionEvent[]): string[] {
  return events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.id : ""));
}

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("planCompaction", () => {
  it("prepends the summary and keeps the last K turns renumbered", () => {
    const events = logOf(12);
    const next = planCompaction(events, "摘要正文", COMPACT_KEEP_TURNS);
    expect(next).not.toBeNull();
    const out = next ?? [];

    expect(turnIds(out)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    expect(countCompleteTurns(out)).toBe(5);
    expect(out[0]).toEqual({ type: "turn_start", id: "turn-1" });
    expect(out[1]).toEqual({ type: "user_message", text: `${COMPACT_HEAD_PREFIX}摘要正文` });
    expect(out[2]).toEqual({ type: "assistant_message", text: COMPACT_HEAD_ASSISTANT });
    expect(out[3]).toEqual({ type: "turn_end", id: "turn-1", outcome: "completed" });

    const users = out.filter((e) => e.type === "user_message" && !e.text.startsWith(COMPACT_HEAD_PREFIX));
    expect(users.map((e) => (e.type === "user_message" ? e.text : ""))).toEqual([
      "用户第 8 问",
      "用户第 9 问",
      "用户第 10 问",
      "用户第 11 问",
    ]);

    const ends = out.filter((e) => e.type === "turn_end").map((e) => (e.type === "turn_end" ? e.id : ""));
    expect(ends).toEqual(turnIds(out));
    expect(out.filter((e) => e.type === "tool_call")).toHaveLength(2);
    expect(out.filter((e) => e.type === "thinking_delta")).toHaveLength(2);

    const firstKept = out.slice(4, 11);
    expect(firstKept.map((e) => e.type)).toEqual([
      "turn_start",
      "user_message",
      "thinking_delta",
      "tool_call",
      "tool_result",
      "assistant_message",
      "turn_end",
    ]);
  });

  it("keeps the original terminal outcome of a kept turn", () => {
    const events = logOf(10);
    const lastEnd = [...events].reverse().find((e) => e.type === "turn_end");
    if (lastEnd !== undefined && lastEnd.type === "turn_end") lastEnd.outcome = "cancelled";
    const out = planCompaction(events, "s", 4) ?? [];
    const last = [...out].reverse().find((e) => e.type === "turn_end");
    expect(last !== undefined && last.type === "turn_end" ? last.outcome : null).toBe("cancelled");
  });

  it("drops an unterminated tail and leading orphans", () => {
    const events: SessionEvent[] = [{ type: "user_message", text: "turn_start 之前的孤儿" }, ...logOf(10)];
    events.push({ type: "turn_start", id: "turn-99" });
    events.push({ type: "user_message", text: "中断的尾巴" });
    const out = planCompaction(events, "s", 4) ?? [];
    expect(turnIds(out)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    const texts = out.filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
    expect(texts).not.toContain("turn_start 之前的孤儿");
    expect(texts).not.toContain("中断的尾巴");
  });

  it("keeps every turn when fewer than K complete turns exist", () => {
    const out = planCompaction(logOf(9), "s", 10) ?? [];
    const ids = turnIds(out);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(compactTurnId(1));
    expect(ids[9]).toBe(compactTurnId(10));
  });

  it("skips at or below the threshold and compacts just above it", () => {
    expect(countCompleteTurns(logOf(COMPACT_THRESHOLD))).toBe(COMPACT_THRESHOLD);
    expect(planCompaction(logOf(COMPACT_THRESHOLD), "s", 4)).toBeNull();
    expect(planCompaction(logOf(1), "s", 4)).toBeNull();
    expect(planCompaction([], "s", 4)).toBeNull();
    expect(planCompaction(logOf(COMPACT_THRESHOLD + 1), "s", 4)).not.toBeNull();
    expect(splitCompleteTurns(logOf(3))).toHaveLength(3);
    expect(compactTurnId(5)).toBe("turn-5");
  });
});

describe("rewriteAtomic", () => {
  it("backs up the original, replaces in place and leaves no temp file", () => {
    const dir = scratch();
    const path = join(dir, "cli-main.jsonl");
    const original = '{"type":"user_message","text":"原始"}\n';
    writeFileSync(path, original);

    const events = planCompaction(logOf(12), "摘要", 4) ?? [];
    rewriteAtomic(path, events);

    expect(readFileSync(join(dir, COMPACT_BACKUP_FILE), "utf8")).toBe(original);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(parseEventLog(text)).toEqual(events);
    expect(turnIds(parseEventLog(text))).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    expect(readdirSync(dir).filter((n) => n.startsWith(COMPACT_TMP_PREFIX))).toEqual([]);

    const second = planCompaction(logOf(12), "摘要2", 4) ?? [];
    rewriteAtomic(path, second);
    expect(readFileSync(join(dir, COMPACT_BACKUP_FILE), "utf8")).toBe(text);
    expect(readdirSync(dir).filter((n) => n.startsWith(COMPACT_TMP_PREFIX))).toEqual([]);
  });
});

describe("renderTranscript", () => {
  it("renders every role and keeps the tail on overflow", () => {
    const t = renderTranscript(logOf(3), SUMMARY_INPUT_MAX_CHARS);
    expect(t).toContain("【用户】用户第 0 问");
    expect(t).toContain("【助手】助手第 0 答");
    expect(t).toContain("【工具调用】read_file(");
    expect(t).toContain("【工具结果】");
    expect(t).toContain("--- 轮次 turn-0 ---");

    const tail = renderTranscript(logOf(3), 20);
    expect(tail.startsWith("（更早内容已截断")).toBe(true);
    expect(tail.endsWith("助手第 2 答\n")).toBe(true);
  });
});

describe("runCompaction", () => {
  function writeLog(dir: string, events: readonly SessionEvent[]): string {
    const path = join(dir, "cli-main.jsonl");
    writeFileSync(path, serializeEventLog(events));
    return path;
  }

  it("skips a short history without calling the summarizer", async () => {
    const path = writeLog(scratch(), logOf(COMPACT_THRESHOLD));
    let called = 0;
    const out = await runCompaction({
      logPath: path,
      summarize: () => {
        called += 1;
        return Promise.resolve("never");
      },
    });
    expect(out.compacted).toBe(false);
    expect(out.kept_turns).toBeNull();
    expect(out.note).toBe(COMPACT_NOTE_SKIPPED);
    expect(out.turns_before).toBe(COMPACT_THRESHOLD);
    expect(called).toBe(0);
  });

  it("compacts a long enough history and rewrites the log", async () => {
    const path = writeLog(scratch(), logOf(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    expect(out.compacted).toBe(true);
    expect(out.kept_turns).toBe(COMPACT_KEEP_TURNS);
    expect(out.note).toBe(compactNote(COMPACT_KEEP_TURNS));
    expect(out.turns_before).toBe(12);
    expect(countCompleteTurns(parseEventLog(readFileSync(path, "utf8")))).toBe(5);

    const again = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要2") });
    expect(again.compacted).toBe(false);
  });

  it("surfaces a summarizer failure instead of truncating the log", async () => {
    const dir = scratch();
    const path = writeLog(dir, logOf(12));
    const before = readFileSync(path, "utf8");
    await expect(runCompaction({ logPath: path, summarize: () => Promise.reject(new Error("摘要请求失败：boom")) })).rejects.toThrow(
      "摘要请求失败：boom",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("throws the frozen read error for a missing log", async () => {
    await expect(
      runCompaction({ logPath: join(scratch(), "nope.jsonl"), summarize: () => Promise.resolve("s") }),
    ).rejects.toThrow(/^读取会话日志失败：/);
  });
});
