/**
 * Argument readers for tool executors.
 *
 * The registry validates `args` against the tool's JSON Schema before dispatch,
 * so these helpers exist for two reasons: direct `execute()` calls (tests,
 * embeddings) that bypass the pipeline, and Rust-parity error text
 * (`missing 'path' (expected string)`).
 */

import { ToolFailure } from "./tool-failure.js";

export function objectArg(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  throw new ToolFailure("invalid_arg", "args must be an object");
}

/** Required string argument (Rust `arg_str`). */
export function stringArg(args: unknown, key: string): string {
  const value = objectArg(args)[key];
  if (typeof value !== "string") throw new ToolFailure("invalid_arg", `missing '${key}' (expected string)`);
  return value;
}

export function optionalStringArg(args: unknown, key: string): string | undefined {
  const value = objectArg(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolFailure("invalid_arg", `'${key}' must be a string`);
  return value;
}

export function boolArg(args: unknown, key: string, fallback: boolean): boolean {
  const value = objectArg(args)[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ToolFailure("invalid_arg", `'${key}' must be a boolean`);
  return value;
}

export function optionalIntArg(args: unknown, key: string): number | undefined {
  const value = objectArg(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolFailure("invalid_arg", `'${key}' must be an integer`);
  }
  return value;
}

export function optionalRecordArg(args: unknown, key: string): Record<string, unknown> | undefined {
  const value = objectArg(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ToolFailure("invalid_arg", `'${key}' must be an object`);
  return value as Record<string, unknown>;
}
