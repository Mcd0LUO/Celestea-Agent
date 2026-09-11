/**
 * Turn-id ownership after a recovery (iteration E §1.3 P0 ④ / assertion A4).
 *
 * The counter is restored FROM THE LOG (`max turn-<n> + 1`), and the recovery
 * appends a row for a turn that is ALREADY in the log — so the next id a
 * recovered session hands out must still be the next FREE number, never a reuse
 * of the turn the crash interrupted.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSessionEvent, type SessionEvent } from "@celestea/core";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_VERSION, checkpointPathFor, CheckpointStore, type Checkpoint } from "./checkpoint.js";
import { recoverOpenTurn } from "./checkpoint-recovery.js";
import { filePathFor } from "./log/file.js";
import { PersistentSessionLog } from "./log/persistent.js";
import { auditTurnIds, maxTurnNumber, nextTurnId, nextTurnNumber, parseTurnNumber } from "./turn-id.js";

const SESSION = "ws/s1";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function turn(n: number): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `问 ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome: "completed" },
  ];
}

describe("turn id math", () => {
  it("ignores legacy ids and never reuses a number already on disk", () => {
    const events: SessionEvent[] = [{ type: "turn_start", id: "t1" }, ...turn(0), ...turn(7)];
    expect(parseTurnNumber("t1")).toBeNull();
    expect(maxTurnNumber(events)).toBe(7);
    expect(nextTurnNumber(events)).toBe(8);
    expect(nextTurnId(events)).toBe("turn-8");
    expect(auditTurnIds(events).malformed).toEqual(["t1"]);
  });
});

describe("A4: a recovered session keeps handing out FRESH ids", () => {
  it("nextTurnId() continues past the interrupted turn and the audit stays clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-id-"));
    roots.push(dir);
    const events: SessionEvent[] = [...turn(0), ...turn(1), ...turn(2), ...turn(3), { type: "turn_start", id: "turn-4" }];
    writeFileSync(filePathFor(dir, "cli-main"), `${events.map((ev) => serializeSessionEvent(ev)).join("\n")}\n`);
    const checkpoint: Checkpoint = {
      version: CHECKPOINT_VERSION,
      session: SESSION,
      pid: 1,
      boot_id: "b-00000000",
      updated_at: 1,
      clean_shutdown: false,
      open_turn: { id: "turn-4", started_at: 1 },
      last_outcome: null,
      degraded: { log_write_errors: 0 },
      lanes: { next_turn: [], next_step: [] },
      repaired: [],
    };
    writeFileSync(checkpointPathFor(dir), JSON.stringify(checkpoint));

    const log = PersistentSessionLog.open(dir, "cli-main");
    expect(log.peekTurnNumber()).toBe(5); // restored from the log, not from memory
    const outcome = recoverOpenTurn(log, new CheckpointStore({ dir, session: SESSION, identity: { boot_id: "b-1", pid: 2 } }));
    expect(outcome.action).toBe("closed_turn");

    const next = log.nextTurnId();
    expect(next).toBe("turn-5");
    log.append({ type: "turn_start", id: next });
    const audit = auditTurnIds(log.events());
    expect(audit.duplicates).toEqual([]);
    expect(audit.nonMonotonic).toEqual([]);
    expect(audit.malformed).toEqual([]);
    log.close();
  });
});
