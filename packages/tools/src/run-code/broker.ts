/**
 * The `run_code` parent broker (`crates/tools/src/run_code.rs:562-978`).
 *
 * One `run_code` call = one round trip. The assembled program — TypeScript by
 * default since W774, Python on request — runs in the sandbox; its sub-calls
 * arrive as one-line JSON on stdout and the parent answers on stdin after
 * dispatching each one through the **same** registry pipeline (schema → guards →
 * execute) the model itself would use. Only `main()`'s return value travels back
 * as the tool result.
 *
 * The protocol is language-neutral (it is byte-identical for both SDKs), so the
 * language only decides two things: the script file's extension and the
 * interpreter that runs it.
 *
 * Invariants:
 * - every limit is enforced here, never in the child: the 21st sub-call is
 *   refused before dispatch, the wall clock is enforced while waiting for a
 *   line, the sub-call output ledger is charged per reply;
 * - every infrastructure failure is a structured `run_code: code=… msg="…"`
 *   (invalid_arg | registry | config | spawn | protocol | timeout | aborted);
 *   a program exception is that exception's text plus a bounded log tail;
 * - the child is killed on timeout, on cancel and on protocol failure — never
 *   left behind — and its script file is removed on every exit path.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { Sandbox, SandboxChild, SandboxSpawned, SessionEvent, ToolExecOutcome, ToolInput, ToolRegistry } from "@celestea/core";

import { errorCode, errorText } from "../errors.js";
import { stringArg } from "../args.js";
import { resolveShellKind, type ShellResolveInput } from "../platform/exec.js";
import { pythonCandidates, runCodeCommand } from "../platform/quote.js";
import { whichSync } from "../sandbox/probe.js";
import { TIMED_OUT, withTimeout } from "../sandbox/async.js";
import { readCapped, REAP_GRACE_MS } from "../sandbox/launch.js";
import { ToolFailure } from "../tool-failure.js";
import {
  EXIT_GRACE_MS,
  MAX_LINE_BYTES,
  RUN_CODE_ERROR_PREFIX,
  SDK_TOOLS,
  STDIN_WRITE_TIMEOUT_MS,
  resolveTimeoutMs,
  runCodeFailure,
  type RunCodeConfig,
} from "./limits.js";
import { LineReader, appendBounded, jsonByteLength, tail, truncateValue, type BoundedLine } from "./lines.js";
import { assembleProgram, DEFAULT_RUN_CODE_LANGUAGE, type RunCodeLanguage } from "./sdk.js";

/** Session-log sink for sub-call rows (legacy `Fn(SessionEvent)` sink). */
export type RunCodeEventSink = (event: SessionEvent) => void;

/** Everything one broker run needs (the tool binds the registry + call id). */
export interface BrokerContext {
  sandbox: Sandbox;
  registry: ToolRegistry;
  events?: RunCodeEventSink;
  config: RunCodeConfig;
  /** The `run_code` call id: sub-call ids are `<parentId>:c<n>`. */
  parentId: string;
}

/** One parsed sub-call request from the child. */
interface SubRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

/** Terminal state of the child, plus its captured stderr. */
interface Settled {
  exitCode: number | null;
  killed: boolean;
  stderrText: string;
  stderrTruncated: boolean;
}

/** Mutable state of one run (logs, budget, outcome). */
interface RunState {
  logs: string;
  logsTruncated: boolean;
  subOutputBytes: number;
  subOutputDropped: number;
  dispatched: number;
  hasFinal: boolean;
  finalValue: unknown;
  programError: string | null;
  infraError: string | null;
  settle: Settled | null;
}

let scriptSeq = 0;

/**
 * Absolute interpreter path of a TypeScript program (W774): the Node that runs
 * THIS process, which is the same binary the sandbox can see (`--ro-bind / /`
 * mounts the host root read-only) and never depends on the child's PATH.
 * `/usr/bin/node` is preferred because it is the host's system-wide install;
 * `process.execPath` is the honest fallback (nvm/volta hosts).
 *
 * W885: the constant is kept for compatibility, but the interpreter actually
 * used is resolved per run (`resolveInterpreter`), which checks the platform
 * PATH first — `/usr/bin/node` is a POSIX convention that simply does not
 * exist on Windows (W883 B9/B15).
 */
export const TS_PROGRAM_RUNTIME = existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath;

