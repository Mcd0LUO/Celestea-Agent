/**
 * The `run_code` parent broker (`crates/tools/src/run_code.rs:562-978`).
 *
 * One `run_code` call = one round trip. The assembled Python program runs in
 * the sandbox; its sub-calls arrive as one-line JSON on stdout and the parent
 * answers on stdin after dispatching each one through the **same** registry
 * pipeline (schema → guards → execute) the model itself would use. Only
 * `main()`'s return value travels back as the tool result.
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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { Sandbox, SandboxChild, SandboxSpawned, SessionEvent, ToolExecOutcome, ToolInput, ToolRegistry } from "@celestea/core";

import { errorCode, errorText } from "../errors.js";
import { stringArg } from "../args.js";
import { TIMED_OUT, withTimeout } from "../sandbox/async.js";
import { readCapped, REAP_GRACE_MS } from "../sandbox/launch.js";
import { resolveWorkdir } from "../sandbox/workdir.js";
import { ToolFailure } from "../tool-failure.js";
import {
  EXIT_GRACE_MS,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  MAX_SUB_OUTPUT_BYTES,
  RUN_CODE_ERROR_PREFIX,
  SDK_TOOLS,
  resolveTimeoutMs,
  runCodeFailure,
  type RunCodeConfig,
} from "./limits.js";
import { LineReader, appendBounded, jsonByteLength, tail, truncateValue, type BoundedLine } from "./lines.js";
import { assembleProgram } from "./sdk.js";

/** Session-log sink for sub-call rows (Rust `Fn(SessionEvent)` sink). */
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

/** One full run_code round trip: the program's final value + its render. */
export async function brokerRun(ctx: BrokerContext, args: unknown): Promise<ToolExecOutcome> {
  const code = programSource(args);
  const timeoutMs = resolveTimeoutMs(readArg(args, "timeout_ms"), ctx.config);
  const workdir = await sandboxWorkdir(ctx.sandbox);
  const script = await placeProgram(workdir, code);
  const state = newRunState();
  try {
    await executeProgram(ctx, script.name, timeoutMs, state);
  } catch (e) {
    throw withLogs(e, ctx, state);
  } finally {
    await script.cleanup();
  }
  return outcomeOf(ctx, state);
}

// ---- argument + program placement --------------------------------------------

/** `code` must be a non-empty Python program (Rust `arg_str` + empty check). */
function programSource(args: unknown): string {
  const code = stringArg(args, "code");
  if (code.trim() === "") throw runCodeFailure("invalid_arg", "'code' must be a non-empty Python program");
  return code;
}

function readArg(args: unknown, key: string): unknown {
  if (typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

async function sandboxWorkdir(sandbox: Sandbox): Promise<string> {
  try {
    return await resolveWorkdir(sandbox.config);
  } catch (e) {
    throw runCodeFailure("config", errorText(e));
  }
}

/** Write `SDK + user code + runner` into `<workdir>/.celestea/run_code_<pid>_<n>.py`. */
async function placeProgram(workdir: string, code: string): Promise<{ name: string; cleanup: () => Promise<void> }> {
  const dir = join(workdir, ".celestea");
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw runCodeFailure("config", `cannot create '${dir}': ${errorText(e)}`);
  }
  const name = `run_code_${process.pid}_${scriptSeq++}.py`;
  const path = join(dir, name);
  try {
    await writeFile(path, assembleProgram(code), "utf8");
  } catch (e) {
    throw runCodeFailure("spawn", `cannot write program file '${path}': ${errorText(e)}`);
  }
  return { name, cleanup: () => rm(path, { force: true }).catch(() => undefined) };
}

// ---- child lifecycle ---------------------------------------------------------

async function spawnProgram(sandbox: Sandbox, scriptName: string): Promise<SandboxChild> {
  let spawned: SandboxSpawned;
  try {
    spawned = await sandbox.spawn({ command: `python3 -uB .celestea/${scriptName}` });
  } catch (e) {
    throw runCodeFailure("spawn", errorText(e));
  }
  if (spawned.child.stdin === null) throw runCodeFailure("spawn", "no stdin pipe (reply channel)");
  return spawned.child;
}

/** Spawn, pump the protocol to completion, then settle (and always clean up). */
async function executeProgram(
  ctx: BrokerContext,
  scriptName: string,
  timeoutMs: number,
  state: RunState,
): Promise<void> {
  const child = await spawnProgram(ctx.sandbox, scriptName);
  const stderr = readCapped(child.stderr, ctx.config.maxLogBytes);
  try {
    await pumpLines(ctx, child, timeoutMs, state);
  } catch (e) {
    child.kill();
    throw e;
  } finally {
    endStdin(child.stdin);
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

/** Objects only: a JSON scalar / array on stdout is a log line (Rust parity). */
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

function writeReply(stdin: Writable, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stdin.write(`${line}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}

// ---- logs, render, outcome ---------------------------------------------------

/**
 * Append one log line to the bounded stdout log. Rust appends lines back to
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

/** Human rendering: stdout logs + stderr tail + budget warnings (bounded). */
function composeRender(state: RunState): string | null {
  const parts: string[] = [];
  const settled = state.settle;
  if (state.logs !== "") parts.push(state.logs);
  if (state.logsTruncated) parts.push(`[run_code] stdout logs truncated at ${MAX_LOG_BYTES} bytes`);
  if (settled !== null && settled.stderrText !== "") parts.push(`[stderr]\n${settled.stderrText}`);
  if (settled !== null && settled.stderrTruncated) parts.push(`[run_code] stderr truncated at ${MAX_LOG_BYTES} bytes`);
  if (state.subOutputDropped > 0) {
    parts.push(
      `[run_code] warning: sub-call output budget (${MAX_SUB_OUTPUT_BYTES} bytes) exceeded — ${state.subOutputDropped} bytes dropped`,
    );
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/** The canonical value, or the structured error (infra > program > aborted). */
function outcomeOf(ctx: BrokerContext, state: RunState): ToolExecOutcome {
  const render = composeRender(state);
  const error = state.infraError ?? state.programError ?? (state.hasFinal ? null : abortedMessage(state));
  if (error !== null) throw new ToolFailure(errorCode(error) ?? RUN_CODE_ERROR_PREFIX, withLogsText(error, render));
  return { value: state.hasFinal ? state.finalValue : null, render };
}

/** Attach the bounded render tail to a failure (Rust `FailureCtx`). */
function withLogsText(error: string, render: string | null): string {
  if (render === null || render === "") return error;
  return `${error}\n[run_code] logs:\n${tail(render, 2048)}`;
}

function withLogs(error: unknown, ctx: BrokerContext, state: RunState): Error {
  const text = withLogsText(errorText(error), composeRender(state));
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
