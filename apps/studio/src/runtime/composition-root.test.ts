/**
 * W743 · 组合根收口：测试与生产共用同一份引擎装配（收 W732 A1）。
 *
 * W732 A1 的证据：`app.ts` 的 `defaultRuntime()` 与 `test-util.ts` 的
 * `engineFactory` 是两份手抄装配，且测试副本**漏了 `grants` 与 `ledgerFile`**
 * —— 号称「真引擎」的 HTTP 测试其实跑在没有授权边界、不记账的引擎上。
 *
 * 本文件是这条的验收：
 *   1. 结构性：`test-util.ts` 不得再出现自己的适配器装配（回归守卫）；
 *   2. 行为性：grants 边界（放行 / 拒绝 / fail-closed 审计）与 usage 账本
 *      （落行）都必须在 **HTTP 层**（真实回合、真实 agent loop、真实工具注册表）
 *      被观察到 —— 这两条在收口前必然失败（没有 grants reader、没有账本文件）。
 *
 * 观测面刻意选「过 HTTP + 真实工具结果帧」，而不是直接读组合根内部对象：只有
 * 端到端才证明得了「装配真的接到了引擎上」。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import type { OfflineStep } from "./offline-llm.js";
import { activate, makeEngineHarness, runTurnWithFrames, type FrameRecord } from "./test-util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const harnesses: StudioHarness[] = [];

afterAll(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The harness env: the ledger is ON and pinned to the harness data root (the
 * ambient `CELESTEA_USAGE_LEDGER*` of the developer's shell must not decide
 * whether this test can see a row).
 */
const LEDGER_ENV: NodeJS.ProcessEnv = { CELESTEA_USAGE_LEDGER: "on", CELESTEA_USAGE_LEDGER_FILE: "" };

function harness(llm?: OfflineStep[]): StudioHarness {
  const h = makeEngineHarness({
    sessions: { s1: [] },
    env: LEDGER_ENV,
    ...(llm === undefined ? {} : { llm: { script: llm } }),
  });
  harnesses.push(h);
  return h;
}

/** A directory OUTSIDE the harness data root (the thing a grant must widen to). */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w743-outside-"));
  roots.push(dir);
  return dir;
}

/** Hand-write the session's `grants.json` — the hostile-input path of §4.1. */
function writeGrants(h: StudioHarness, name: string, grants: unknown[]): void {
  const file = { version: 1, session: `sample-ws/${name}`, updated_at: 1_700_000_000, grants };
  writeFileSync(join(h.workspace, name, "grants.json"), JSON.stringify(file));
}

function grantEntry(cap: string, scope: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `g-${cap}`,
    cap,
    scope,
    granted_at: 1_700_000_000,
    granted_by: "hand",
    expires_at: null,
    uses_left: null,
    note: "",
  };
}

/** The scripted turn: one `read_file` call, then a closing text step. */
function readScript(target: string): OfflineStep[] {
  return [
    { thinking: "read it", tool_calls: [{ id: "c1", name: "read_file", args: { path: target } }] },
    { text: "read done" },
  ];
}

function toolResult(frames: readonly FrameRecord[]): Record<string, unknown> {
  const frame = frames.find((f) => f.event === "tool_result");
  if (frame === undefined) throw new Error(`no tool_result frame (saw ${frames.map((f) => f.event).join(",")})`);
  return frame.payload;
}

/** The engine's grants audit channel (`<data root>/grants-audit.jsonl`). */
function auditText(h: StudioHarness): string {
  try {
    return readFileSync(join(h.root, "grants-audit.jsonl"), "utf8");
  } catch {
    return "";
  }
}

