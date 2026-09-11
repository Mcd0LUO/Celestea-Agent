/**
 * The production path-whitelist guard (`crates/tools/src/guard.rs`).
 *
 * Policy:
 * - the **workspace** (`CELESTEA_TOOL_WORKDIR`, default: process cwd) is the
 *   only writable root;
 * - `CELESTEA_TOOL_ROOTS` is a comma-separated list of extra READ roots
 *   (whitelist roots are read-only: the workspace is the writable subset);
 * - **argument-driven, never a name whitelist (W738 P1)**: the guard inspects the
 *   ARGUMENTS of the call. Any tool whose arguments carry a path-like value (see
 *   [PATH_ARG_KEYS]) is arbitrated; [PATH_ACCESS] only declares *which* access a
 *   **known** tool needs — `read` (`read_file`, `list_dir`), `write`
 *   (`write_file`), or `self` for the tools that carry their own confinement
 *   layer (`run_shell`: the sandbox root; `spawn_worker`: the host-side session
 *   RPC). A tool that is NOT declared is checked as a **write**: it may only
 *   touch the writable roots. A newly registered tool is therefore constrained
 *   by default and can never be fail-OPEN just because nobody added it to a
 *   list;
 * - a missing/ill-typed path argument passes through: the tool's own validation
 *   reports it, the guard only arbitrates real paths.
 *
 * **Fail closed**: when `CELESTEA_TOOL_ROOTS` is set but an entry cannot be used
 * (missing, not a directory, unlistable), the policy denies every path-bearing
 * call with `code=tool_roots_invalid` instead of silently ignoring the entry —
 * an operator typo must never quietly widen or narrow access.
 *
 * `CELESTEA_TOOL_GUARD=0` skips *mounting* the chain (explicit escape hatch; it
 * never weakens the http policy or the sandbox).
 *
 * W516 (session grants): a host may pass a [PathGuardGrants] view with extra
 * read/write roots read from the session's `grants.json`. Grants are strictly
 * ADDITIVE — the workspace stays writable, env read roots stay read-only, the
 * mount decision is untouched — and a bad grant root is dropped by the host
 * (ignore-the-entry), the exact opposite of the env fail-closed rule above.
 * Both policies are deliberate: env is the operator's posture (a typo must be
 * loud), grants are a per-session widening (ignoring one falls back to least
 * privilege, and a hard failure would only push users to `CELESTEA_TOOL_GUARD=0`).
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

/** Access a tool needs to its path-like arguments. */
export type PathAccess = "read" | "write" | "self";

/**
 * Declared access per **known** tool (W738 P1). `self` = the tool confines the
 * path in its own layer, so this guard stays out of the way. Everything absent
 * from this map is treated as `write` (the fail-closed floor), NOT as `allow`.
 */
export const PATH_ACCESS: ReadonlyMap<string, PathAccess> = new Map<string, PathAccess>([
  ["read_file", "read"],
  ["list_dir", "read"],
  ["write_file", "write"],
  ["run_shell", "self"],
  ["spawn_worker", "self"],
]);

/**
 * Argument names carrying a path. Deliberately argument-based: a new tool with a
 * `path`/`dir`/`workspace` argument is arbitrated without any registration step.
 */
export const PATH_ARG_KEYS: readonly string[] = [
  "path",
  "paths",
  "file",
  "files",
  "dir",
  "dirs",
  "directory",
  "workdir",
  "cwd",
  "root",
  "roots",
  "workspace",
];

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
  /**
   * Extra WRITABLE roots (session grants only, W516). The workspace is always a
   * writable root and can never be removed: grants only ADD roots.
   */
  writeRoots?: readonly string[];
  /** Set when the declared roots were unusable → every path call is denied. */
  failClosedReason?: string | null;
}

/**
 * Session-grant view of the path policy (W516). Structural on purpose: the
 * tools package never imports the host's grants module. Both lists are already
 * validated + canonicalized by the host (`effectiveGrantsOf`), and neither can
 * *narrow* anything — they are appended to the env-derived roots.
 */
export interface PathGuardGrants {
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
}

/** Canonical writable workspace + canonical read/write roots (workspace first). */
export class PathGuardPolicy {
  readonly workspace: string;
  readonly readRoots: readonly string[];
  /** Workspace first; grants may only append (never remove or demote). */
  readonly writeRoots: readonly string[];
  readonly failClosedReason: string | null;

  constructor(init: PathGuardPolicyInit) {
    this.workspace = init.workspace;
    this.readRoots = [init.workspace, ...(init.readRoots ?? [])];
    this.writeRoots = [init.workspace, ...(init.writeRoots ?? [])];
    this.failClosedReason = init.failClosedReason ?? null;
  }