/** One full run_code round trip: the program's final value + its render. */
export async function brokerRun(ctx: BrokerContext, args: unknown): Promise<ToolExecOutcome> {
  const source = programSource(args);
  const timeoutMs = resolveTimeoutMs(readArg(args, "timeout_ms"), ctx.config);
  // W880: the program is written to <CELESTEA_HOME>/.../run-code, NOT into the
  // workspace. The sandbox config owns that absolute path; the interpreter is
  // invoked with the absolute path so no cwd-relative lookup is involved.
  const script = await placeProgram(ctx.sandbox.config.programDir, source);
  const state = newRunState();
  try {
    await executeProgram(ctx, script.path, source.language, timeoutMs, state);
  } catch (e) {
    throw withLogs(e, ctx, state);
  } finally {
    await script.cleanup();
  }
  return outcomeOf(ctx, state);
}

// ---- argument + program placement --------------------------------------------

/** What one `run_code` call asks to run: the source plus its language. */
interface ProgramSource {
  code: string;
  language: RunCodeLanguage;
}

/** `code` must be a non-empty program; `language` defaults to TypeScript (W774). */
function programSource(args: unknown): ProgramSource {
  const code = stringArg(args, "code");
  if (code.trim() === "") throw runCodeFailure("invalid_arg", "'code' must be a non-empty program");
  const raw = readArg(args, "language");
  if (raw === undefined || raw === null) return { code, language: DEFAULT_RUN_CODE_LANGUAGE };
  if (raw === "typescript" || raw === "python") return { code, language: raw };
  // The spec's enum refuses anything else before dispatch; this is the floor.
  throw runCodeFailure("invalid_arg", `'language' must be 'typescript' or 'python' (got ${JSON.stringify(raw)})`);
}

