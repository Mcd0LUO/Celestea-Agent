/**
 * Grants audit trail (W516 §4.4): the LOCAL channel is authoritative, the
 * platform channel is best-effort.
 *
 * - local: `<data dir>/grants-audit.jsonl`, append-only, one JSON event per
 *   line, mode 0600, rotated at 16 MiB keeping the previous chain as
 *   `grants-audit.jsonl.1` (the same discipline as the server-center audit);
 * - platform: `POST <audit url> {category, summary, detail}` (server-center,
 *   `x-center-token`). Delivery NEVER blocks a grant, and a delivery that did
 *   not happen is recorded locally as `platform_audit_failed` — a write failure
 *   is reported, never swallowed.
 *
 * Grants cannot switch this off: nothing here reads `grants.json` (§5.6).
 */

import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const GRANTS_AUDIT_FILE = "grants-audit.jsonl";
/** Rotate at 16 MiB, keeping the previous chain (§4.4 / LTS ops audit rules). */
export const AUDIT_MAX_BYTES = 16 * 1024 * 1024;
export const ENV_AUDIT_URL = "CELESTEA_AUDIT_URL";
export const ENV_CENTER_TOKEN = "CELESTEA_CENTER_TOKEN";
/** server-center contract port (LTS ops: 127.0.0.1:8390). */
export const DEFAULT_AUDIT_URL = "http://127.0.0.1:8390/api/audit";

export type GrantsAuditEventName =
  | "grant"
  | "revoke"
  | "use"
  | "expire"
  | "deny"
  | "grants_unreadable"
  | "platform_audit_failed"
  | "degraded_by_grant"
  | "net_hosts_ineffective";

/** One audit line. Optional fields are the documented per-event extras. */
export interface GrantsAuditEvent {
  ts: number;
  event: GrantsAuditEventName;
  session: string;
  grant_id?: string;
  cap?: string;
  scope?: unknown;
  actor?: string;
  expires_at?: number | null;
  uses_left?: number | null;
  effective_after?: unknown;
  /** Free-form, ALREADY credential-free text (never a command line, §4.4). */
  detail?: string;
  tool?: string;
  pid?: number;
  provider?: string;
  reason?: string;
}

/** The sink the runtime layer writes through (see `engine-grants.ts`). */
export type GrantsAuditSink = (event: Omit<GrantsAuditEvent, "ts" | "session"> & { session: string; ts?: number }) => void;

export interface GrantsAuditOptions {
  /** `<data dir>` — the audit file lives next to workspaces.json. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injected transport (tests); default `fetch`. */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
}

export class GrantsAuditWriter {
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly post: NonNullable<GrantsAuditOptions["post"]>;
  private pending: Promise<void>[] = [];

  constructor(opts: GrantsAuditOptions) {
    this.dataDir = opts.dataDir;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.post = opts.post ?? httpPost;
  }

  /** Absolute path of the local (authoritative) channel. */
  get path(): string {
    return join(this.dataDir, GRANTS_AUDIT_FILE);
  }

  /** Append locally, then try the platform channel (never throws). */
  write(event: Omit<GrantsAuditEvent, "ts"> & { ts?: number }): void {
    const line: GrantsAuditEvent = { ts: event.ts ?? Math.floor(this.now() / 1000), ...event } as GrantsAuditEvent;
    appendLocal(this.path, line);
    this.pending.push(this.deliver(line));
  }

  /** Await every in-flight platform delivery (tests / shutdown). */
  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }

  /** The sink closed over nothing: callers pass the session explicitly. */
  sink(): GrantsAuditSink {
    return (event) => this.write(event);
  }

  private async deliver(line: GrantsAuditEvent): Promise<void> {
    const url = this.env[ENV_AUDIT_URL] ?? DEFAULT_AUDIT_URL;
    const token = this.env[ENV_CENTER_TOKEN];
    const body = JSON.stringify({
      category: "audit",
      summary: `grants ${line.event} ${line.session}${line.cap === undefined ? "" : ` ${line.cap}`}`,
      detail: JSON.stringify(line).slice(0, 8192),
    });
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token !== undefined && token !== "") headers["x-center-token"] = token;
      const res = await this.post(url, body, headers);
      if (!res.ok) this.failed(url, `http ${res.status}`);
    } catch (e) {
      this.failed(url, e instanceof Error ? e.message : String(e));
    }
  }

  /** A delivery that did not happen is a LOCAL line — never silence. */
  private failed(url: string, reason: string): void {
    appendLocal(this.path, {
      ts: Math.floor(this.now() / 1000),
      event: "platform_audit_failed",
      session: "",
      reason,
      detail: `platform audit channel did not accept the event (url=${url})`,
    });
  }
}

/** append-only + 16 MiB rotation; a failing file is reported to stderr. */
function appendLocal(path: string, line: GrantsAuditEvent): void {
  try {
    if (existsSync(path) && statSync(path).size >= AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`grants audit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5_000) });
  return { ok: res.ok, status: res.status };
}
