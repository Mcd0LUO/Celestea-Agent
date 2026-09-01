# REPORT — crates/tools (W103)

## What was created

- `crates/tools/src/lib.rs` — the full implementation (registry + builtin tools + tests).
- `crates/tools/REPORT.md` — this file.

Only files under `crates/tools/` were touched. No change to root Cargo.toml,
ARCHITECTURE.md, crates/core/, or any other crate.

## Pinned API implemented

Exactly per ARCHITECTURE.md "tools (W103)":

```rust
pub struct ToolRegistryImpl { ... }
impl ToolRegistryImpl { pub fn new() -> Self }
impl celestea_core::ToolRegistry for ToolRegistryImpl { ... }
pub fn builtin_tools() -> Vec<Box<dyn celestea_core::Tool>>;
```

## Key implementation points

- **Storage**: `HashMap<String, Arc<dyn Tool>>` (keyed by the tool spec's name) plus
  `Vec<Arc<dyn ToolGuard>>` in registration order. Both `Send + Sync`; the struct is
  `#[derive(Default)]` and also exposes `new()`.
- **register**: inserts by `tool.spec().name`, so a later registration of the same name
  replaces the earlier one (matches NamedRegistry "patch" semantics).
- **add_guard**: pushes to the back; guards run FIFO.
- **get**: returns `Option<&dyn Tool>` by name.
- **schemas**: collects every tool's `ToolSpec` and sorts by `name` for deterministic
  output.
- **dispatch**: clones `call_id` up front, then runs guards in order. The first
  non-`Allow` decision short-circuits: `Deny(s) -> error "denied: {s}"`,
  `Ask(q) -> error "ask: {q}"`, both with `value: None`. If all guards Allow, the tool is
  looked up; an unknown name yields `error "unknown tool: {name}"`. Otherwise
  `execute(args)` is awaited: `Ok(v) -> value Some(v), error None` /
  `Err(e) -> value None, error Some(e)`. Errors are captured into `ToolOutput`, never
  thrown.

## Builtin tools (hand-written JSON schemas via serde_json::json!)

1. `read_file(path: string)` — `tokio::fs::read_to_string`, returns the text string.
2. `write_file(path, content)` — `tokio::fs::write`, returns `"ok"`.
3. `list_dir(path)` — `tokio::fs::read_dir`, returns an array of entry names.
4. `run_shell(command: string)` — executes via `tokio::process::Command`;
   Windows: `cmd /C <command>` (`#[cfg(windows)]`), otherwise `sh -c <command>`
   (`#[cfg(not(windows))]`). Returns `{ "stdout", "stderr", "exit_code" }`.

Tools are built with a private `FnTool` adapter (`Arc<dyn Fn(Value) -> BoxFuture> + Send + Sync`)
so each builtin is a thin closure over the async std/tokio call while still satisfying the
`Tool` trait exactly.

## Compile / test verification (from repo root, GNU toolchain 1.98.0)

```
cargo build -p celestea-tools   -> Finished dev profile, exit code 0, no warnings
cargo test  -p celestea-tools   -> 4 passed, 0 failed, no warnings
```

Tests:
- `read_file_dispatch_reads_temp_file`: registers the builtin read_file, dispatches against a
  temp file, asserts `value == "hello celestea"` and no error.
- `unknown_tool_reports_error`: asserts `error == "unknown tool: nope"`.
- `guard_deny_short_circuits`: a Deny guard yields `error == "denied: policy says no"`.
- `schemas_are_sorted_by_name`: asserts deterministic name ordering
  `["list_dir","read_file","run_shell","write_file"]`.

## Assumptions / notes

- `run_shell` returns a JSON object (stdout/stderr/exit_code) rather than a single
  concatenated string; this satisfies "return stdout+stderr" and is more useful for the
  model. exit_code is `null` when the process is terminated by a signal (no code).
- No additional dependencies were needed: tokio ("full"), serde_json, serde, async-trait,
  and celestea-core were already pinned and sufficient.
- `ToolDecision::Ask` is surfaced as an `error` string prefixed `"ask: "` per the pinned
  dispatch contract; no separate interactive confirmation path exists in this seam.