function readArg(args: unknown, key: string): unknown {
  if (typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

/**
 * Write `SDK + user code + runner` into
 * `<programDir>/run_code_<pid>_<n>.{mts,py}` — the extension is the ONLY thing the
 * language changes about placement. `programDir` is the sandbox config's
 * absolute `<CELESTEA_HOME>/workspaces/<ws>/run-code`; the host has full-disk
 * access so it writes directly, and the bwrap provider binds that dir into the
 * namespace so the child can read it.
 */
async function placeProgram(programDir: string, source: ProgramSource): Promise<{ path: string; cleanup: () => Promise<void> }> {
  try {
    await mkdir(programDir, { recursive: true });
  } catch (e) {
    throw runCodeFailure("config", `cannot create '${programDir}': ${errorText(e)}`);
  }
  // W892: `.mts`, NOT `.ts`. The program dir is under <CELESTEA_HOME>/.../run-code,
  // which on Windows sits BELOW %USERPROFILE% (or any ancestor) that may hold a
  // package.json without "type". Node then emits MODULE_TYPELESS_PACKAGE_JSON on
  // stderr ("Reparsing as ES module..."), which lands in the captured stderr and
  // breaks byte-exact assertions (and is real noise for users). `.mts` is
  // unconditionally an ES module, so the warning cannot occur anywhere.
  const suffix = source.language === "python" ? "py" : "mts";
  const name = `run_code_${process.pid}_${scriptSeq++}.${suffix}`;
  const path = join(programDir, name);
  try {
    await writeFile(path, assembleProgram(source.code, source.language), "utf8");
  } catch (e) {
    throw runCodeFailure("spawn", `cannot write program file '${path}': ${errorText(e)}`);
  }
  return { path, cleanup: () => rm(path, { force: true }).catch(() => undefined) };
}

// ---- child lifecycle ---------------------------------------------------------

/**
 * The interpreter of one `run_code` program (W885).
 *
 * TypeScript runs under the Node that runs THIS process — the one binary the
 * sandbox is guaranteed to see through `--ro-bind / /` — with the host's PATH
 * consulted first ONLY when that yields a Node (`node` is `node.exe` on
 * Windows, and `process.execPath` there is routinely `C:\\Program Files\\…`
 * with a space in it). Python keeps the historical `python3` on POSIX and
 * falls back to the names Windows actually ships (`python`, `py`).
 *
 * Anything `whichSync` cannot find becomes the bare name, so a missing
 * interpreter still surfaces as the interpreter's own "not found" instead of a
 * silent wrong one.
 */
export function resolveInterpreter(language: RunCodeLanguage, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (language === "typescript") {
    const onPath = whichSync("node", env, platform);
    if (onPath !== null) return onPath;
    return process.execPath;
  }
  for (const candidate of pythonCandidates(platform)) {
    const found = whichSync(candidate, env, platform);
    if (found !== null) return found;
  }
  return pythonCandidates(platform)[0] ?? "python3";
}

/**
 * The interpreter command line, quoted for the shell that will run it.
 *
 * On POSIX the bytes are exactly what they always were — `python3 -uB '<path>'`
 * / `<node> '<path>'` — because `kind` is `posix` there and both quoting
 * helpers reproduce the historical single-quote rule verbatim.
 */
function interpreterCommand(language: RunCodeLanguage, scriptPath: string, input: ShellResolveInput = {}): string {
  const kind = resolveShellKind(input).kind;
  return runCodeCommand(kind, language, resolveInterpreter(language), scriptPath);
}

async function spawnProgram(sandbox: Sandbox, scriptPath: string, language: RunCodeLanguage): Promise<SandboxChild> {
  let spawned: SandboxSpawned;
  try {
    spawned = await sandbox.spawn({ command: interpreterCommand(language, scriptPath, sandbox.shell) });
  } catch (e) {
    throw runCodeFailure("spawn", errorText(e));
  }
  if (spawned.child.stdin === null) throw runCodeFailure("spawn", "no stdin pipe (reply channel)");
  return spawned.child;
}

/** Spawn, pump the protocol to completion, then settle (and always clean up). */
async function executeProgram(
  ctx: BrokerContext,
  scriptPath: string,
  language: RunCodeLanguage,
  timeoutMs: number,
  state: RunState,
): Promise<void> {
  const child = await spawnProgram(ctx.sandbox, scriptPath, language);
  const stderr = readCapped(child.stderr, ctx.config.maxLogBytes);
  // W833 (R3 B1 / W812 P1-1): the wall clock is enforced HERE, not only while
  // waiting for the next stdout line. A slow sub-call (run_shell itself allows
  // 300s) or a reply write parked on a full pipe lives INSIDE pumpLines, where
  // the reader's own deadline cannot be consulted; this timer kills the child
  // and records code=timeout no matter which await the pump is parked on.
  let wallTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let pumpError: unknown = null;
  const wallFired = new Promise<void>((resolve) => {
    wallTimer = setTimeout(() => {
      timedOut = true;
      if (state.infraError === null) state.infraError = timeoutMessage(child, timeoutMs, state);
      child.kill();
      resolve();
    }, timeoutMs);
  });
  const pump = pumpLines(ctx, child, timeoutMs, state).catch((error: unknown) => {
    // Park the rejection: after the wall clock has already won, the pump may
    // still fail (its write lands on a destroyed stdin) and must not surface as
    // an unhandled rejection. The outcome is decided below.
    pumpError = error;
  });
  try {
    await Promise.race([pump, wallFired]);
  } finally {
    clearTimeout(wallTimer);
    endStdin(child.stdin);
  }
  if (pumpError !== null && !timedOut) {
    child.kill();
    throw pumpError;
  }
  const settled = await settleChild(child, EXIT_GRACE_MS);
  const captured = await stderr;
  state.settle = { ...settled, stderrText: captured.text, stderrTruncated: captured.truncated };
}

/** Wait for a natural exit within `graceMs`; on expiry kill the tree. */
async function settleChild(child: SandboxChild, graceMs: number): Promise<{ exitCode: number | null; killed: boolean }> {
  const exit = await withTimeout(child.wait(), graceMs);
  if (exit !== TIMED_OUT) return { exitCode: exit.code, killed: false };
  child.kill();
  await withTimeout(child.wait(), REAP_GRACE_MS);
  return { exitCode: null, killed: true };
}

/** Close our end of the reply channel so a blocked bridge call sees EOF. */
function endStdin(stdin: Writable | null): void {
  if (stdin === null) return;
  stdin.on("error", () => undefined);
  try {
    stdin.end();
  } catch {
    // already closed: nothing to release
  }
}

// ---- the broker loop ---------------------------------------------------------

/** Read protocol lines until `__final__` / `__error__` / EOF / the deadline. */
async function pumpLines(
  ctx: BrokerContext,
  child: SandboxChild,
  timeoutMs: number,
  state: RunState,
): Promise<void> {
  const reader = new LineReader(child.stdout, MAX_LINE_BYTES);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const line = await reader.next(deadline - Date.now());
      if (line === TIMED_OUT) {
        state.infraError = timeoutMessage(child, timeoutMs, state);
        child.kill();
        return;
      }
      if (line === null) return;
      if ((await handleLine(ctx, child, line, state)) === "stop") return;
    }
  } finally {
    reader.stop();
  }
}

