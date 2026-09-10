/**
 * The production path-whitelist guard (`crates/tools/src/guard.rs`).
 *
 * Policy:
 * - the **workspace** (`CELESTEA_TOOL_WORKDIR`, default: process cwd) is the
 *   only writable root;
 * - `CELESTEA_TOOL_ROOTS` is a comma-separated list of extra READ roots
 *   (whitelist roots are read-only: the workspace is the writable subset);
 * - only `read_file` / `list_dir` (read) and `write_file` (write) carry a
 *   `path` this guard arbitrates; `run_shell`, `process_control` and
 *   `http_request` keep their own layers and pass through untouched;
 * - a missing/ill-typed `path` passes through: the tool's own validation
 *   reports it, the guard only arbitrates real paths.
 *
 * **Fail closed**: when `CELESTEA_TOOL_ROOTS` is set but an entry cannot be used
 * (missing, not a directory, unlistable), the policy denies every path-bearing
 * call with `code=tool_roots_invalid` instead of silently ignoring the entry —
 * an operator typo must never quietly widen or narrow access.
 *
 * `CELESTEA_TOOL_GUARD=0` skips *mounting* the chain (explicit escape hatch; it
 * never weakens the http policy or the sandbox).
 */

import type { ToolDecision, ToolGuard, ToolInput, ToolRegistry } from "@celestea/core";

import { resolve } from "node:path";

import { envFlag, envString } from "../env.js";
import { contractError } from "../errors.js";
import { isDirectory, isInside, resolveExistingTarget, resolveWriteTarget } from "./paths.js";

export const ENV_TOOL_ROOTS = "CELESTEA_TOOL_ROOTS";
export const ENV_TOOL_WORKDIR = "CELESTEA_TOOL_WORKDIR";
export const ENV_TOOL_GUARD = "CELESTEA_TOOL_GUARD";
export const GUARD_ERROR_PREFIX = "toolguard";

const ALLOW: ToolDecision = { kind: "allow" };
const READ_TOOLS = new Set(["read_file", "list_dir"]);
const WRITE_TOOLS = new Set(["write_file"]);

/**
 * Platform path-list separator: `:` on unix, `;` on windows — the same
 * semantics as Rust `std::env::split_paths`. A comma is ALSO accepted (the
 * earlier TS-only documentation used commas), so `CELESTEA_TOOL_ROOTS` may be
 * written either way.
 *
 * Note the platform distinction matters: a windows drive letter (`C:\dir`)
 * must not be split on `:`.
 */
const LIST_SEPARATOR = new RegExp(`[${process.platform === "win32" ? ";" : ":"},]`);

/** Split a root list (platform separator or comma; empty entries skipped). */
export function parseToolRoots(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export interface PathGuardPolicyInit {
  workspace: string;
  readRoots?: readonly string[];
  /** Set when the declared roots were unusable → every path call is denied. */
  failClosedReason?: string | null;
}

/** Canonical writable workspace + canonical read roots (workspace first). */
export class PathGuardPolicy {
  readonly workspace: string;
  readonly readRoots: readonly string[];
  readonly failClosedReason: string | null;

  constructor(init: PathGuardPolicyInit) {
    this.workspace = init.workspace;
    this.readRoots = [init.workspace, ...(init.readRoots ?? [])];
    this.failClosedReason = init.failClosedReason ?? null;
  }

  /** Policy from the environment (`CELESTEA_TOOL_WORKDIR` + `CELESTEA_TOOL_ROOTS`). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PathGuardPolicy {
    const workspaceRaw = envString(env, ENV_TOOL_WORKDIR) ?? process.cwd();
    const workspace = resolveExistingTarget(workspaceRaw, process.cwd()) ?? resolve(workspaceRaw);
    const raw = envString(env, ENV_TOOL_ROOTS);
    if (raw === undefined) return new PathGuardPolicy({ workspace });
    const entries = parseToolRoots(raw);
    if (entries.length === 0) {
      return new PathGuardPolicy({ workspace, failClosedReason: `${ENV_TOOL_ROOTS} is set but lists no directory` });
    }
    const readRoots: string[] = [];
    let failClosedReason: string | null = null;
    for (const entry of entries) {
      const canonical = resolveExistingTarget(entry, workspace);
      if (canonical === null) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' does not exist`;
      else if (!isDirectory(canonical)) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' is not a directory`;
      else readRoots.push(canonical);
    }
    return new PathGuardPolicy({ workspace, readRoots, failClosedReason });
  }

  /** read/list: the canonical target must resolve inside a read root. */
  checkRead(target: string): ToolDecision {
    const blocked = this.failClosed();
    if (blocked !== null) return blocked;
    const canonical = resolveExistingTarget(target, this.workspace);
    if (canonical === null) return ALLOW;
    if (this.readRoots.some((root) => isInside(canonical, root))) return ALLOW;
    return deny(
      "path_forbidden",
      `read/list path '${target}' is outside the allowed roots (workspace '${this.workspace}' + ${ENV_TOOL_ROOTS})`,
    );
  }

  /** write: the canonical target must stay inside the workspace (roots are ro). */
  checkWrite(target: string): ToolDecision {
    const blocked = this.failClosed();
    if (blocked !== null) return blocked;
    const canonical = resolveWriteTarget(target, this.workspace);
    if (canonical === null) return ALLOW;
    if (isInside(canonical, this.workspace)) return ALLOW;
    return deny("path_forbidden", `write path '${target}' is outside the workspace '${this.workspace}'`);
  }

  private failClosed(): ToolDecision | null {
    if (this.failClosedReason === null) return null;
    return deny(
      "tool_roots_invalid",
      `${this.failClosedReason} — failing closed: path tools are denied until ${ENV_TOOL_ROOTS} is fixed`,
    );
  }
}

/** The guard: arbitrates `path` arguments of the file tools, passes the rest. */
export class PathGuard implements ToolGuard {
  private readonly policy: PathGuardPolicy;

  constructor(policy: PathGuardPolicy) {
    this.policy = policy;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PathGuard {
    return new PathGuard(PathGuardPolicy.fromEnv(env));
  }

  async check(input: ToolInput): Promise<ToolDecision> {
    if (!READ_TOOLS.has(input.name) && !WRITE_TOOLS.has(input.name)) return ALLOW;
    const target = pathArgument(input.args);
    if (target === null) return ALLOW;
    return WRITE_TOOLS.has(input.name) ? this.policy.checkWrite(target) : this.policy.checkRead(target);
  }
}

function pathArgument(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)["path"];
  return typeof value === "string" ? value : null;
}

function deny(code: string, message: string): ToolDecision {
  return { kind: "deny", reason: contractError(GUARD_ERROR_PREFIX, code, message) };
}

/**
 * Mount the production guard chain. Returns whether it was mounted;
 * `CELESTEA_TOOL_GUARD=0` explicitly opts out (documented escape hatch — the
 * caller is responsible for surfacing that in its own diagnostics).
 */
export function mountProductionGuards(registry: ToolRegistry, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!envFlag(envString(env, ENV_TOOL_GUARD), true)) return false;
  registry.addGuard(PathGuard.fromEnv(env));
  return true;
}
