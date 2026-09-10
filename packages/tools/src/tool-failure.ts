/**
 * `ToolFailure` — the single rejection type of a tool executor.
 *
 * Mirrors Rust's `Result<Value, String>`: the seam rejects with an `Error`
 * (never a bare string) whose `message` is the structured contract error, so
 * `ToolOutput.error` stays parseable while callers keep a typed handle.
 */

export class ToolFailure extends Error {
  /** Stable machine-readable code (`schema`, `invalid_arg`, `binary_file`, …). */
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.kind = kind;
  }
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return value instanceof ToolFailure;
}