/** Classify one stdout line: final / error / request / log. */
async function handleLine(
  ctx: BrokerContext,
  child: SandboxChild,
  line: BoundedLine,
  state: RunState,
): Promise<"stop" | "continue"> {
  const trimmed = line.text.trimEnd();
  if (line.truncated) {
    logLine(state, ctx.config, trimmed, true);
    return "continue";
  }
  const decoded = decodeObject(trimmed);
  if (decoded === null) {
    logLine(state, ctx.config, trimmed);
    return "continue";
  }
  if ("__final__" in decoded) {
    state.hasFinal = true;
    state.finalValue = decoded["__final__"];
    return "stop";
  }
  if ("__error__" in decoded) {
    state.programError = typeof decoded["__error__"] === "string" ? decoded["__error__"] : "unknown program error";
    return "stop";
  }
  const request = requestOf(decoded);
  if (request === null) {
    logLine(state, ctx.config, trimmed);
    return "continue";
  }
  await answerSubCall(ctx, child, request, state);
  return "continue";
}

/** Objects only: a JSON scalar / array on stdout is a log line (parity). */
function decodeObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A request needs an integer `id`, a string `tool` and an object `args`. */
function requestOf(decoded: Record<string, unknown>): SubRequest | null {
  const { id, tool, args } = decoded;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  if (typeof tool !== "string") return null;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { id, tool, args: args as Record<string, unknown> };
}

// ---- sub-call dispatch -------------------------------------------------------

async function answerSubCall(
  ctx: BrokerContext,
  child: SandboxChild,
  request: SubRequest,
  state: RunState,
): Promise<void> {
  const reply = await buildReply(ctx, request, state);
  try {
    await writeReply(child.stdin as Writable, encodeReply(reply, request.id));
  } catch (e) {
    if (e instanceof ToolFailure && e.kind === "timeout") {
      // W833 (R3 B1): a reply the child never drains is a wall-clock failure,
      // not a protocol error. Record it, kill the child and let the pump stop.
      if (state.infraError === null) state.infraError = e.message;
      child.kill();
      return;
    }
    throw runCodeFailure("protocol", `cannot write reply to the program (stdin closed): ${errorText(e)}`);
  }
}

/** Whitelist → sub-call budget → dispatch through the shared registry. */
async function buildReply(ctx: BrokerContext, request: SubRequest, state: RunState): Promise<Record<string, unknown>> {
  if (!SDK_TOOLS.includes(request.tool)) {
    return { id: request.id, ok: false, error: `tool '${request.tool}' not exposed in run_code SDK` };
  }
  if (state.dispatched >= ctx.config.maxSubCalls) {
    return {
      id: request.id,
      ok: false,
      error: `${RUN_CODE_ERROR_PREFIX}: sub-call limit exceeded (max ${ctx.config.maxSubCalls})`,
    };
  }
  state.dispatched += 1;
  const subCallId = `${ctx.parentId}:c${request.id}`;
  const input: ToolInput = { call_id: subCallId, name: request.tool, args: request.args };
  ctx.events?.({ type: "tool_call", id: subCallId, name: request.tool, args: request.args, parent_id: ctx.parentId });
  const out = await ctx.registry.dispatch(input);
  ctx.events?.({ type: "tool_result", id: subCallId, value: out.value, error: out.error, parent_id: ctx.parentId });
  if (out.error !== null) return { id: request.id, ok: false, error: out.error };
  return valueReply(ctx.config, request.id, out.value, state);
}

/** Charge the sub-call output ledger; oversized values are cut with a warning. */
function valueReply(config: RunCodeConfig, id: number, value: unknown, state: RunState): Record<string, unknown> {
  const size = jsonByteLength(value);
  const room = Math.max(config.maxSubOutputBytes - state.subOutputBytes, 0);
  if (size !== null && size <= room) {
    state.subOutputBytes += size;
    return { id, ok: true, value };
  }
  const cut = truncateValue(value, room);
  const cutSize = jsonByteLength(cut) ?? 0;
  state.subOutputBytes += cutSize;
  state.subOutputDropped += Math.max((size ?? 0) - cutSize, 0);
  return {
    id,
    ok: true,
    value: cut,
    truncated: true,
    warning: `sub-call output budget (${config.maxSubOutputBytes} bytes) exceeded; value truncated`,
  };
}

