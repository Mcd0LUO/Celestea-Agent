/**
 * W794 — 删除 / 归档**活动会话**（真引擎集成）。
 *
 * 裁决：「active 只是状态标记，不是保护理由」。因此：
 *   ① 活动会话可删：目录照常进 `<ws>/.celestea-trash/<session>-<ts>`；
 *   ② 删除前先 `releaseSession`：用与 `POST /api/cancel` 同一条协作式取消路径
 *      切断 in-flight 模型响应（日志里那一回合以 `turn_end: cancelled` 收尾），
 *      随后**只**释放该会话自己的引擎实例（进程级默认代与邻居实例不动）；
 *   ③ `active_session` 绝不留在已删 id 上：落盘 `workspaces.json` 为 null，
 *      `GET /api/sessions` 的 `active_session` 与 `active` 行自洽；
 *   ④ SSE：被切断的那一回合照常以 `cancelled` 收尾，删除返回之后该会话
 *      **不再有任何帧**（不写悬空帧）；
 *   ⑤ 非活动会话与不存在 id 的行为不变（后者仍进 `failed[]`），
 *      `batch-delete` 仍「永远 200 + per-id failed[]」。
 *
 * 全部断言跑在真文件系统（mkdtemp）＋真 Hono app ＋真 runtime
 * （`packages/runtime` 的真实 agent loop / 工具注册表 / JSONL 会话日志，模型
 * 走离线 LLM 接缝），没有 `vi.mock`，没有伪造的 runtime 替身。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import type { SessionEvent, TurnOutcome } from "@celestea/core";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import type { BusSubscription } from "../sse.js";
import { activate, asPayload, engineOf, makeEngineHarness, turns } from "./test-util.js";

const TRASH = ".celestea-trash";
const ARCHIVE = ".celestea-archived";
/** `FIXED_NOW`（1_700_000_000_000 ms）→ trash 后缀 / 会话目录后缀。 */
const STAMP = "1700000000.0";
const S1 = "sample-ws/s1";

/** 一个「够长、会被中途掐断」的回合：4000 字符 × 8 字符/帧 × 3ms ≈ 1.5s。 */
const SLOW_LLM = { script: [{ text: "x".repeat(4000) }], deltaMs: 3, chunkChars: 8 };

type Row = Record<string, unknown>;

interface Seen {
  event: string;
  session: string | null;
  phase: string;
}

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Drain the bus into an array (the frame's OWN session id is what we assert on). */
function observe(h: StudioHarness): { frames: Seen[]; sub: BusSubscription; done: Promise<void> } {
  const sub = h.studio.services.bus.subscribe();
  const frames: Seen[] = [];
  const done = (async () => {
    for (;;) {
      const frame = await sub.next();
      if (frame === null) return;
      frames.push({
        event: frame.event,
        session: frame.envelope.session,
        phase: String(asPayload(frame.envelope.payload)["phase"] ?? ""),
      });
    }
  })();
  return { frames, sub, done };
}

/** Wait until one observed frame matches (the turn is provably mid-stream). */
async function waitFrame(frames: readonly Seen[], hit: (f: Seen) => boolean, timeoutMs = 3_000): Promise<Seen> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(hit);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`frame not observed (saw ${frames.map((f) => f.event).join(",") || "nothing"})`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The terminal outcome recorded in a session log. */
function lastOutcome(log: string): TurnOutcome | null {
  const events = parseSessionJsonl(log).events as readonly SessionEvent[];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.type === "turn_end") return ev.outcome ?? "completed";
  }
  return null;
}

/** Start a turn that is still streaming when the assertion takes over. */
async function startSlowTurn(h: StudioHarness, frames: readonly Seen[]): Promise<void> {
  const started = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "slow" }));
  expect(started.status).toBe(202);
  await waitFrame(frames, (f) => f.event === "text" && f.session === S1);
  expect(engineOf(h).isBusy(S1)).toBe(true);
}

async function rows(h: StudioHarness, query = ""): Promise<{ rows: Row[]; active: unknown }> {
  const { body } = await getJson(h.app, `/api/sessions${query}`);
  return { rows: (body["sessions"] ?? []) as Row[], active: body["active_session"] };
}

