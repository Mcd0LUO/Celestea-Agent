/**
 * Structured tool-pipeline errors — **the one denial vocabulary** (W1483).
 *
 * The pipeline never throws across the `Tool` seam: a tool rejects with a
 * `ToolFailure` whose `message` is the machine-readable contract string
 * `<prefix>: code=<code> msg="<quoted>"`, and the registry captures it into
 * `ToolOutput.error`. Callers branch on `kind`/`code` (and on
 * [denialFamily]), never on prose.
 *
 * W1483 — why this module owns the vocabulary. Three prefixes used to be
 * produced by three unrelated places with no single declaration:
 *
 * | family    | prefix               | producer                                    |
 * |-----------|----------------------|---------------------------------------------|
 * | `args`    | `toolargs`           | `registry.ts` (schema stage)                |
 * | `guard`   | `toolguard`          | `registry.ts` + `guard/path-guard.ts`       |
 * | `sandbox` | `run_shell-sandbox`  | `@celestea/core`'s `SandboxError`            |
 *
 * The *prefixes themselves are frozen contract* — the Rust parity target
 * (`crates/tools/src/registry.rs`, `crates/tools/src/sandbox.rs`) and several
 * suites pin them byte-for-byte, so W1483 deliberately does NOT rename them.
 * What it unifies is everything else: every producer now reads its prefix from
 * [DENIAL_PREFIXES] (the single declaration), every denial is rendered by the
 * single [contractError] shape, and a consumer can ask [denialFamily] which
 * refusal it is looking at instead of string-matching three literals itself.
 */

import { contractDenial } from "@celestea/core";

import { ToolFailure } from "./tool-failure.js";

export { ToolFailure, isToolFailure } from "./tool-failure.js";

/** Which stage of the pipeline refused the call. */
export type DenialFamily = "args" | "guard" | "sandbox";

/**
 * The three prefixes, declared exactly once. `sandbox` is re-exported from
 * `core` (where `SandboxError` renders it) so the two packages can never drift.
 */
export const DENIAL_PREFIXES: Readonly<Record<DenialFamily, string>> = {
  args: "toolargs",
  guard: "toolguard",
  sandbox: "run_shell-sandbox",
};

/** Stable prefix of argument-validation failures (`registry` pipeline stage 1). */
export const TOOLARG_ERROR_PREFIX = DENIAL_PREFIXES.args;
/** Stable prefix of guard denials (legacy `GUARD_ERROR_PREFIX`). */
export const GUARD_ERROR_PREFIX = DENIAL_PREFIXES.guard;
/** Stable prefix of sandbox failures (rendered by `core`'s `SandboxError`). */
export const SANDBOX_ERROR_PREFIX = DENIAL_PREFIXES.sandbox;

/**
 * Which denial family `message` belongs to, or `null` when it is not a contract
 * denial at all (a tool's own failure text, an IO error, …).
 *
 * `sandbox` is matched first on purpose: it is the only prefix that is a
 * superset of another (`run_shell-sandbox:` ends in `-sandbox:`), so a future
 * shorter sibling prefix cannot silently shadow it.
 */
export function denialFamily(message: string): DenialFamily | null {
  if (message.startsWith(`${DENIAL_PREFIXES.sandbox}:`)) return "sandbox";
  if (message.startsWith(`${DENIAL_PREFIXES.guard}:`)) return "guard";
  if (message.startsWith(`${DENIAL_PREFIXES.args}:`)) return "args";
  return null;
}

/** true when `message` is a contract denial (one of the three families). */
export function isDenialText(message: string): boolean {
  return denialFamily(message) !== null;
}

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
  return contractDenial(prefix, code, message);
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
