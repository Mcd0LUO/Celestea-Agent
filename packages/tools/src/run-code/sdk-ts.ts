/**
 * The TypeScript SDK preamble + runner (W774) — split out of `sdk.ts` (which is
 * the Python/Rust-parity file and stays at its own size budget).
 *
 * Same protocol, same four bridges, but executed by Node's NATIVE type stripping
 * (`node .celestea/<file>.ts`): no build step, no `node_modules`, no dependency.
 *
 * Deliberate differences from the Python preamble (both are pinned by tests):
 *   - attribute access is native (`r.stdout` and `r["stdout"]` both just work),
 *     so the Python `_AttrDict` / `_Value` dual-interface wrappers have no
 *     counterpart;
 *   - `await tools.read_file(...)` works because awaiting a non-promise value
 *     returns it unchanged — no awaitable wrapper needed;
 *   - the reply channel is read SYNCHRONOUSLY with `fs.readSync(0, …)` plus a
 *     half-line buffer (the equivalent of Python's `sys.stdin.readline()`);
 *     after EOF a further bridge call THROWS instead of hanging.
 *
 * Only ERASABLE TypeScript is allowed in the assembled file (Node strips types,
 * it never compiles them): no `enum`, no `namespace`, no parameter properties.
 */

export const RUN_CODE_SDK_TS = `// =============================================================================
// celestea run_code SDK (W774) - engine-injected preamble (TypeScript).
// Node standard library only. Runs under \`node .celestea/<file>.ts\` inside the
// Celestea execution sandbox; the parent engine (the "broker") reads our
// protocol lines from stdout and writes replies to stdin.
//
// Protocol (one JSON object per line, no other framing) - identical to the
// Python SDK on purpose: the broker is language-neutral.
//   child -> parent   {"id": <int>, "tool": "<name>", "args": {...}}
//   parent -> child   {"id": <int>, "ok": true, "value": <json>, "truncated": <bool>}
//                     {"id": <int>, "ok": false, "error": "<message>"}
//   child -> parent   {"__final__": <json>}      (normal end: main()'s return)
//                     {"__error__": "<message>"} (uncaught exception)
//
// Contract:
//   - Write the program as a \`function main()\` BODY (an indented body is wrapped
//     for you), or as a complete script that defines main. main() MAY be async:
//     the harness awaits it. Its resolved value (lossless JSON) is the result.
//   - \`tools.<name>({...})\` is a SYNCHRONOUS bridge: every sub-call is dispatched
//     by the parent through its normal tool pipeline (guards, schema checks,
//     limits). A failure throws ToolCallError - catch it and continue.
//     \`await tools.<name>({...})\` is the same thing (awaiting a value is free).
//   - Only console.log what the model needs: a line that is not protocol JSON is
//     a LOG line (budgeted at 64KiB); intermediate results never enter the chat.
//   - Sub-calls run SERIALLY, one at a time, in request order.
//   - Exposed tools: read_file / write_file / list_dir / run_shell. Any other
//     name (including run_code itself) is rejected by the parent.
//   - TYPE STRIPPING ONLY: this file is executed by Node's native type stripping,
//     so only ERASABLE TypeScript is allowed - no \`enum\`, no \`namespace\`, no
//     parameter properties, no \`declare\`. Plain JavaScript always works.
//   - Do not read process.stdin and do not call process.exit(): stdin is the
//     protocol reply channel and this harness is the entry point.
// =============================================================================
import { readSync as _readSync } from "node:fs";
import { StringDecoder as _StringDecoder } from "node:string_decoder";
import { createRequire as _createRequire } from "node:module";

// Models sometimes reach for CommonJS: in an ES module \`require\` is undefined,
// so expose the real one (the same resolution rules as this file).
(globalThis as { require?: unknown }).require ??= _createRequire(import.meta.url);

class ToolCallError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super("tool '" + toolName + "' failed: " + message);
    this.name = "ToolCallError";
    this.toolName = toolName;
  }
}

let _subCallId = 0;
let _pending = "";
let _eof = false;
const _decoder = new _StringDecoder("utf8");

/** Synchronous sleep (only needed if the reply channel is non-blocking). */
function _sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* last-resort spin: the bridge must never hang */
    }
  }
}

/**
 * Read ONE line from the protocol channel, blocking until it arrives (the
 * equivalent of Python's \`sys.stdin.readline()\`). Returns null at EOF.
 *
 * The buffer may already hold several lines (the parent writes replies back to
 * back) and one read may split a UTF-8 sequence, which is why bytes go through
 * a StringDecoder rather than \`chunk.toString()\`. CRLF is accepted.
 */
function _readProtocolLine(): string | null {
  for (;;) {
    const nl = _pending.indexOf("\\n");
    if (nl >= 0) {
      const line = _pending.slice(0, nl);
      _pending = _pending.slice(nl + 1);
      return line.endsWith("\\r") ? line.slice(0, -1) : line;
    }
    if (_eof) {
      // A trailing fragment without a newline is still a line (readline does the
      // same); only a fully drained buffer means EOF.
      if (_pending === "") return null;
      const rest = _pending;
      _pending = "";
      return rest;
    }
    const chunk = Buffer.allocUnsafe(65536);
    let read = 0;
    try {
      read = _readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        _sleepMs(5); // non-blocking stdin: wait, then retry (never fail the call)
        continue;
      }
      throw new ToolCallError("protocol", "cannot read the reply channel: " + String((error as Error).message));
    }
    if (read === 0) {
      _eof = true;
      _pending += _decoder.end();
      continue;
    }
    _pending += _decoder.write(chunk.subarray(0, read));
  }
}

/** One bridge call: request line out, reply line in, value or ToolCallError. */
function _bridgeCall(tool: string, args: unknown): unknown {
  const requestId = ++_subCallId;
  let payload: string;
  try {
    payload = JSON.stringify({ id: requestId, tool: tool, args: args === undefined ? {} : args });
  } catch (error) {
    throw new ToolCallError(tool, "arguments are not JSON-serializable: " + String((error as Error).message));
  }
  process.stdout.write(payload + "\\n");
  const line = _readProtocolLine();
  if (line === null) {
    throw new ToolCallError(tool, "the parent broker closed the reply channel (run aborted)");
  }
  let reply: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(line);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("reply is not a JSON object");
    }
    reply = decoded as Record<string, unknown>;
  } catch (error) {
    throw new ToolCallError(tool, "malformed reply from the parent broker: " + String((error as Error).message));
  }
  if (reply["id"] !== requestId) {
    throw new ToolCallError(tool, "reply id mismatch (expected " + requestId + ", got " + String(reply["id"]) + ")");
  }
  if (reply["ok"] !== true) {
    const message = typeof reply["error"] === "string" ? (reply["error"] as string) : "unknown error";
    throw new ToolCallError(tool, message);
  }
  return reply["value"] === undefined ? null : reply["value"];
}

/** Canonical single-argument name per bridged tool (for the positional shortcut). */
const _primaryArg: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  list_dir: "path",
  run_shell: "command",
};

/**
 * Both call styles work: the documented object form
 * (\`tools.read_file({ path: ... })\`) and the positional shorthand models write
 * anyway (\`tools.read_file("x")\`, \`tools.write_file("x", "content")\`).
 */
function _mergeArgs(tool: string, received: readonly unknown[]): Record<string, unknown> {
  const first = received[0];
  const second = received[1];
  if (typeof first === "string") {
    const args: Record<string, unknown> = {};
    args[_primaryArg[tool] as string] = first;
    if (tool === "write_file" && typeof second === "string") args["content"] = second;
    return args;
  }
  if (first === undefined) return {};
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new ToolCallError(
      tool,
      "expected an arguments object, e.g. tools." + tool + "({ " + (_primaryArg[tool] as string) + ": ... })",
    );
  }
  const args: Record<string, unknown> = { ...(first as Record<string, unknown>) };
  if (tool === "write_file" && typeof second === "string") args["content"] = second;
  return args;
}

class _Tools {
  read_file(...args: unknown[]): unknown {
    return _bridgeCall("read_file", _mergeArgs("read_file", args));
  }

  write_file(...args: unknown[]): unknown {
    return _bridgeCall("write_file", _mergeArgs("write_file", args));
  }

  list_dir(...args: unknown[]): unknown {
    return _bridgeCall("list_dir", _mergeArgs("list_dir", args));
  }

  run_shell(...args: unknown[]): unknown {
    // The full result object: {"exit_code", "stdout", "stderr", ...}.
    return _bridgeCall("run_shell", _mergeArgs("run_shell", args));
  }
}

const tools = new _Tools();
`;