/** `workspaces.json` as it is ON DISK (the落盘 half of the active marker). */
function persistedActive(h: StudioHarness): unknown {
  return (JSON.parse(readFileSync(join(h.root, "workspaces.json"), "utf8")) as { active_session: unknown }).active_session;
}

describe("W794 删除活动会话", () => {
  it("① ② ③ ④：活动会话可删 —— 回合被切断、目录进 trash、实例被释放、active_session 清空、删除后无帧", async () => {
    const h = make({ sessions: { s1: turns(1) }, llm: SLOW_LLM });
    await activate(h, S1);
    expect(engineOf(h).liveSessions()).toContain(S1);
    expect(persistedActive(h)).toBe(S1);
    // 两个唤醒循环：进程级默认代 + s1（删除后只剩默认代，见 ②）。
    expect(engineOf(h).autowakeLoops()).toBe(2);

    const { frames, sub, done } = observe(h);
    await startSlowTurn(h, frames);

    const del = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: [S1] }));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, deleted: 1, failed: [] });

    // ① 目录确实进了 trash（活动会话没有任何特例）
    expect(existsSync(join(h.workspace, "s1"))).toBe(false);
    const trashed = join(h.workspace, TRASH, `s1-${STAMP}`, "cli-main.jsonl");
    expect(existsSync(trashed)).toBe(true);

    // ② in-flight 回合被切断：日志里这一回合以 cancelled 收尾（不是 completed，
    //    也不是被撕成 error），并且引擎侧不再有该会话的实例 / busy 槽 / 唤醒循环
    //    （只有它自己的那份被释放，默认代留下）。
    expect(lastOutcome(readFileSync(trashed, "utf8"))).toBe("cancelled");
    expect(engineOf(h).liveSessions()).not.toContain(S1);
    expect(engineOf(h).isBusy(S1)).toBe(false);
    expect(engineOf(h).autowakeLoops()).toBe(1);

    // ③ active_session 不再指向已删 id：内存视图与落盘文件都必须为 null，
    //    且默认列表里不能有活动行 —— 两者自洽。
    const listed = await rows(h);
    expect(listed.active).toBeNull();
    expect(listed.rows.map((r) => r["id"])).not.toContain(S1);
    expect(listed.rows.every((r) => r["active"] !== true)).toBe(true);
    expect(persistedActive(h)).toBeNull();

    // ④ SSE：被切断的回合以 `cancelled` 收尾（不是悬空帧）……
    expect(frames.some((f) => f.event === "status" && f.session === S1 && f.phase === "cancelled")).toBe(true);
    // ……而删除返回之后，该会话一个帧都不再出现（孤儿回合的收尾被抑制）。
    const mark = frames.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(frames.slice(mark).filter((f) => f.session === S1)).toEqual([]);

    sub.close();
    await done;
  });

  it("④ 结算预算耗尽（回合没能在预算内落定）：照样删得掉，且此后该会话一个帧都不再出现", async () => {
    // `CELESTEA_RELEASE_SETTLE_MS=0` = 协作式取消发出后立刻释放实例（真实世界里
    // 一个卡住的回合就是这样）：孤儿回合随后仍会尝试收尾 —— 那一份收尾必须被
    // W794 的「已 detach」闸门挡住，否则订阅方会收到一个早已不存在的会话的帧。
    const h = make({ sessions: { s1: turns(1) }, llm: SLOW_LLM, env: { CELESTEA_RELEASE_SETTLE_MS: "0" } });
    await activate(h, S1);
    const { frames, sub, done } = observe(h);
    await startSlowTurn(h, frames);

    const del = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: [S1] }));
    expect([del.status, del.body]).toEqual([200, { ok: true, deleted: 1, failed: [] }]);
    expect(existsSync(join(h.workspace, TRASH, `s1-${STAMP}`, "cli-main.jsonl"))).toBe(true);
    expect(engineOf(h).liveSessions()).not.toContain(S1);
    expect(persistedActive(h)).toBeNull();

    // 删除返回之后：该会话不得再产生任何帧，也不得把目录写回来。
    const mark = frames.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(frames.slice(mark).filter((f) => f.session === S1)).toEqual([]);
    expect(existsSync(join(h.workspace, "s1"))).toBe(false);
    sub.close();
    await done;
  });

  it("② 邻居不受影响：只释放被删会话自己的实例（不是全进程重建）", async () => {
    const h = make({ sessions: { keep: turns(1), gone: turns(1) } });
    await activate(h, "sample-ws/keep");
    await activate(h, "sample-ws/gone");
    expect(engineOf(h).liveSessions().sort()).toEqual(["sample-ws/gone", "sample-ws/keep"]);

    const del = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: ["sample-ws/gone"] }));
    expect(del.body).toEqual({ ok: true, deleted: 1, failed: [] });

    // 被删的那个没了，邻居的实例还在（`reused` = 再次 activate 没有重新组装），
    // 邻居的唤醒循环也还在（只有被删会话那份被注销）。
    expect(engineOf(h).liveSessions()).toEqual(["sample-ws/keep"]);
    expect(engineOf(h).autowakeLoops()).toBe(2);
    const again = await getJson(h.app, "/api/sessions/sample-ws%2Fkeep/activate", jsonRequest("POST"));
    expect(again.status).toBe(200);
    expect(again.body["runtime"]).toBe("reused");
    expect(again.body["rebuilt"]).toBe(false);
  });

  it("⑤ 契约不变：非活动会话照删，不存在 id 照进 failed[]，active_session 不动", async () => {
    const h = make({ sessions: { keep: turns(1), gone: turns(1) } });
    await activate(h, "sample-ws/keep");

    const del = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: ["sample-ws/gone", "sample-ws/ghost"] }));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({
      ok: true,
      deleted: 1,
      failed: [{ id: "sample-ws/ghost", error: "unknown session 'sample-ws/ghost'" }],
    });
    expect(existsSync(join(h.workspace, TRASH, `gone-${STAMP}`, "cli-main.jsonl"))).toBe(true);

    // 删的不是活动会话：active_session 原样保留，并且列表里那一行确实是 active。
    const listed = await rows(h);
    expect(listed.active).toBe("sample-ws/keep");
    expect(listed.rows.map((r) => r["id"])).toEqual(["sample-ws/keep"]);
    expect(listed.rows[0]?.["active"]).toBe(true);
    expect(persistedActive(h)).toBe("sample-ws/keep");
  });
});

