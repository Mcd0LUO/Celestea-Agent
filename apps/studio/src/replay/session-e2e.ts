/**
 * One replayed session: the four comparison families of the P5 double run.
 *
 *   1. **session log JSONL** — replay the golden log through the TS engine's own
 *      persistent log and re-serialize it: the bytes must come back identical
 *      (codec + replay fidelity), and the file itself must stay untouched;
 *   2. **messages projection** — `GET /api/sessions/{id}/messages` over the REAL
 *      host vs the Rust capture (`messages-expected.json`) + the engine's own
 *      `derive_messages` vs its stored derivation;
 *   3. **SSE sequence** — the derived transcript vs the stored golden, and the
 *      same frames pushed through the real `GET /api/events` endpoint;
 *   4. **real turn + compaction** — a probe turn appended by the engine (byte
 *      level), then compaction over HTTP with an independently re-derived plan.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMessages, deriveSseTranscript, parseSessionJsonl, PersistentSessionLog } from "@celestea/session";
import type { SessionEvent } from "@celestea/core";
import { serializeEventLog } from "@celestea/runtime";
import { compareBytes, compareJson, note, tally, type Finding } from "./compare.js";
import { fixtureFiles, readJson, readJsonl, plantFixture, splitSessionId, type FixtureSession } from "./fixtures.js";
import type { ReplayHost } from "./host.js";
import { SESSION_LOG_ID, SESSION_LOG_NAME } from "../runtime/engine-session.js";
import { activate, captureSseWire, compactFindings, runTurn, sseFindings, turnFindings, type WireFrame } from "./probes.js";

export interface SessionE2E {
  id: string;
  slug: string;
  roles: string[];
  events: number;
  turns: number;
  findings: Finding[];
  verdict: "match" | "diff";
}

export interface ReplaySessionOptions {
  host: ReplayHost;
  fixturesDir: string;
  entry: FixtureSession;
  /** Input of the probe turn appended to the session copy. */
  probeInput?: string;
}

/** Replay one fixture session end to end and collect its findings. */
export async function replaySession(opts: ReplaySessionOptions): Promise<SessionE2E> {
  const { host, entry } = opts;
  const files = fixtureFiles(opts.fixturesDir, entry.slug);
  const planted = plantFixture(host.root, files, entry.id);
  const events = parseSessionJsonl(planted.logBytes).events;
  const findings: Finding[] = [...logFindings(entry.id, planted.logBytes)];
  findings.push(...(await messagesFindings(host, entry.id, files.messages, files.derivedMessages, events)));
  findings.push(...(await sseChecks(host, entry.id, files.sse, events)));

  const input = opts.probeInput ?? "P5 重放探针";
  const status = await activate(host, entry.id);
  const turn = await runTurn(host, input);
  const after = readFileSync(join(planted.dir, SESSION_LOG_NAME), "utf8");
  findings.push(...turnFindings(entry.id, planted.logBytes, after, input, turn.frames));
  if (status !== 200) findings.push(note(`${entry.id} :: activate`, "golden", `activate returned ${status}`, "diff"));
  findings.push(...(await compactFindings(host, entry.id, planted.dir)));

  const counts = tally(findings);
  return { id: entry.id, slug: entry.slug, roles: entry.roles, events: events.length, turns: entry.turns, findings, verdict: counts.diffed === 0 ? "match" : "diff" };
}

/** Family 1: the golden log replayed and re-serialized, byte for byte. */
export function logFindings(id: string, goldenText: string): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), "replay-log-"));
  try {
    const path = join(dir, SESSION_LOG_NAME);
    writeFileSync(path, goldenText, "utf8");
    const log = PersistentSessionLog.open(dir, SESSION_LOG_ID);
    const findings = [
      compareBytes(`${id} :: session-log-jsonl`, goldenText, serializeEventLog(log.events()), "replay -> re-serialize"),
      compareBytes(`${id} :: session-log-file`, goldenText, readFileSync(path, "utf8"), "replay kept the file untouched"),
    ];
    findings.push(
      log.tornTail === null
        ? note(`${id} :: session-log-replay`, "byte-exact", `${log.events().length} event(s), no torn tail, next turn id turn-${log.peekTurnNumber()}`, "match")
        : note(`${id} :: session-log-replay`, "golden", `torn tail at line ${log.tornTail.line}`, "diff"),
    );
    log.close();
    return findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Family 2: the Studio projection (golden) + the engine projection (self-check). */
export async function messagesFindings(
  host: ReplayHost,
  id: string,
  messagesFile: string,
  derivedFile: string,
  events: readonly SessionEvent[],
): Promise<Finding[]> {
  const res = await host.app.request(`/api/sessions/${encodeURIComponent(id)}/messages`);
  const body = (await res.json()) as { messages?: unknown[] };
  const golden = readJson<{ messages: unknown[] }>(messagesFile).messages;
  return [
    compareJson(`${id} :: messages-projection`, "golden", golden, body.messages ?? [], `GET /api/sessions/{id}/messages (${res.status})`),
    compareJson(`${id} :: engine-derive-messages`, "self-check", readJson<{ messages: unknown[] }>(derivedFile).messages, deriveMessages(events), "engine model-visible history"),
  ];
}

/** Family 3: derived transcript vs the stored golden, then the SSE transport. */
export async function sseChecks(host: ReplayHost, id: string, sseFile: string | null, events: readonly SessionEvent[]): Promise<Finding[]> {
  const derived = deriveSseTranscript(events) as unknown[];
  const golden = sseFile === null ? null : readJsonl(sseFile);
  const expected: WireFrame[] = (derived as Array<{ event: string; data: { turn: number; payload: Record<string, unknown> } }>).map((f) => ({
    event: f.event,
    turn: f.data.turn,
    payload: f.data.payload,
  }));
  const capture = await captureSseWire(host, expected, id);
  return sseFindings(id, derived, golden, capture);
}

/** Where a planted session copy lives (report / debugging aid). */
export function plantedDir(host: ReplayHost, id: string): string {
  const { workspace, session } = splitSessionId(id);
  return join(host.root, workspace, session);
}
