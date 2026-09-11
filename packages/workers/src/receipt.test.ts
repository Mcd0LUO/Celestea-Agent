import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { getExtra } from "./registry-tsv.js";
import { WorkerRegistry } from "./registry.js";
import { executeReceipt, lastAssistantSummary, reportRelPath, sanitizeFileStem } from "./receipt.js";
import { workerTools } from "./tools.js";
import { scriptedDrivers, scriptedLoop, waitUntil } from "./fakes.test-util.js";

function resultsDir(): string {
  return join(mkdtempSync(join(tmpdir(), "celestea-results-")), "results");
}

function harness(pid = 4242): { registry: WorkerRegistry; results: string; tools: Map<string, (args: unknown) => Promise<unknown>> } {
  const results = resultsDir();
  const registry = new WorkerRegistry({
    tsvPath: null,
    logFactory: recordingSessionLog,
    now: () => 1_700_000_000_000,
    pid,
    resultsDir: results,
  });
  const tools = new Map(workerTools(registry).map((t) => [t.spec().name, (args: unknown) => t.execute(args) as Promise<unknown>]));
  return { registry, results, tools };
}

describe("receipt protocol helpers", () => {
  it("sanitizes a file stem against path traversal", () => {
    expect(sanitizeFileStem("W1/../../etc/passwd")).toBe("W1_.._.._etc_passwd");
    expect(sanitizeFileStem("W278-runtime workers")).toBe("W278-runtime_workers");
    expect(sanitizeFileStem("ok.Name-1")).toBe("ok.Name-1");
  });

  it("names the report relative to the results directory", () => {
    expect(reportRelPath("/tmp/x/results", "W1-a")).toBe("results/W1-a.md");
    expect(reportRelPath("results", "W1-a")).toBe("results/W1-a.md");
  });

  it("summarizes the last assistant message, folding newlines and truncating", () => {
    const events = [
      { type: "user_message" as const, text: "hi" },
      { type: "assistant_message" as const, text: "first" },
      { type: "assistant_message" as const, text: `line1\nline2 ${"x".repeat(300)}` },
    ];
    const summary = lastAssistantSummary(events);
    expect(summary).toContain("line1 line2");
    expect(summary?.length).toBeLessThanOrEqual(201);
    expect(lastAssistantSummary([])).toBeNull();
  });

  it("writes the report and reports the path", () => {
    const results = resultsDir();
    const log = recordingSessionLog();
    log.append({ type: "assistant_message", text: "did the thing" });
    const result = executeReceipt({
      wid: "W1",
      short: "fix it",
      startedAt: "2026-09-10_12:00:00Z",
      brief: "brief body",
      reportTo: "cli-main",
      sid: "session-0",
      resultsDir: results,
      log,
      failure: null,
    });
    expect(result.relPath).toBe("results/W1-fix_it.md");
    expect(result.warn).toBe("");
    const body = readFileSync(result.absPath, "utf8");
    expect(body).toContain("# Worker W1 完成报告");
    expect(body).toContain("- assistant: did the thing");
    expect(result.content).toContain("WORKER_W1_DONE");
    expect(result.content).toContain("答复: did the thing");
  });

  it("W729: renders the worker's mode as a header line, and nothing when unknown", () => {
    const results = resultsDir();
    const withMode = executeReceipt({
      wid: "W3",
      short: "t",
      startedAt: "t",
      brief: "b",
      reportTo: "cli-main",
      sid: "session-2",
      resultsDir: results,
      log: undefined,
      failure: null,
      mode: "execution",
    });
    const body = readFileSync(withMode.absPath, "utf8");
    expect(body).toContain("- started_at: t\n- mode: execution\n- report: results/W3-t.md");
    // Absent / empty mode keeps the pre-W729 header exactly (no empty line).
    const without = executeReceipt({
      wid: "W4",
      short: "t",
      startedAt: "t",
      brief: "b",
      reportTo: "cli-main",
      sid: "session-3",
      resultsDir: results,
      log: undefined,
      failure: null,
      mode: null,
    });
    expect(readFileSync(without.absPath, "utf8")).toContain("- started_at: t\n- report: results/W4-t.md");
  });

  it("reports a failure receipt and warns instead of throwing on a bad path", () => {
    // The results dir sits under a regular FILE, so mkdir fails fast (ENOTDIR).
    const file = join(mkdtempSync(join(tmpdir(), "celestea-bad-")), "not-a-dir");
    writeFileSync(file, "x", "utf8");
    const result = executeReceipt({
      wid: "W2",
      short: "t",
      startedAt: "t",
      brief: "b",
      reportTo: "cli-main",
      sid: "session-1",
      resultsDir: join(file, "results"),
      log: undefined,
      failure: "boom",
    });
    expect(result.content).toContain("WORKER_W2_FAILED ERR boom");
    expect(result.warn).toContain("warn:");
  });
});