/** Every row of the process usage ledger (`<data root>/usage-ledger.jsonl`). */
function ledgerRows(h: StudioHarness): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(h.root, "usage-ledger.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("W743 · one engine assembly for tests and production", () => {
  it("keeps the assembly in ONE place: the harness reuses createStudioEngine", () => {
    const app = readFileSync(join(HERE, "..", "app.ts"), "utf8");
    const harness = readFileSync(join(HERE, "test-util.ts"), "utf8");
    expect(app).toContain("export function createStudioEngine(");
    expect(harness).toContain('from "../app.js"');
    expect(harness).toContain("createStudioEngine(");
    // The regression this whole change exists for: no second hand-copied build.
    expect(harness).not.toContain("createRealRuntimeAdapter(");
  });
});

describe("W743 · the grants boundary is composed in the HTTP-layer engine (W516)", () => {
  it("denies an out-of-workspace read with no grant (the guard really is mounted)", async () => {
    const outside = outsideDir();
    writeFileSync(join(outside, "secret.txt"), "W743-OUTSIDE\n");
    const h = harness(readScript(join(outside, "secret.txt")));
    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "read outside", 10_000);
    expect(res.status).toBe(202);
    const result = toolResult(res.frames);
    expect(result["ok"]).toBe(false);
    expect(result["decision"]).toBe("deny");
    expect(String(result["error"])).toContain("toolguard");
  });

  it("lets a `read_roots` grant widen THIS session's composed instance", async () => {
    const outside = outsideDir();
    writeFileSync(join(outside, "secret.txt"), "W743-OUTSIDE\n");
    const h = harness(readScript(join(outside, "secret.txt")));
    writeGrants(h, "s1", [grantEntry("read_roots", { roots: [outside] })]);
    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "read outside", 10_000);
    expect(res.status).toBe(202);
    const result = toolResult(res.frames);
    expect(result["ok"]).toBe(true);
    expect(result["error"]).toBeNull();
    expect(result["value"]).toBe("W743-OUTSIDE\n");
    // The boundary the HTTP layer reports is the one the engine composed with.
    expect((await getJson(h.app, "/api/status?session=sample-ws%2Fs1")).body["grants_active"]).toEqual(["read_roots"]);
  });

  it("stays fail-closed on a hand-edited bad grant AND audits the denial (reader is wired)", async () => {
    const outside = outsideDir();
    writeFileSync(join(outside, "secret.txt"), "W743-OUTSIDE\n");
    const h = harness(readScript(join(outside, "secret.txt")));
    // `root '/'` is rejected by §4.3.3 rule 5: the entry is dropped, the file is not.
    writeGrants(h, "s1", [grantEntry("read_roots", { roots: ["/"] })]);
    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "read /", 10_000);
    expect(res.status).toBe(202);
    const result = toolResult(res.frames);
    expect(result["ok"]).toBe(false);
    expect(result["decision"]).toBe("deny");
    // The engine's grants reader ran at compose time: the ignore is on the record.
    // (Before W743 the harness passed NO grants reader at all => zero audit lines.)
    const audit = auditText(h);
    expect(audit).toContain('"event":"deny"');
    expect(audit).toContain("filesystem root");
    expect(audit).toContain("sample-ws/s1");
    expect(audit).not.toContain("undefined");
  });
});

describe("W743 · the usage ledger is composed in the HTTP-layer engine (W728 §3 P0)", () => {
  it("books one ok row per model step plus the turn total, for this session", async () => {
    const h = harness();
    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "book it", 10_000);
    expect(res.status).toBe(202);

    const rows = ledgerRows(h);
    expect(rows.map((r) => r["kind"])).toEqual(["ok", "turn_total"]);
    expect(rows[0]).toMatchObject({
      kind: "ok",
      session: "sample-ws/s1",
      turn: 0,
      turn_id: "turn-0",
      step: 1,
      model: "offline-model",
      provider: null,
    });
    expect(rows[1]).toMatchObject({ kind: "turn_total", steps: 1, outcome: "completed" });
    // The ledger never carries the conversation (C8 counters and names only).
    expect(readFileSync(join(h.root, "usage-ledger.jsonl"), "utf8")).not.toContain("book it");
  });
});