function encodeReply(reply: Record<string, unknown>, id: number): string {
  try {
    const encoded = JSON.stringify(reply);
    if (encoded !== undefined) return encoded;
  } catch {
    // fall through: the value cannot cross the wire, tell the program why
  }
  return JSON.stringify({ id, ok: false, error: "reply not serializable" });
}

async function writeReply(stdin: Writable, line: string): Promise<void> {
  const written = new Promise<void>((resolve, reject) => {
    stdin.write(`${line}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
  if ((await withTimeout(written, STDIN_WRITE_TIMEOUT_MS)) === TIMED_OUT) {
    throw runCodeFailure(
      "timeout",
      `reply was not written after ${STDIN_WRITE_TIMEOUT_MS}ms (the program stopped reading stdin)`,
    );
  }
}

// ---- logs, render, outcome ---------------------------------------------------

/**
 * Append one log line to the bounded stdout log. Lines append back to
 * back (no separator): the budget is a byte ledger, not a pretty printer.
 */
function logLine(state: RunState, config: RunCodeConfig, text: string, truncated = false): void {
  const merged = appendBounded(state.logs, text, config.maxLogBytes);
  state.logs = merged.text;
  state.logsTruncated =
    state.logsTruncated || merged.truncated || truncated || Buffer.byteLength(text, "utf8") > config.maxLogBytes;
}

function timeoutMessage(child: SandboxChild, timeoutMs: number, state: RunState): string {
  const pid = child.pid === null ? "?" : String(child.pid);
  const captured = Buffer.byteLength(state.logs, "utf8");
  return runCodeFailure("timeout", `killed pid ${pid} after ${timeoutMs}ms (wall clock; stdout_log_captured_bytes=${captured})`)
    .message;
}

function abortedMessage(state: RunState): string {
  const settled = state.settle;
  const code = settled === null || settled.exitCode === null ? "?" : String(settled.exitCode);
  const killed = settled?.killed === true;
  return runCodeFailure("aborted", `program exited code=${code} (killed=${killed}) without a final line`).message;
}

/**
 * Human rendering: stdout logs + stderr tail + budget warnings (bounded).
 *
 * W833 (R3 B1 / W812 P2-2): the numbers come from the EFFECTIVE config, not the
 * module constants — a caller that injects a smaller budget must see its own
 * value in the render or the model is told a threshold that does not apply.
 */
function composeRender(config: RunCodeConfig, state: RunState): string | null {
  const parts: string[] = [];
  const settled = state.settle;
  if (state.logs !== "") parts.push(state.logs);
  if (state.logsTruncated) parts.push(`[run_code] stdout logs truncated at ${config.maxLogBytes} bytes`);
  if (settled !== null && settled.stderrText !== "") parts.push(`[stderr]\n${settled.stderrText}`);
  if (settled !== null && settled.stderrTruncated) parts.push(`[run_code] stderr truncated at ${config.maxLogBytes} bytes`);
  if (state.subOutputDropped > 0) {
    parts.push(
      `[run_code] warning: sub-call output budget (${config.maxSubOutputBytes} bytes) exceeded — ${state.subOutputDropped} bytes dropped`,
    );
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/** The canonical value, or the structured error (infra > program > aborted). */
function outcomeOf(ctx: BrokerContext, state: RunState): ToolExecOutcome {
  const render = composeRender(ctx.config, state);
  const error = state.infraError ?? state.programError ?? (state.hasFinal ? null : abortedMessage(state));
  if (error !== null) throw new ToolFailure(errorCode(error) ?? RUN_CODE_ERROR_PREFIX, withLogsText(error, render));
  return { value: state.hasFinal ? state.finalValue : null, render };
}

/** Attach the bounded render tail to a failure (legacy `FailureCtx`). */
function withLogsText(error: string, render: string | null): string {
  if (render === null || render === "") return error;
  return `${error}\n[run_code] logs:\n${tail(render, 2048)}`;
}

function withLogs(error: unknown, ctx: BrokerContext, state: RunState): Error {
  const text = withLogsText(errorText(error), composeRender(ctx.config, state));
  return error instanceof ToolFailure ? new ToolFailure(error.kind, text) : new ToolFailure(RUN_CODE_ERROR_PREFIX, text);
}

function newRunState(): RunState {
  return {
    logs: "",
    logsTruncated: false,
    subOutputBytes: 0,
    subOutputDropped: 0,
    dispatched: 0,
    hasFinal: false,
    finalValue: null,
    programError: null,
    infraError: null,
    settle: null,
  };
}
