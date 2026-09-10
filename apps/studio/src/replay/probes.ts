/**
 * The end-to-end probes of one replayed session: a REAL turn through the host,
 * the SSE transport check and the compaction probe.
 *
 * Every probe reads back the artifact it produced (the JSONL file, the SSE wire,
 * the `.precompact` backup) so the report can state byte-level facts instead of
 * "the call returned 200".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionJsonl } from "@celestea/session";
import { serializeEventLog } from "@celestea/runtime";
import { SESSION_LOG_NAME } from "../runtime/engine-session.js";
import type { SseEventName } from "@celestea/core";
import { compareBytes, compareJson, note, type Finding } from "./compare.js";
import { expectedCompactLog, headSummary, rawTurnBodies } from "./expect-compact.js";
import type { ReplayHost } from "./host.js";

/** Terminal status phases of a turn. */
const TERMINAL = ["completed", "cancelled", "error", "step_limit", "interrupted"];
/** The frozen "nothing to compact" note. */
export const SKIP_NOTE = "历史不足，无需压缩";
/** The frozen compacted note for K = 4. */
export const COMPACT_NOTE = "已压缩：摘要轮 + 最近4轮";

export interface WireFrame {
  event: string;
  turn: number;
  payload: Record<string, unknown>;
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** Activate a session over the HTTP contract (the engine binds it per turn). */
export async function activate(host: ReplayHost, id: string): Promise<number> {
  const res = await host.app.request(`/api/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" });
  return res.status;
}

/** Wait until the host reports the engine idle again. */
export async function waitIdle(host: ReplayHost, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (host.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("engine did not settle");
    await delay(5);
  }
}

/** Drive one real turn over `POST /api/turn`, collecting its SSE frames. */
export async function runTurn(host: ReplayHost, input: string): Promise<{ status: number; frames: WireFrame[] }> {
  const sub = host.studio.services.bus.subscribe();
  const frames: WireFrame[] = [];
  const res = await host.app.request("/api/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) });
  if (res.status === 202) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const frame = await Promise.race([sub.next(), delay(left)]);
      if (frame === null) break;
      const payload = (frame.envelope.payload ?? {}) as Record<string, unknown>;
      frames.push({ event: frame.event, turn: frame.envelope.turn, payload });
      if (frame.event === "status" && TERMINAL.includes(String(payload["phase"]))) break;
    }
  }
  sub.close();
  await waitIdle(host);
  return { status: res.status, frames };
}

/** Byte-level checks of the turn a probe appended to a session log. */
export function turnFindings(id: string, before: string, after: string, input: string, frames: readonly WireFrame[]): Finding[] {
  const findings: Finding[] = [];
  const newEvents = parseSessionJsonl(after).events.slice(parseSessionJsonl(before).events.length);
  findings.push(compareBytes(`${id} :: turn-append-bytes`, before + serializeEventLog(newEvents), after, "appended turn is exactly its serialized events"));
  findings.push(
    compareJson(
      `${id} :: turn-append-shape`,
      "byte-exact",
      ["turn_start", "user_message", "assistant_message", "turn_end"],
      newEvents.map((e) => e.type),
      "appended turn shape",
    ),
  );
  const text = newEvents.find((e) => e.type === "assistant_message");
  findings.push(
    compareJson(`${id} :: turn-answer`, "byte-exact", `echo: ${input}`, text?.type === "assistant_message" ? text.text : null, "offline answer"),
  );
  const end = newEvents.find((e) => e.type === "turn_end");
  findings.push(compareJson(`${id} :: turn-outcome`, "byte-exact", "completed", end?.type === "turn_end" ? end.outcome : null, "terminal outcome"));
  const names = frames.map((f) => f.event);
  const ok = names[0] === "status" && names.includes("turn_end") && names[names.length - 1] === "status";
  findings.push(
    ok
      ? note(`${id} :: turn-sse`, "byte-exact", `turn frames ${names.join(">")}`, "match")
      : note(`${id} :: turn-sse`, "golden", `turn frames ${names.join(">")}`, "diff"),
  );
  return findings;
}

/** Parse the SSE wire text produced by `GET /api/events` into frames. */
export function parseWire(text: string): WireFrame[] {
  const out: WireFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (eventLine === undefined || dataLine === undefined) continue;
    const envelope = JSON.parse(dataLine.slice("data: ".length)) as { turn: number; payload: unknown };
    out.push({ event: eventLine.slice("event: ".length), turn: envelope.turn, payload: (envelope.payload ?? {}) as Record<string, unknown> });
  }
  return out;
}

/**
 * Push frames through the REAL `GET /api/events` endpoint and read them back.
 * Frames are emitted in bursts smaller than the bus capacity (512): a larger
 * backlog would be DROPPED on purpose (the frozen `lagged` degradation), which
 * is a property of the bus, not of the replay.
 */
export interface SseCapture {
  frames: WireFrame[];
  /** Raw SSE blocks (`event: …\ndata: …`) exactly as the endpoint wrote them. */
  blocks: string[];
}

export async function captureSseWire(host: ReplayHost, frames: readonly WireFrame[], timeoutMs = 20_000): Promise<SseCapture> {
  const res = await host.app.request("/api/events");
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("/api/events returned no body");
  await delay(20); // let the streamSSE handler subscribe before the first emit
  const decoder = new TextDecoder();
  let wire = "";
  const burst = 128;
  for (let i = 0; i < frames.length; i += burst) {
    const target = Math.min(i + burst, frames.length);
    for (const frame of frames.slice(i, target)) host.studio.services.bus.emit(frame.event as SseEventName, frame.turn, frame.payload);
    const deadline = Date.now() + timeoutMs;
    while (parseWire(wire).length < target && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), delay(300).then(() => null)]);
      if (chunk === null || chunk.done === true) break;
      wire += decoder.decode(chunk.value);
    }
  }
  await reader.cancel();
  return { frames: parseWire(wire), blocks: wire.split("\n\n").filter((b) => b.trim() !== "") };
}

/**
 * Byte-level wire check: every frame the endpoint wrote must equal the block
 * re-serialized from its own envelope — which pins the field ORDER
 * (`{turn,seq,payload}`), the SSE framing and one-block-per-frame, not merely
 * the parsed values.
 */
export function compareSseWire(scope: string, expected: readonly WireFrame[], capture: SseCapture, note: string): Finding {
  if (capture.frames.length !== expected.length) {
    return wireDiff(scope, `${note}: ${capture.frames.length} frame(s) on the wire, expected ${expected.length}`, []);
  }
  const diffs: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    const frame = expected[i] as WireFrame;
    const block = capture.blocks[i] ?? "";
    // `seq` is a process-global counter the replay cannot predict: take it off
    // the wire, then demand the REST of the block be byte-identical.
    const seq = seqOf(block);
    const rebuilt = `event: ${frame.event}\ndata: ${JSON.stringify({ turn: frame.turn, seq, payload: frame.payload })}`;
    if (block !== rebuilt && diffs.length < 3) diffs.push(`$[${i}] wire block differs: ${block.slice(0, 80)} != ${rebuilt.slice(0, 80)}`);
  }
  if (diffs.length > 0) return wireDiff(scope, `${note}: ${diffs.length} wire divergence(s)`, diffs);
  return { scope, kind: "byte-exact", verdict: "match", detail: `${note}: ${capture.frames.length} wire block(s) byte-identical (envelope order turn,seq,payload)` };
}

/** One wire-level divergence finding (only byte-level evidence is reported here). */
function wireDiff(scope: string, detail: string, diffs: string[]): Finding {
  return { scope, kind: "byte-exact", verdict: "diff", detail, diffs };
}

/** `seq` of a written block (a process-global counter the replay cannot predict). */
function seqOf(block: string): number | null {
  const data = block.split("\n").find((l) => l.startsWith("data: "));
  if (data === undefined) return null;
  try {
    return (JSON.parse(data.slice("data: ".length)) as { seq?: number }).seq ?? null;
  } catch {
    return null;
  }
}

/** SSE comparison of a session's derived transcript + the wire-level transport check. */
export function sseFindings(id: string, derived: unknown[], golden: unknown[] | null, capture: SseCapture): Finding[] {
  const findings: Finding[] = [];
  if (golden === null) {
    findings.push(note(`${id} :: sse-transcript`, "self-check", `golden transcript not stored for this session; ${derived.length} frame(s) regenerated in-memory`));
  } else {
    findings.push(compareJson(`${id} :: sse-transcript`, "self-check", golden, derived, "TS-derived transcript (Rust capture is a P6 gap)"));
  }
  const expected = (derived as Array<{ event: string; data: { turn: number; payload: Record<string, unknown> } }>).map((f) => ({
    event: f.event,
    turn: f.data.turn,
    payload: f.data.payload,
  }));
  const source = golden === null ? "TS-derived frames" : "stored golden transcript frames";
  findings.push(compareSseWire(`${id} :: sse-transport`, expected, capture, `GET /api/events replayed ${source}`));
  return findings;
}

/** The compaction probe: run it over HTTP and verify every produced artifact. */
export async function compactFindings(host: ReplayHost, id: string, dir: string): Promise<Finding[]> {
  const logPath = join(dir, SESSION_LOG_NAME);
  const before = readFileSync(logPath, "utf8");
  const beforeEvents = parseSessionJsonl(before).events;
  const sub = host.studio.services.bus.subscribe();
  const res = await host.app.request(`/api/sessions/${encodeURIComponent(id)}/compact`, { method: "POST" });
  const body = (await res.json()) as Record<string, unknown>;
  const frame = await Promise.race([sub.next(), delay(2_000)]);
  sub.close();
  const after = readFileSync(logPath, "utf8");
  return expectedCompactLog(beforeEvents, "", 4) === null
    ? shortHistoryFindings(id, before, after, body, frame)
    : compactedFindings({ id, dir, before, after, body, frame });
}

/** History at/below the threshold: nothing may change. */
function shortHistoryFindings(id: string, before: string, after: string, body: Record<string, unknown>, frame: unknown): Finding[] {
  const findings = [compareBytes(`${id} :: compact-log`, before, after, "log untouched (history below threshold)")];
  findings.push(compareJson(`${id} :: compact-response`, "golden", { compacted: false, note: SKIP_NOTE }, { compacted: body["compacted"], note: body["note"] }, "skip branch"));
  findings.push(skipFrameFinding(id, frame));
  return findings;
}

function skipFrameFinding(id: string, frame: unknown): Finding {
  const payload = frame === null ? null : ((frame as { envelope: { payload: unknown } }).envelope.payload as Record<string, unknown>);
  return compareJson(`${id} :: compact-sse`, "golden", { compacted: false, note: SKIP_NOTE }, { compacted: false, note: payload?.["note"] }, "compact frame");
}

/** Everything one compacted-branch comparison needs (one param: max-params=5). */
interface CompactedInput {
  id: string;
  dir: string;
  before: string;
  after: string;
  body: Record<string, unknown>;
  frame: unknown;
}

/** History above the threshold: structure, backup and kept-turn bytes. */
function compactedFindings(input: CompactedInput): Finding[] {
  const { id, dir, before, after, body, frame } = input;
  const findings: Finding[] = [];
  const events = parseSessionJsonl(after).events;
  const summary = headSummary(events);
  const expected = summary === null ? null : expectedCompactLog(parseSessionJsonl(before).events, summary, 4);
  if (expected === null) {
    findings.push(note(`${id} :: compact-log`, "spec-derived", "compacted log has no 【上下文压缩】 head turn", "diff"));
  } else {
    findings.push(compareBytes(`${id} :: compact-log`, serializeEventLog(expected), after, "independent re-derivation of the W259 plan"));
  }
  findings.push(compareBytes(`${id} :: compact-backup`, before, readFileSync(join(dir, "cli-main.jsonl.precompact"), "utf8"), ".precompact backup of the pre-compaction log"));
  const keptBefore = rawTurnBodies(before, parseSessionJsonl).slice(-4);
  const keptAfter = rawTurnBodies(after, parseSessionJsonl).slice(-4);
  findings.push(compareJson(`${id} :: compact-kept-turn-bodies`, "byte-exact", keptBefore, keptAfter, "kept turns are byte-identical apart from renumbering"));
  findings.push(compareJson(`${id} :: compact-response`, "golden", { compacted: true, kept_turns: 4, note: COMPACT_NOTE }, { compacted: body["compacted"], kept_turns: body["kept_turns"], note: body["note"] }, "compacted branch"));
  const payload = frame === null ? null : ((frame as { envelope: { payload: unknown } }).envelope.payload as Record<string, unknown>);
  findings.push(compareJson(`${id} :: compact-sse`, "golden", { session: id, kept_turns: 4, note: COMPACT_NOTE, rebound: true }, payload, "compact frame"));
  return findings;
}
