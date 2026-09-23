/**
 * The iteration-E recovery audit channel (E §5.2③, P1).
 *
 * §5.2③: every automatic or observed recovery fact must appear in three places —
 * an append-only local log, a structured field and an audit line. W730's P0
 * deliberately deferred the audit half of the checkpoint capability because
 * inventing a second audit FILE then had no owner; P1 is that owner, and this is
 * the ONE channel both P1 capabilities write through:
 *
 *   - `log_degraded`      — a session log refused a write (`writeErrorCount>0`):
 *                           disk and memory forked, and nobody would ever know;
 *   - `worker_stale`      — a persisted worker row whose owning process is dead;
 *   - `worker_orphan`     — a RUNNING row whose `host=` session is gone;
 *   - `worker_observed`   — the boot sweep's summary line (always exactly one);
 *   - `worker_recovered`  — W1470 P2: a stale row was CLAIMED and settled
 *                           (`CELESTEA_WORKER_RECOVER=1` only; absent otherwise);
 *   - `session_repaired`  — a crashed turn was closed by appending ONE
 *                           `turn_end: interrupted` row (§1.2.3, R1-1).
 *
 * Discipline (identical to `grants-audit.jsonl` / `fallbacks-audit.jsonl`):
 * local append-only `<data dir>/recovery-audit.jsonl`, mode 0600, rotated at
 * 16 MiB; the platform `POST /api/audit` is BEST-EFFORT and only when
 * `CELESTEA_AUDIT_URL` is set. A failed write is reported, never thrown — an
 * audit channel must not be able to break the thing it observes. Nothing here
 * ever records a prompt, a command line or a credential: wid / turn_id / count
 * only (§4.4).
 */

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECOVERY_AUDIT_FILE = "recovery-audit.jsonl";
/** Rotate at 16 MiB, keeping the previous chain (LTS ops audit rules). */
export const RECOVERY_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
export const ENV_AUDIT_URL = "CELESTEA_AUDIT_URL";
export const ENV_CENTER_TOKEN = "CELESTEA_CENTER_TOKEN";

export type RecoveryAuditEventName =
  | "log_degraded"
  | "session_repaired"
  | "worker_stale"
  | "worker_orphan"
  | "worker_observed"
  | "worker_recovered";

/** One audit line. `session` is null for process-level facts. */
export interface RecoveryAuditEvent {
  ts: number;
  event: RecoveryAuditEventName;
  session: string | null;
  /** Worker id (worker events). */
  wid?: string;
  /** Which attempt of that worker the row was on. */
  attempt?: number;
  /** The host session the row was dispatched from (`host=`). */
  host_session?: string | null;
  /** Why the observer flagged the row (`stale_lease` / `orphan_host`). */
  reason?: string;
  /** What P2 WOULD do — recorded so the future action is auditable up front. */
  action?: string;
  /** Turn id (log events) / row counts (sweep events). */
  turn_id?: string | null;
  count?: number;
  detail?: string;
}

export interface RecoveryAuditOptions {
  /** `<data dir>` — the audit file lives next to workspaces.json. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injected transport (tests); default `fetch`. */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
}

export class RecoveryAuditWriter {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly post: NonNullable<RecoveryAuditOptions["post"]>;
  /** Diagnostics of failed writes (never thrown): the caller reports them. */
  readonly errors: string[] = [];

  constructor(opts: RecoveryAuditOptions) {
    this.path = join(opts.dataDir, RECOVERY_AUDIT_FILE);
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.post = opts.post ?? defaultPost;
  }

  get filePath(): string {
    return this.path;
  }

  /** Append one line (local first, platform best-effort — §4.4). */
  write(event: Omit<RecoveryAuditEvent, "ts"> & { ts?: number }): void {
    const line: RecoveryAuditEvent = { ts: event.ts ?? this.now(), ...event };
    this.append(line);
    this.deliver(line);
  }

  private append(line: RecoveryAuditEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.rotate();
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (e) {
      this.errors.push(messageOf(e));
    }
  }

  /** 16 MiB ceiling: the previous chain becomes `<path>.1` (replaced). */
  private rotate(): void {
    try {
      if (statSync(this.path).size < RECOVERY_AUDIT_MAX_BYTES) return;
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // No file yet (first write) or an unreadable one: nothing to rotate.
    }
  }

  /** Best-effort platform channel; its own failure is recorded locally. */
  private deliver(line: RecoveryAuditEvent): void {
    const url = this.env[ENV_AUDIT_URL];
    if (url === undefined || url.trim() === "") return;
    const token = this.env[ENV_CENTER_TOKEN] ?? "";
    const body = JSON.stringify({ category: "audit", summary: `[recovery] ${line.event}`, detail: line });
    void this.post(url, body, { "content-type": "application/json", "x-center-token": token }).catch((e: unknown) => {
      this.errors.push(`platform audit failed: ${messageOf(e)}`);
    });
  }
}

async function defaultPost(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, { method: "POST", body, headers });
  return { ok: response.ok, status: response.status };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
