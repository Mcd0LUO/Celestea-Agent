/**
 * Internal helpers of the usage ledger (W836 R3 batch F), split out so
 * `ledger.ts` stays inside the repository file budget:
 *   - [readLedgerRecords] parses ONE ledger file (current or rolled `.1`);
 *   - [LedgerKeySet] is the BOUNDED idempotency-key memory (P2-5): keys are
 *     evicted per closed turn, with a size cap as the backstop.
 */

import { readFileSync } from "node:fs";

/** Every readable record of one ledger path (an unparsable line is skipped). */
export function readLedgerRecords<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as T);
    } catch {
      // A torn/foreign line never hides the rows around it.
    }
  }
  return out;
}

/** Bounded in-process idempotency keys: per-turn eviction + a size cap. */
export class LedgerKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly max: number) {}

  /** True when this writer already booked the key (the row must be skipped). */
  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Size of the memory (bounded-memory diagnostics / tests). */
  get size(): number {
    return this.keys.size;
  }

  /** Remember one booked key, trimming the OLDEST keys past the cap. */
  add(key: string): void {
    this.keys.add(key);
    if (this.keys.size <= this.max) return;
    let excess = this.keys.size - this.max;
    for (const key2 of this.keys) {
      if (excess <= 0) break;
      this.keys.delete(key2);
      excess -= 1;
    }
  }

  /**
   * Drop the keys of ONE closed turn: an in-flight turn keeps its keys, so a
   * duplicate step booked while it is still open is still refused. A `null`
   * turn id (an out-of-turn row) is left to the size cap.
   */
  evictTurn(session: string, turnId: string | null): void {
    if (turnId === null) return;
    const prefix = `${session}|${turnId}|`;
    for (const key of this.keys) if (key.startsWith(prefix)) this.keys.delete(key);
  }
}
