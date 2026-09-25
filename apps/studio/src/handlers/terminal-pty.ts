/**
 * W1528 — real-PTY plumbing for the workbench terminal.
 *
 * ## Why a `script(1)` shim and not a native PTY
 *
 * Node has no PTY API. The alternatives were a native addon (node-pty: a
 * compiled dependency, a rebuild per Node ABI, and a supply-chain surface this
 * repo does not take lightly) or an EXISTING setuid-free binary that already
 * allocates a pty. `util-linux`'s `script(1)` is the second: it opens
 * `/dev/ptmx`, forks the command onto the slave side, and relays the master to
 * its own stdio. Measured on this host: a prompt appears, `python3` starts a
 * REPL, `top` renders, and `cat` echoes a typed line.
 *
 * ## The sandbox is NOT bypassed
 *
 * The command string built here is handed to the SAME `Sandbox.spawn()` the
 * engine's `run_shell background:true` uses, under the SAME permission gate
 * (`shellDeniedReason`) and the SAME provider selection (`sandboxFor`), so the
 * pty lives INSIDE bwrap. Verified live: `bwrap … -- /usr/bin/script -qfc …`
 * prints a prompt and `tty` answers `/dev/pts/0` (a pty inside the namespace,
 * not the host's).
 *
 * ## What this module deliberately does NOT do
 *
 * - **No shell of its own.** There is no `spawn` call here; the only process
 *   this file can start is the one `sandbox.spawn` starts.
 * - **No resize.** `script(1)` owns the pty MASTER; the host holds pipes to
 *   script's stdio and cannot issue `TIOCSWINSZ`. The size is therefore fixed
 *   when the terminal opens, and the command sets it once via `stty`. A resize
 *   is a re-open — the UI does exactly that, and says so.
 * - **No silent platform fallback.** A host without `script(1)` (Windows) gets a
 *   structured refusal, never a bare shell pretending to be a terminal.
 */

import { randomUUID } from "node:crypto";
import type { SandboxChild } from "@celestea/core";
import { resolveShellKind, shellQuote, whichSync } from "@celestea/tools";

/** Structured refusal codes (mirrors the `shell_denied` convention in exec.ts). */
export const TERMINAL_UNAVAILABLE_CODE = "terminal_unavailable";
export const TERMINAL_LIMIT_CODE = "terminal_limit";
export const TERMINAL_GONE_CODE = "terminal_gone";

/** Concurrent pty ceiling per studio process (each one is a real process tree). */
export const MAX_TERMINALS = 8;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** Bounds for the client-supplied geometry (`stty` rejects nonsense sizes). */
export const MIN_DIM = 20;
export const MAX_DIM = 500;

/** Clamp a client-supplied geometry into the range `stty` can carry. */
export function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(value)));
}

export interface PtySupport {
  /** Absolute path of `script(1)`. */
  script: string;
  /** Absolute path of the interactive shell `script` will exec. */
  shell: string;
}

/**
 * Can this host carry a pty at all?
 *
 * Fail-closed on purpose: an absent `script(1)` is answered with a reason, and
 * the caller turns that into a structured 501 — it must never degrade into
 * running the user's keystrokes through a non-tty pipe (which would look like a
 * terminal and behave like one-shot execution, the exact lie W1528 removes).
 */
export function ptySupport(env: NodeJS.ProcessEnv = process.env): PtySupport | { reason: string } {
  if (process.platform === "win32") {
    return { reason: "a real pty needs util-linux script(1), which this platform does not provide" };
  }
  const script = whichSync("script", env);
  if (script === null) {
    return { reason: "util-linux script(1) was not found on PATH (install util-linux to enable the terminal)" };
  }
  // bash gives a proper prompt with cwd; /bin/sh is the guaranteed fallback.
  const shell = whichSync("bash", env) ?? resolveShellKind({ env }).path;
  return { script, shell };
}

/**
 * The command line the sandbox runs: `script` allocates the pty and execs an
 * interactive shell on the slave side, with the geometry the client asked for.
 *
 * `-e` makes script exit with the CHILD's status, so the UI can report the real
 * exit code instead of script's own. `stty` is best-effort (`2>/dev/null`);
 * a host without it still gets a working pty at the default size.
 */
export function ptyCommand(support: PtySupport, cols: number, rows: number): string {
  const inner = `stty cols ${String(cols)} rows ${String(rows)} 2>/dev/null; exec ${shellQuote(support.shell)} -i`;
  return `TERM=xterm-256color exec ${shellQuote(support.script)} -q -e -f -c ${shellQuote(inner)} /dev/null`;
}

/** One live pty plus the bookkeeping the reaper and the routes need. */
export interface TerminalEntry {
  readonly id: string;
  /** Routing key of the SSE frames (`null` = the detached scope). */
  readonly session: string | null;
  readonly child: SandboxChild;
  readonly cols: number;
  readonly rows: number;
  /** Bytes relayed so far (observability; never a cap — the bus is the cap). */
  bytes: number;
  /** Epoch ms of the last byte in EITHER direction (idle reaping). */
  touchedAt: number;
  closed: boolean;
}

/**
 * The per-app pty table.
 *
 * Deliberately an INSTANCE (not a module singleton): one studio process hosts
 * one table, but a test process hosts several apps, and a shared singleton would
 * let one harness close another harness's terminal.
 */
export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>();

  constructor(private readonly limit: number = MAX_TERMINALS) {}

  /** Register a freshly spawned child; `null` when the ceiling is reached. */
  add(child: SandboxChild, session: string | null, cols: number, rows: number): TerminalEntry | null {
    if (this.entries.size >= this.limit) return null;
    const entry: TerminalEntry = {
      id: "term-" + randomUUID(),
      session,
      child,
      cols,
      rows,
      bytes: 0,
      touchedAt: Date.now(),
      closed: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): TerminalEntry | undefined {
    return this.entries.get(id);
  }

  /** Forget an entry (the child is already gone or has been signalled). */
  drop(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.closed = true;
    this.entries.delete(id);
  }

  /** Every live entry (the reaper and the shutdown path iterate this). */
  all(): TerminalEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  /** Ids idle for longer than `idleMs` (the anti-leak backstop). */
  idleSince(idleMs: number, now: number = Date.now()): TerminalEntry[] {
    return this.all().filter((e) => now - e.touchedAt > idleMs);
  }
}

/** Default idle ceiling: a pty with no traffic for this long is reaped. */
export const TERMINAL_IDLE_MS = 30 * 60 * 1000;

/**
 * Terminate a pty tree, gracefully first.
 *
 * `script` and the shell it execs share ONE process group (the sandbox spawns
 * detached), so the group signal reaches every descendant — a `python3` REPL or
 * a `top` started inside the terminal dies with it. SIGTERM is tried first so
 * the shell can run its exit trap; the caller escalates to SIGKILL on the
 * deadline. Returns the promise that settles when the child is reaped.
 */
export function terminateTree(entry: TerminalEntry): Promise<void> {
  entry.closed = true;
  entry.child.terminate();
  return entry.child.wait().then(() => undefined);
}
