/**
 * Structured tool-pipeline errors.
 *
 * The pipeline never throws across the `Tool` seam: a tool rejects with a
 * `ToolFailure` whose `message` is the machine-readable contract string
 * `<prefix>: code=<code> msg="<quoted>"` (Rust parity: `toolguard: …`,
 * `run_shell-sandbox: …`, `http_request: code=…`), and the registry captures it
 * into `ToolOutput.error`. Callers branch on `kind`/`code`, never on prose.
 */

import { ToolFailure } from "./tool-failure.js";

export { ToolFailure, isToolFailure } from "./tool-failure.js";

/** Stable prefix of argument-validation failures (`registry` pipeline stage 1). */
export const TOOLARG_ERROR_PREFIX = "toolargs";
/** Stable prefix of guard denials (Rust `GUARD_ERROR_PREFIX`). */
export const GUARD_ERROR_PREFIX = "toolguard";

/** Escape + truncate a message so the one-line error contract stays parseable. */
export function quoteMessage(message: string): string {
  let out = "";
  let count = 0;
  for (const ch of message) {
    if (count >= 512) break;
    count += 1;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}

/** `<prefix>: code=<code> msg="<quoted>"` — the tool-side contract error shape. */
export function contractError(prefix: string, code: string, message: string): string {
  return `${prefix}: code=${code} msg="${quoteMessage(message)}"`;
}

/** Build a structured failure with the contract message already formatted. */
export function contractFailure(prefix: string, code: string, message: string): ToolFailure {
  return new ToolFailure(code, contractError(prefix, code, message));
}

/** Error text for `ToolOutput.error`; non-Error rejections are stringified. */
export function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

/** `run_shell-sandbox: code=timeout msg="…"` → `timeout` (for tests/diagnostics). */
export function errorCode(message: string): string | null {
  const match = /(?:^|\s)code=([a-z_]+)/.exec(message);
  return match?.[1] ?? null;
}
