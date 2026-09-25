/**
 * W1528 — `POST /api/terminal`, `POST /api/terminal/{id}/input`,
 * `POST /api/terminal/{id}/close` (the real-PTY face of the workbench terminal).
 *
 * ## The three rules this handler inherits from `exec.ts` (G2)
 *
 *   1. **The same permission gate.** A preset whose `toolDeny` contains
 *      `run_shell` denies the terminal too — `shellDeniedReason()` is the ONE
 *      reader of that decision, so the UI cannot disagree with what a turn would
 *      allow. A denied open is a structured 403 (`code=shell_denied`), never a
 *      bare run.
 *   2. **The same execution boundary.** `sandboxFor()` picks the provider
 *      exactly as the engine does (provider policy + session scope + grants), so
 *      the pty lives inside bwrap when bwrap is the posture. This file never
 *      spawns anything itself: the only process it can start is the one
 *      `sandbox.spawn()` starts.
 *   3. **Not a tool.** Nothing here touches the model-visible tool face
 *      (`contracts/tools.json` is untouched).
 *
 * ## Output channel: SSE, not polling
 *
 * Bytes go out on the `terminal` SSE event (the contract's 10th name), keyed by
 * `{id, session, data}`. SSE was chosen over a polling endpoint because a pty
 * is a STREAM: polling would either drop bytes between ticks or need a cursor
 * protocol duplicating what the bus already does. The bus is lossy under
 * back-pressure BY CONTRACT (it emits a `lagged` status instead of blocking),
 * which is the honest behaviour for a terminal — the alternative is a slow
 * client stalling the child's output pipe.
 *
 * ## Input channel: HTTP, because SSE is one-way
 *
 * `POST /api/terminal/{id}/input` writes the raw body bytes to the child's stdin
 * **verbatim** — no newline is appended, because the Enter key is a byte the
 * terminal client sends (`\r`), not something the server should invent. That is
 * what makes a REPL work: the same endpoint carries `p`, `r`, `i`, `n`, `t`,
 * `\r` and then the next line.
 */

import { StringDecoder } from "node:string_decoder";
import type { Context, Hono } from "hono";
import { errText } from "../store/result.js";
import type { RouteTable } from "../routes.js";
import { failJson, readJsonBody, strField, numField, type Deps } from "./common.js";
import {
  clampDim,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  ptyCommand,
  ptySupport,
  TERMINAL_LIMIT_CODE,
  TERMINAL_GONE_CODE,
  TERMINAL_UNAVAILABLE_CODE,
  TerminalRegistry,
  terminateTree,
} from "./terminal-pty.js";
// The permission gate, the target resolution and the execution boundary are
// REUSED, never re-derived: importing them is what makes "the terminal cannot be
// a sandbox bypass" a property of the code rather than a promise in a comment.
import { sandboxFor, shellDeniedReason, targetSession } from "./exec.js";

/**
 * The pty table is created PER APP (inside [registerTerminal]), never a module
 * singleton.
 *
 * Why this matters: a module-level table would be shared by every studio app in
 * the process. In production there is one app, so it would look fine — but a test
 * process hosts many harnesses, and one harness's terminals would then count
 * against another's ceiling and be closeable through the other's routes. The
 * registry is state, and state belongs to the app that owns the processes.
 */

/** Frame publisher: the app passes its bus; tests pass a recorder. */
export type TerminalSink = (id: string, session: string | null, data: string) => void;

export interface TerminalDeps {
  /** Relay pty output to the client. Absent = the studio SSE bus. */
  sink?: TerminalSink;
}

/** Read the optional `session`/`cols`/`rows` fields of an open request. */
interface OpenFields {
  session: string | undefined;
  cols: number;
  rows: number;
}

function readOpenFields(c: Context, body: Record<string, unknown>): OpenFields | Response {
  const session = strField(c, body, "session");
  if (!session.ok) return session.response;
  const cols = numField(c, body, "cols");
  if (!cols.ok) return cols.response;
  const rows = numField(c, body, "rows");
  if (!rows.ok) return rows.response;
  return { session: session.value, cols: clampDim(cols.value, DEFAULT_COLS), rows: clampDim(rows.value, DEFAULT_ROWS) };
}

/** Only the contract's four fields + optional cpu_sec (never host diagnostics). */
function sandboxView(meta: { provider: string; net_isolated: boolean; tmp_private: boolean; seccomp: boolean; cpu_sec?: number }): Record<string, unknown> {
  return {
    provider: meta.provider,
    net_isolated: meta.net_isolated,
    tmp_private: meta.tmp_private,
    seccomp: meta.seccomp,
    ...(meta.cpu_sec === undefined ? {} : { cpu_sec: meta.cpu_sec }),
  };
}

/**
 * Streaming decoders, one per stream (stdout and stderr decode independently).
 *
 * A pty emits BYTES and a chunk boundary lands wherever the kernel happened to
 * flush it — frequently in the middle of a multi-byte character (any CJK output,
 * any emoji). `Buffer.toString("utf8")` per chunk would turn each of those into
 * U+FFFD and corrupt the user's output. `StringDecoder` keeps the incomplete
 * tail buffered until the next chunk completes it, so the SSE payload is always
 * well-formed text.
 */
class StreamPump {
  private readonly decoders = new Map<string, StringDecoder>();

  constructor(private readonly sink: TerminalSink) {}

  private decode(streamKey: string, chunk: unknown): string {
    if (typeof chunk === "string") return chunk;
    if (!Buffer.isBuffer(chunk)) return String(chunk);
    let decoder = this.decoders.get(streamKey);
    if (decoder === undefined) {
      decoder = new StringDecoder("utf8");
      this.decoders.set(streamKey, decoder);
    }
    return decoder.write(chunk);
  }