describe("W794 归档活动会话", () => {
  it("归档活动会话成功：同样先切断回合，目录进 .celestea-archived，active_session 清空", async () => {
    const h = make({ sessions: { s1: turns(1) }, llm: SLOW_LLM });
    await activate(h, S1);
    const { frames, sub, done } = observe(h);
    await startSlowTurn(h, frames);

    const arch = await getJson(h.app, `/api/sessions/${encodeURIComponent(S1)}/archive`, jsonRequest("POST"));
    expect(arch.status).toBe(200);
    expect(arch.body).toEqual({ ok: true });

    // 目录进了归档（id 保留，可回滚），并且那一回合被切断。
    expect(existsSync(join(h.workspace, "s1"))).toBe(false);
    const archivedLog = join(h.workspace, ARCHIVE, "s1", "cli-main.jsonl");
    expect(existsSync(archivedLog)).toBe(true);
    expect(lastOutcome(readFileSync(archivedLog, "utf8"))).toBe("cancelled");
    expect(engineOf(h).liveSessions()).not.toContain(S1);

    // 归档行不再是活动行：默认列表没有它、active_session 为 null（内存 + 落盘）。
    const listed = await rows(h);
    expect(listed.active).toBeNull();
    expect(listed.rows.map((r) => r["id"])).not.toContain(S1);
    expect(persistedActive(h)).toBeNull();

    // `?archived=1` 里它仍然在，且 active 恒为 false（与 active_session 自洽）。
    const arch2 = await rows(h, "?archived=1");
    expect(arch2.rows.map((r) => r["id"])).toEqual([S1]);
    expect(arch2.rows[0]?.["active"]).toBe(false);
    expect(arch2.active).toBeNull();

    // 归档同样不向订阅方留悬空帧。
    const mark = frames.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(frames.slice(mark).filter((f) => f.session === S1)).toEqual([]);
    sub.close();
    await done;
  });
});
