/**
 * `POST /api/exec` (iteration G2) — run a shell command NOW, with no model in
 * the loop. `/run <cmd>` and `!<cmd>` are the UI's callers.
 *
 * Three rules from `docs/iteration-g-workbench.md` §1:
 *   1. it reuses the run_shell execution path — the SAME `selectSandboxDetailed`
 *      policy, `sessionSandboxConfig` (workdir/root), `sanitizedEnv` allowlist
 *      and output cap the engine's `run_shell` uses, so isolation cannot fork;
 *   2. it passes the PERMISSION gate: a preset that denies `run_shell`, or a
 *      sandbox policy that refuses to execute, is a structured refusal — never a
 *      silent run;
 *   3. it is NOT a tool: nothing here touches the model-visible tool face.
 *
 * The `sandbox` block carries ONLY the contract fields (provider / net_isolated
 * / tmp_private / seccomp + optional cpu_sec), never host diagnostics.
 */

import type { Sandbox } from "@celestea/core";
import type { Hono } from "hono";
import { selectSandboxDetailed, sessionSandboxConfig } from "@celestea/tools";
import type { RouteTable } from "../routes.js";
import { effectiveGrantsOf } from "../runtime/engine-grants.js";
import { nowSec } from "../store/grants-service.js";
import { sessionWorkspaceOf, type ResolvedSession } from "../store/sessions.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, type Deps } from "./common.js";

/** The structured refusal when this session's preset denies the shell. */
export const SHELL_DENIED_CODE = "shell_denied";

interface ExecBody {
  command: string;
  session?: string;
  workdir?: string;
  timeout_ms?: number;
}

function readCommand(body: Record<string, unknown>): string | { error: string } {
  const value = body["command"];
  if (typeof value !== "string") return { error: "field 'command' must be a string" };
  if (value.trim() === "") return { error: "field 'command' must not be empty" };
  return value;
}

/** Resolve the target session (explicit id, else the detached/default scope). */
function targetSession(deps: Deps, id: string | undefined): { resolved: ResolvedSession | null; status: number; error: string } {
  if (id === undefined || id === "") return { resolved: null, status: 0, error: "" };
  const resolved = deps.sessions.require(id);
  if (resolved.ok) return { resolved: resolved.value, status: 0, error: "" };
  return { resolved: null, status: resolved.status, error: resolved.error };
}

/**
 * The session's shell is denied when the permission baseline's `toolDeny`
 * contains `run_shell`. Read through the SAME grant reader the tool face uses,
 * so the UI cannot disagree with what a turn would allow.
 */
function shellDeniedReason(deps: Deps, resolved: ResolvedSession | null): string | null {
  const dir = resolved?.dir ?? null;
  const sessionId = resolved?.id ?? null;
  const grants = effectiveGrantsOf(dir, sessionId, deps.grants.env, nowSec(deps.grants));
  if (grants.grants.toolDeny.includes("run_shell")) {
    return "this session's permission preset denies run_shell; grant a preset that allows the shell (or widen it) and retry";
  }
  return null;
}

/**
 * The execution boundary of the target session, exactly as the engine composes
 * it: provider policy + session scope + grants. Denied -> `{sandbox}` is a
 * RefusingSandbox whose `run` throws the structured policy error.
 */
function sandboxFor(deps: Deps, resolved: ResolvedSession | null): Sandbox {
  const env = deps.grants.env;
  const sessionId = resolved?.id ?? null;
  const dir = resolved?.dir ?? null;
  const grants = effectiveGrantsOf(dir, sessionId, env, nowSec(deps.grants)).grants;
  const scope = resolved === null ? null : (sessionWorkspaceOf(resolved) === null ? null : { workspace: resolved.wsPath });
  const config = sessionSandboxConfig(scope, env);
  const selection = selectSandboxDetailed({
    env,
    grants: { network: grants.network, unsandboxed: grants.unsandboxed, workspaceWritable: grants.workspaceWritable, writeRoots: grants.writeRoots },
    config,
  });
  return selection.sandbox;
}

/** Only the contract's four fields + optional cpu_sec (never host diagnostics). */
function sandboxView(result: { sandbox: { provider: string; net_isolated: boolean; tmp_private: boolean; seccomp: boolean; cpu_sec?: number } }): Record<string, unknown> {
  const meta = result.sandbox;
  return {
    provider: meta.provider,
    net_isolated: meta.net_isolated,
    tmp_private: meta.tmp_private,
    seccomp: meta.seccomp,
    ...(meta.cpu_sec === undefined ? {} : { cpu_sec: meta.cpu_sec }),
  };
}

export function registerExec(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("post_exec");
  app.on(route.method, route.honoPath, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const sessionField = strField(c, body.body, "session");
    if (!sessionField.ok) return sessionField.response;
    const workdirField = strField(c, body.body, "workdir");
    if (!workdirField.ok) return workdirField.response;

    const command = readCommand(body.body);
    if (typeof command !== "string") return failJson(c, 422, command.error);

    const target = targetSession(deps, sessionField.value);
    if (target.status !== 0) return failJson(c, target.status, target.error);

    const denied = shellDeniedReason(deps, target.resolved);
    if (denied !== null) return failJson(c, 403, denied, { code: SHELL_DENIED_CODE });

    const sandbox = sandboxFor(deps, target.resolved);
    const started = Date.now();
    try {
      const run = await sandbox.run({
        command,
        ...(workdirField.value === undefined ? {} : { workdir: workdirField.value }),
        ...(typeof body.body["timeout_ms"] === "number" ? { timeoutMs: body.body["timeout_ms"] as number } : {}),
      });
      return c.json({
        ok: true,
        exit_code: run.exit_code,
        signal: run.signal ?? null,
        stdout: run.stdout,
        stderr: run.stderr,
        duration_ms: Date.now() - started,
        sandbox: sandboxView(run),
      });
    } catch (e) {
      // A sandbox/policy failure is a structured refusal, never a 500 guess.
      return failJson(c, 400, errText(e));
    }
  });
  return [route.id];
}