  /**
   * Relay one chunk. Chunks are forwarded as they arrive (never buffered until
   * exit): a prompt that only appears after the command finishes is not a
   * terminal. `entry.bytes`/`touchedAt` feed the idle reaper.
   */
  pump(entry: ReturnType<TerminalRegistry["get"]>, streamKey: string, chunk: unknown): void {
    if (entry === undefined || entry.closed) return;
    const text = this.decode(streamKey, chunk);
    if (text === "") return;
    entry.bytes += text.length;
    entry.touchedAt = Date.now();
    this.sink(entry.id, entry.session, text);
  }
}

/** The open route: gate -> support -> boundary -> spawn -> register -> relay. */
async function openTerminal(c: Context, deps: Deps, pump: StreamPump, terminals: TerminalRegistry): Promise<Response> {
  const body = await readJsonBody(c, false);
  if (!body.ok) return body.response;
  const fields = readOpenFields(c, body.body);
  if (fields instanceof Response) return fields;

  const target = targetSession(deps, fields.session);
  if (target.status !== 0) return failJson(c, target.status, target.error);

  // Rule 1: the SAME gate `/api/exec` passes. Denied is a refusal, not a run.
  const denied = shellDeniedReason(deps, target.resolved);
  if (denied !== null) return failJson(c, 403, denied, { code: "shell_denied" });

  const support = ptySupport(deps.grants.env);
  if ("reason" in support) return failJson(c, 501, support.reason, { code: TERMINAL_UNAVAILABLE_CODE });

  // Rule 2: the SAME boundary. A policy refusal throws a structured
  // SandboxError; it is answered as a 400 before any process exists.
  let spawned;
  try {
    spawned = await sandboxFor(deps, target.resolved).spawn({
      command: ptyCommand(support, fields.cols, fields.rows),
      ...(target.resolved === null ? {} : { workdir: target.resolved.wsPath }),
    });
  } catch (e) {
    return failJson(c, 400, errText(e));
  }

  const entry = terminals.add(spawned.child, target.resolved?.id ?? null, fields.cols, fields.rows);
  if (entry === null) {
    spawned.child.kill();
    return failJson(c, 429, `this process already hosts ${String(terminals.size())} terminals; close one first`, { code: TERMINAL_LIMIT_CODE });
  }

  spawned.child.stdout?.on("data", (chunk: unknown) => pump.pump(terminals.get(entry.id), entry.id + ":out", chunk));
  spawned.child.stderr?.on("data", (chunk: unknown) => pump.pump(terminals.get(entry.id), entry.id + ":err", chunk));
  // The child is reaped by the OS; the TABLE entry is dropped here so a dead
  // terminal stops counting against the ceiling (no leak of registry rows).
  void spawned.child.wait().then(() => terminals.drop(entry.id));

  return c.json({
    ok: true,
    id: entry.id,
    pid: spawned.child.pid ?? null,
    cols: fields.cols,
    rows: fields.rows,
    sandbox: sandboxView(spawned.sandbox),
  });
}

/** The input route: RAW bytes to stdin, verbatim (no invented newline). */
async function inputTerminal(c: Context, terminals: TerminalRegistry): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const entry = terminals.get(id);
  if (entry === undefined) return failJson(c, 404, `unknown terminal '${id}'`, { code: TERMINAL_GONE_CODE });
  const stdin = entry.child.stdin;
  if (stdin === null || stdin.destroyed) return failJson(c, 409, "this terminal's input stream is closed", { code: TERMINAL_GONE_CODE });
  // Enter is a byte the CLIENT sends (\r), so inventing one here would break
  // every REPL: the same endpoint must carry 'p' and then '\r' separately.
  const text = await c.req.text();
  if (text !== "") {
    stdin.write(Buffer.from(text, "utf8"));
    entry.touchedAt = Date.now();
  }
  return c.json({ ok: true, id, bytes: Buffer.byteLength(text, "utf8") });
}

/** The close route: SIGTERM the whole process group, then forget the entry. */
async function closeTerminal(c: Context, terminals: TerminalRegistry): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const entry = terminals.get(id);
  // Idempotent on purpose: the panel may close twice (unmount + pagehide), and
  // "already gone" is success, not a 404 the client has to special-case.
  if (entry === undefined) return c.json({ ok: true, id, closed: false });
  const pid = entry.child.pid ?? null;
  await terminateTree(entry);
  terminals.drop(id);
  return c.json({ ok: true, id, closed: true, pid });
}

export function registerTerminal(app: Hono, deps: Deps, table: RouteTable, options: TerminalDeps = {}): string[] {
  const open = table.get("post_terminal");
  const input = table.get("post_terminal_input");
  const close = table.get("post_terminal_close");
  const pump = new StreamPump(
    options.sink ??
      ((id, session, data) => {
        // turn = 0: a pty is not a turn (contract note on the event).
        deps.bus.emit("terminal", 0, { id, session, data }, session);
      }),
  );
  // One table per app: the routes below close over it, so no other app in this
  // process can see or close these terminals (see the note above).
  const terminals = new TerminalRegistry();
  app.on(open.method, open.honoPath, (c) => openTerminal(c, deps, pump, terminals));
  app.on(input.method, input.honoPath, (c) => inputTerminal(c, terminals));
  app.on(close.method, close.honoPath, (c) => closeTerminal(c, terminals));
  return [open.id, input.id, close.id];
}
