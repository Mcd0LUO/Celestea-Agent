/**
 * The engine-injected Python SDK preamble + runner (W255).
 *
 * Byte-for-byte port of `RUN_CODE_SDK` / `RUN_CODE_RUNNER` in
 * `crates/tools/src/run_code.rs` (the Rust raw strings are re-encoded here as
 * escape-safe template literals; `run-code/sdk.test.ts` re-extracts the Rust
 * blocks and diffs them, so drift cannot hide).
 *
 * The program the broker actually runs is `SDK + user code + RUNNER`:
 *   - the SDK exposes exactly one object `tools` (four synchronous bridges) and
 *     the catchable `ToolCallError`; every bridge call is a one-line JSON
 *     request on stdout, answered by the parent on stdin;
 *   - the runner calls `main()` (awaiting it when it is a coroutine) and emits
 *     `{"__final__": <json>}` — or `{"__error__": "<Type>: <msg>"}` after
 *     printing the traceback, exiting 1.
 */

/** The SDK preamble (standard library only; zero pip). */
export const RUN_CODE_SDK = `# =============================================================================
# celestea run_code SDK (W255 P0) - engine-injected preamble. Standard library
# only (zero pip). Runs under \`python3 -uB <file>\` inside the Celestea
# execution sandbox; the parent engine (the "broker") reads our protocol lines
# from stdout and writes replies to stdin.
#
# Protocol (one JSON object per line, no other framing):
#   child -> parent   {"id": <int>, "tool": "<name>", "args": {...}}
#   parent -> child   {"id": <int>, "ok": true, "value": <json>, "truncated": <bool>}
#                     {"id": <int>, "ok": false, "error": "<message>"}
#   child -> parent   {"__final__": <json>}      (normal end: main()'s return)
#                     {"__error__": "<message>"} (uncaught exception)
#
# Contract:
#   - Write the program as an \`async def main():\` FUNCTION BODY, or as a
#     complete script that defines main. main()'s return value (lossless JSON)
#     is the final result of the run.
#   - \`tools.<name>(**args)\` (also \`tools.<name>({"path": ...})\`) is a
#     SYNCHRONOUS bridge: every sub-call is dispatched by the parent through
#     its normal tool pipeline (guards, schema checks, limits). A failure
#     raises ToolCallError - catch it and continue.
#   - Only print what the model needs (stdout logs are budgeted at 64KiB);
#     intermediate tool results never enter the conversation automatically.
#   - Sub-calls run SERIALLY in P0: Python-side concurrency (the Promise.all
#     equivalent for independent read-only calls) is a documented follow-up.
#   - Exposed tools: read_file / write_file / list_dir / run_shell. Any other
#     name (including run_code itself) is rejected by the parent.
#   - Do not read sys.stdin and do not add an \`if __name__ == "__main__"\`
#     block: stdin is the protocol reply channel and this harness is the
#     entry point.
# =============================================================================
import sys as _sys
import json as _json
import traceback as _traceback


class ToolCallError(Exception):
    """A bridged tool call failed (guard denial, unknown tool, dispatch
    error, limit exceeded). Catchable: the program may recover and continue."""

    def __init__(self, tool_name, message):
        super().__init__(f"tool '{tool_name}' failed: {message}")
        self.tool_name = tool_name


_sub_call_id = 0


def _bridge_call(tool, args):
    global _sub_call_id
    _sub_call_id += 1
    request_id = _sub_call_id
    try:
        payload = _json.dumps(
            {"id": request_id, "tool": tool, "args": args}, ensure_ascii=False
        )
    except (TypeError, ValueError) as exc:
        raise ToolCallError(tool, f"arguments are not JSON-serializable: {exc}")
    print(payload, flush=True)
    line = _sys.stdin.readline()
    if not line:
        raise ToolCallError(tool, "the parent broker closed the reply channel (run aborted)")
    try:
        reply = _json.loads(line)
    except ValueError as exc:
        raise ToolCallError(tool, f"malformed reply from the parent broker: {exc}")
    if reply.get("id") != request_id:
        raise ToolCallError(
            tool, f"reply id mismatch (expected {request_id}, got {reply.get('id')})"
        )
    if not reply.get("ok", False):
        raise ToolCallError(tool, reply.get("error", "unknown error"))
    return _Value(_attr(reply.get("value")))


class _AttrDict(dict):
    """dict whose keys are also attributes: s.stdout == s['stdout'].
    Models write both styles; both must work, including AFTER \`await\`."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)


def _attr(v):
    """Recursively convert decoded JSON dicts/lists so every dict in a tool
    result is an _AttrDict (attribute access everywhere, at any depth)."""
    if isinstance(v, dict):
        return _AttrDict({k: _attr(x) for k, x in v.items()})
    if isinstance(v, list):
        return [_attr(x) for x in v]
    return v


class _Value:
    """Dual-interface tool result: usable directly (indexing/iteration/str)
    AND awaitable. Models write both styles — \`await tools.list_dir(...)\`
    and \`tools.list_dir(...)\` must behave identically."""

    def __init__(self, v):
        self._v = v

    def __await__(self):
        # Correct awaitable protocol: yield NOTHING and RETURN the value.
        # (Yielding the value itself makes asyncio treat it as an awaitable
        #  and dict/list results blow up with "Task got bad yield".)
        if False:
            yield
        return self._v

    def __iter__(self):
        return iter(self._v)

    def __getitem__(self, k):
        return self._v[k]

    def __len__(self):
        return len(self._v)

    def __bool__(self):
        return bool(self._v)

    def __str__(self):
        return str(self._v)

    def __repr__(self):
        return repr(self._v)

    def __eq__(self, other):
        if isinstance(other, _Value):
            other = other._v
        return self._v == other

    def get(self, *a, **k):
        return self._v.get(*a, **k) if hasattr(self._v, "get") else None

    def __getattr__(self, name):
        # Method passthrough (splitlines, keys, ...) so the wrapper behaves
        # exactly like the wrapped value in normal code paths.
        return getattr(self._v, name)


def _merge_args(positional, kwargs, tool):
    if positional:
        if len(positional) == 1 and isinstance(positional[0], dict):
            merged = dict(positional[0])
            merged.update(kwargs)
            return merged
        raise ToolCallError(tool, "expected a single dict argument and/or keyword arguments")
    return dict(kwargs)


class _Tools:
    """The SDK tool surface: only these four tools are bridged to the parent
    (read_file / write_file / list_dir / run_shell)."""

    def read_file(self, *args, **kwargs):
        return _bridge_call("read_file", _merge_args(args, kwargs, "read_file"))

    def write_file(self, *args, **kwargs):
        return _bridge_call("write_file", _merge_args(args, kwargs, "write_file"))

    def list_dir(self, *args, **kwargs):
        return _bridge_call("list_dir", _merge_args(args, kwargs, "list_dir"))

    def run_shell(self, *args, **kwargs):
        # Returns the full result dict: {"exit_code", "stdout", "stderr", ...}.
        # Fields are readable both ways: s['stdout'] AND s.stdout, before or
        # after \`await\` (results are _AttrDict at any depth).
        return _bridge_call("run_shell", _merge_args(args, kwargs, "run_shell"))


tools = _Tools()
`;