/**
 * The TypeScript runner appended after the user program (W774).
 *
 * Python parity, line for line: run `main()`, await it, emit `{__final__: …}`;
 * on any failure print the stack (the traceback equivalent) and then
 * `{__error__: "<Name>: <message>"}`, and exit 1. `undefined` becomes `null`
 * because `JSON.stringify` drops `undefined`, while Python's `main()` returning
 * None reports `{"__final__": null}` — the broker must see the same shape.
 *
 * `process.exitCode` is set instead of calling `process.exit()`: the protocol
 * line is written to a PIPE, and an immediate exit can truncate it.
 */
export const RUN_CODE_RUNNER_TS = `
// ======================= harness entry point (injected) =======================
function _celesteaErrorLine(error: unknown): string {
  const named = error as { name?: unknown; message?: unknown };
  const name = typeof named?.name === "string" ? named.name : "Error";
  const message = named?.message === undefined ? String(error) : String(named.message);
  return name + ": " + message;
}

function _celesteaFail(error: unknown): void {
  const stacked = error as { stack?: unknown };
  const text = typeof stacked?.stack === "string" ? stacked.stack : _celesteaErrorLine(error);
  for (const line of text.split("\\n")) process.stdout.write(line + "\\n");
  process.stdout.write(JSON.stringify({ __error__: _celesteaErrorLine(error) }) + "\\n");
  process.exitCode = 1;
}

async function _celesteaRunMain(): Promise<unknown> {
  // \`typeof\` on an undeclared identifier is safe, so a program without main()
  // gets a clear message instead of a ReferenceError.
  const entry: unknown = typeof main === "function" ? main : undefined;
  if (entry === undefined) {
    throw new Error(
      "run_code: no 'main' defined - write the program as a function body, or as a " +
        "complete script defining function main() (it may be async)",
    );
  }
  return await (entry as () => unknown)();
}

_celesteaRunMain().then(
  function (value: unknown): void {
    try {
      process.stdout.write(JSON.stringify({ __final__: value === undefined ? null : value }) + "\\n");
    } catch (error) {
      _celesteaFail(error);
    }
  },
  function (error: unknown): void {
    _celesteaFail(error);
  },
);
`;