describe("driver receipt loop", () => {
  it("runs the brief turn, then writes the report and queues the receipt", async () => {
    const { registry, results, tools } = harness();
    const scripted = scriptedLoop((input) => ({ assistant: `done: ${input.slice(0, 4)}` }));
    registry.attachDrivers(scriptedDrivers(scripted));
    await tools.get("spawn_worker")!({ wid: "W101", brief: "do the work", report_to: "cli-main", title: "the-work" });

    await waitUntil(() => registry.mailbox.pending("cli-main") === 1);
    const receipt = registry.mailbox.poll("cli-main")[0]!;
    expect(receipt.content).toContain("WORKER_W101_DONE");
    expect(receipt.content).toContain("results/W101-the-work.md");
    expect(receipt.content).toContain("答复:");
    expect(receipt.from_label).toBe("session-0");
    expect(readFileSync(join(results, "W101-the-work.md"), "utf8")).toContain("## 简报摘要");
    // W736: the receipt closes the state machine too — the row is no longer RUNNING.
    expect(registry.getEntry("W101")!.status).toBe("DONE");
    expect(getExtra(registry.getEntry("W101")!, "ended_at")).toBe("2023-11-14_22:13:20Z");
    registry.shutdown();
    await registry.joinDrivers();
  });

  it("reports FAILED when the brief turn throws", async () => {
    const { registry, tools } = harness();
    const scripted = scriptedLoop(() => ({ fail: "no llm" }));
    registry.attachDrivers(scriptedDrivers(scripted));
    await tools.get("spawn_worker")!({ wid: "W102", brief: "b", report_to: "cli-main" });
    await waitUntil(() => registry.mailbox.pending("cli-main") === 1);
    expect(registry.mailbox.poll("cli-main")[0]?.content).toContain("WORKER_W102_FAILED ERR no llm");
    expect(registry.getEntry("W102")!.status).toBe("FAILED");
    expect(getExtra(registry.getEntry("W102")!, "fail")).toBe("no-llm");
    registry.shutdown();
    await registry.joinDrivers();
  });

  it("fails the row when the receipt report cannot be written", async () => {
    // The results dir sits under a regular FILE, so no deliverable can exist:
    // W736 settles the row as FAILED (stricter than Rust, which only warns).
    const file = join(mkdtempSync(join(tmpdir(), "celestea-bad-results-")), "not-a-dir");
    writeFileSync(file, "x", "utf8");
    const registry = new WorkerRegistry({
      tsvPath: null,
      logFactory: recordingSessionLog,
      now: () => 1_700_000_000_000,
      pid: 4242,
      resultsDir: join(file, "results"),
    });
    const tools = new Map(workerTools(registry).map((t) => [t.spec().name, (args: unknown) => t.execute(args) as Promise<unknown>]));
    registry.attachDrivers(scriptedDrivers(scriptedLoop()));

    await tools.get("spawn_worker")!({ wid: "W106", brief: "b", report_to: "cli-main" });
    await waitUntil(() => registry.mailbox.pending("cli-main") === 1);
    const row = registry.getEntry("W106")!;
    expect(row.status).toBe("FAILED");
    expect(getExtra(row, "fail")?.startsWith("receipt-not-written:")).toBe(true);
    registry.shutdown();
    await registry.joinDrivers();
  });

  it("writes nothing (and no receipt) without report_to", async () => {
    const { registry, results, tools } = harness();
    const scripted = scriptedLoop();
    registry.attachDrivers(scriptedDrivers(scripted));
    await tools.get("spawn_worker")!({ wid: "W103", brief: "b" });
    await waitUntil(() => scripted.inputs.length === 1);
    await waitUntil(() => registry.getEntry("W103")?.extra.includes("state=idle") === true);
    expect(registry.mailbox.pending("cli-main")).toBe(0);
    expect(existsSync(join(results, "W103-b.md"))).toBe(false);
    expect(registry.getEntry("W103")!.status).toBe("DONE");
    registry.shutdown();
    await registry.joinDrivers();
  });

  it("parks in state=idle, wakes on a message and runs a serial turn", async () => {
    const { registry, tools } = harness();
    const scripted = scriptedLoop();
    registry.attachDrivers(scriptedDrivers(scripted));
    await tools.get("spawn_worker")!({ wid: "W104", brief: "brief one", report_to: "cli-main" });
    await waitUntil(() => registry.mailbox.pending("cli-main") === 1);
    await waitUntil(() => registry.getEntry("W104")?.extra.includes("state=idle") === true);

    registry.mailbox.send("session-0", "second task", "cli-main");
    await waitUntil(() => scripted.inputs.length === 2);
    expect(scripted.inputs[1]).toBe("second task");
    expect(scripted.logs[0]).toBe(scripted.logs[1]);
    await waitUntil(() => registry.getEntry("W104")?.extra.includes("state=idle") === true);
    registry.shutdown();
    await registry.joinDrivers();
  });

  it("stops the parked driver when its session is removed", async () => {
    const { registry, tools } = harness();
    const scripted = scriptedLoop();
    registry.attachDrivers(scriptedDrivers(scripted));
    await tools.get("spawn_worker")!({ wid: "W105", brief: "b" });
    await waitUntil(() => scripted.inputs.length === 1);
    registry.sessions.remove("session-0");
    registry.stopDriver("session-0");
    await registry.joinDrivers();
    expect(registry.backgroundLen()).toBe(0);
  });
});