/** The runner appended after the user program. */
export const RUN_CODE_RUNNER = `
# ======================= harness entry point (injected) =======================
def _plain(v):
    """Unwrap dual-interface results before JSON serialization (dict/list deep)."""
    if isinstance(v, _Value):
        v = v._v
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


import asyncio as _asyncio


def _celestea_run_main():
    main = globals().get("main")
    if main is None:
        raise RuntimeError(
            "run_code: no 'main' defined - write the program as an async "
            "function body, or as a complete script defining async def main()"
        )
    result = main()
    if _asyncio.iscoroutine(result):
        result = _asyncio.run(result)
    return result


try:
    _final_value = _celestea_run_main()
    print(_json.dumps({"__final__": _plain(_final_value)}, ensure_ascii=False), flush=True)
except BaseException as _exc:  # report ANY failure as __error__
    _tb = _traceback.format_exc()
    for _line in _tb.rstrip("\\n").split("\\n"):
        print(_line, flush=True)
    print(
        _json.dumps({"__error__": f"{type(_exc).__name__}: {_exc}"}, ensure_ascii=False),
        flush=True,
    )
    _sys.exit(1)
`;

/**
 * Assemble the program file: SDK preamble + user code + runner. When the first
 * non-blank line of the user code is indented it is treated as an **async
 * function body** and wrapped into `async def main():`; otherwise it must be a
 * complete script defining `main` itself (Rust `assemble_program`).
 */
export function assembleProgram(userCode: string): string {
  const parts = [RUN_CODE_SDK, "\n\n# ========================== user program ==========================\n"];
  parts.push(firstNonblankLineIndented(userCode) ? wrapBody(userCode) : terminate(userCode));
  parts.push(RUN_CODE_RUNNER);
  return parts.join("");
}

/** True when the first non-blank line starts with whitespace (body form). */
export function firstNonblankLineIndented(code: string): boolean {
  const line = splitProgramLines(code).find((candidate) => candidate.trim() !== "");
  return line !== undefined && (line.startsWith(" ") || line.startsWith("\t"));
}

/** `async def main():` + the user body, indented one level (blank lines kept). */
function wrapBody(userCode: string): string {
  const out: string[] = ["async def main():\n"];
  for (const line of splitProgramLines(userCode)) {
    out.push(line.trim() === "" ? "\n" : `    ${line}\n`);
  }
  out.push("\n");
  return out.join("");
}

function terminate(userCode: string): string {
  return userCode.endsWith("\n") ? userCode : `${userCode}\n`;
}

/** Rust `str::lines()`: split on `\n`, drop a trailing `\r`, no final empty line. */
function splitProgramLines(code: string): string[] {
  const lines = code.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