  /** Policy from the environment (`CELESTEA_TOOL_WORKDIR` + `CELESTEA_TOOL_ROOTS`). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, grants: PathGuardGrants = {}): PathGuardPolicy {
    const workspaceRaw = envString(env, ENV_TOOL_WORKDIR) ?? process.cwd();
    const workspace = resolveExistingTarget(workspaceRaw, process.cwd()) ?? resolve(workspaceRaw);
    const grantRead = [...(grants.readRoots ?? [])];
    const writeRoots = [...(grants.writeRoots ?? [])];
    const raw = envString(env, ENV_TOOL_ROOTS);
    if (raw === undefined) return new PathGuardPolicy({ workspace, readRoots: grantRead, writeRoots });
    const entries = parseToolRoots(raw);
    if (entries.length === 0) {
      return new PathGuardPolicy({
        workspace,
        readRoots: grantRead,
        writeRoots,
        failClosedReason: `${ENV_TOOL_ROOTS} is set but lists no directory`,
      });
    }
    const readRoots: string[] = [];
    let failClosedReason: string | null = null;
    for (const entry of entries) {
      const canonical = resolveExistingTarget(entry, workspace);
      if (canonical === null) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' does not exist`;
      else if (!isDirectory(canonical)) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' is not a directory`;
      else readRoots.push(canonical);
    }
    return new PathGuardPolicy({ workspace, readRoots: [...readRoots, ...grantRead], writeRoots, failClosedReason });
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

  /**
   * write: the canonical target must land inside ONE writable root. The
   * workspace is always one (§5.6: grants can only add roots); read roots are
   * still read-only and a write root overlapping a read root is rejected by the
   * host before it ever reaches this policy.
   */
  checkWrite(target: string): ToolDecision {
    const blocked = this.failClosed();
    if (blocked !== null) return blocked;
    const canonical = resolveWriteTarget(target, this.workspace);
    if (canonical === null) return ALLOW;
    if (this.writeRoots.some((root) => isInside(canonical, root))) return ALLOW;
    return deny("path_forbidden", this.writeDenyMessage(target));
  }

  /** Verbatim legacy message with no extra roots; explicit root list beyond it. */
  private writeDenyMessage(target: string): string {
    if (this.writeRoots.length <= 1) return `write path '${target}' is outside the workspace '${this.workspace}'`;
    return `write path '${target}' is outside every writable root (${this.writeRoots.join(", ")})`;
  }

  private failClosed(): ToolDecision | null {
    if (this.failClosedReason === null) return null;
    return deny(
      "tool_roots_invalid",
      `${this.failClosedReason} — failing closed: path tools are denied until ${ENV_TOOL_ROOTS} is fixed`,
    );
  }
}

/**
 * The guard: arbitrates every path-like argument of every tool. Only an explicit
 * `self` declaration (see [PATH_ACCESS]) hands a tool's paths back to its own
 * confinement layer; an unknown tool is checked as a write.
 */
export class PathGuard implements ToolGuard {
  private readonly policy: PathGuardPolicy;
  private readonly access: ReadonlyMap<string, PathAccess>;

  constructor(policy: PathGuardPolicy, access: ReadonlyMap<string, PathAccess> = PATH_ACCESS) {
    this.policy = policy;
    this.access = access;
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    grants: PathGuardGrants = {},
    access: ReadonlyMap<string, PathAccess> = PATH_ACCESS,
  ): PathGuard {
    return new PathGuard(PathGuardPolicy.fromEnv(env, grants), access);
  }

  async check(input: ToolInput): Promise<ToolDecision> {
    const targets = pathArguments(input.args);
    if (targets.length === 0) return ALLOW;
    const access = this.access.get(input.name) ?? "write";
    if (access === "self") return ALLOW;
    return this.checkAll(targets, access);
  }

  /** Every path-like argument must pass; the first denial wins. */
  private checkAll(targets: readonly string[], access: Exclude<PathAccess, "self">): ToolDecision {
    for (const target of targets) {
      const decision = access === "read" ? this.policy.checkRead(target) : this.policy.checkWrite(target);
      if (decision.kind !== "allow") return decision;
    }
    return ALLOW;
  }
}

/** Every path-like string argument of a call, in [PATH_ARG_KEYS] order. */
function pathArguments(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) found.push(...value.filter((entry): entry is string => typeof entry === "string"));
  }
  return found;
}

function deny(code: string, message: string): ToolDecision {
  return { kind: "deny", reason: contractError(GUARD_ERROR_PREFIX, code, message) };
}

/**
 * Mount the production guard chain. Returns whether it was mounted;
 * `CELESTEA_TOOL_GUARD=0` explicitly opts out (documented escape hatch — the
 * caller is responsible for surfacing that in its own diagnostics).
 */
export function mountProductionGuards(
  registry: ToolRegistry,
  env: NodeJS.ProcessEnv = process.env,
  grants: PathGuardGrants = {},
): boolean {
  if (!envFlag(envString(env, ENV_TOOL_GUARD), true)) return false;
  registry.addGuard(PathGuard.fromEnv(env, grants));
  return true;
}
