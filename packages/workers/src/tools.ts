/**
 * The three worker-orchestration tools (Rust W185, `crates/workers/src/tools.rs`):
 * `spawn_worker` / `session_send_message` / `worker_status`.
 *
 * Contract discipline:
 *   - **specs come from `contracts/tools.json`** (via core's `loadTools`), not
 *     from a second hand-written copy, so `GET /api/tools` and the model prompt
 *     can never drift from the frozen contract; a missing entry fails loudly;
 *   - **failures are results, not exceptions** (ARCHITECTURE.md §6.2): the shape
 *     is the AI-facing envelope `{ok:false, step, error}` (plus `candidates` for
 *     an ambiguous target), so the model can correct itself instead of the turn
 *     dying;
 *   - **no strong cycle**: each tool holds a [WeakRef] to the registry and
 *     re-checks it per call, so a released (hot-swapped-out) generation fails
 *     closed instead of resurrecting its own state.
 */

import { isRecord, loadTools, type Tool, type ToolSpec } from "@celestea/core";
import type { WorkerRegistry } from "./registry.js";
import { getExtra } from "./registry-tsv.js";
import type { ResolveError } from "./sessions.js";
import { sanitizeExtra, truncateChars, utcNow } from "./types.js";

/** `{ok:false, step, error}` — the tool-facing failure envelope. */
export function contractError(step: string, error: string): Record<string, unknown> {
  return { ok: false, step, error };
}

/** The three tool names, in contract order. */
export const WORKER_TOOL_NAMES = ["spawn_worker", "session_send_message", "worker_status"] as const;

/** Spec straight out of the frozen contract (throws when the contract lost it). */
export function workerToolSpec(name: string): ToolSpec {
  const found = loadTools().tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`contracts/tools.json has no tool '${name}'`);
  return { name: found.name, description: found.description, parameters: found.parameters };
}

/** The three tools bound to one registry (WeakRef: no strong cycle). */
export function workerTools(registry: WorkerRegistry): Tool[] {
  const ref = new WeakRef(registry);
  return [
    registryTool(workerToolSpec("spawn_worker"), ref, spawnWorker),
    registryTool(workerToolSpec("session_send_message"), ref, sendMessage),
    registryTool(workerToolSpec("worker_status"), ref, workerStatus),
  ];
}

type Exec = (registry: WorkerRegistry, args: Record<string, unknown>) => Promise<unknown>;

function registryTool(spec: ToolSpec, ref: WeakRef<WorkerRegistry>, exec: Exec): Tool {
  return {
    spec: () => spec,
    execute(args: unknown): Promise<unknown> {
      const registry = ref.deref();
      if (registry === undefined || registry.isReleased) {
        return Promise.resolve(contractError("registry", "registry released"));
      }
      return exec(registry, isRecord(args) ? args : {});
    },
  };
}

// --- spawn_worker ---------------------------------------------------------

async function spawnWorker(registry: WorkerRegistry, args: Record<string, unknown>): Promise<unknown> {
  const wid = stringArg(args, "wid");
  const brief = stringArg(args, "brief");
  if (wid === "") return contractError("validate", "wid required");
  if (brief === "") return contractError("validate", "brief required");
  if (/[\t\n]/.test(wid)) return contractError("validate", "wid must not contain tab/newline");
  if (registry.getEntry(wid) !== undefined) return contractError("validate", `wid ${wid} already registered`);

  const short = optionalArg(args, "title") ?? deriveShort(brief, wid);
  const fullTitle = `${wid}·${truncateChars(short, 20)}`;
  const reportTo = optionalArg(args, "report_to");
  const driven = registry.canDrive();
  const session = registry.sessions.create({
    title: fullTitle,
    workspace: optionalArg(args, "workspace"),
    model: optionalArg(args, "model"),
  });
  const injected = reportTo === null ? brief : `${brief}\n\n${completionFeedback()}`;
  registry.rememberSpawn(session.meta.id, { wid, short, brief, reportTo });
  const warn = registry.upsert({
    wid,
    started_at: utcNow(),
    status: "RUNNING",
    extra: extraTokens(args, { sid: session.meta.id, short, driven, reportTo, injected }),
  });
  const actuallyDriven = driven ? registry.driveIfPossible(session.meta.id, injected) : false;
  const result: Record<string, unknown> = {
    ok: true,
    sessionId: session.meta.id,
    title: fullTitle,
    wid,
    driven: actuallyDriven,
  };
  if (warn !== null) result["registry"] = `warn: ${warn}`;
  return result;
}

/** W235 B: a neutral hint, so the brief never has to instruct tool usage. */
function completionFeedback(): string {
  return "【回执】完成后引擎会自动生成报告并发送回执，你只需专注完成任务本身。";
}

interface SpawnTokens {
  sid: string;
  short: string;
  driven: boolean;
  reportTo: string | null;
  injected: string;
}

function extraTokens(args: Record<string, unknown>, t: SpawnTokens): string {
  const tokens: Array<[string, string]> = [
    ["sess", t.sid],
    // The title token stays ONE token (whitespace folded to `-`): `extra` is a
    // space-separated token list, and the receipt protocol reads this token back
    // to name the report file (`results/<wid>-<short>.md`).
    ["title", tokenSafe(t.short)],
    ["driven", t.driven ? "yes" : "no"],
  ];
  for (const key of ["workspace", "provider", "model", "reasoning_effort"] as const) {
    const value = optionalArg(args, key);
    if (value !== null) tokens.push([key === "reasoning_effort" ? "effort" : key, value]);
  }
  if (t.reportTo !== null) tokens.push(["report_to", t.reportTo]);
  tokens.push(["brief", truncateChars(sanitizeExtra(t.injected), 300)]);
  return tokens.map(([k, v]) => `${k}=${sanitizeExtra(v)}`).join(" ");
}

/** Fold whitespace so a value stays a single `extra` token. */
export function tokenSafe(v: string): string {
  return v.replace(/\s+/g, "-");
}

/** Short title default: first non-empty brief line, `#` stripped, 20 chars. */
export function deriveShort(brief: string, wid: string): string {
  const first = brief.split("\n").find((line) => line.trim() !== "") ?? wid;
  const cleaned = truncateChars(first.trim().replace(/^#+/, "").trim(), 20);
  return cleaned === "" ? wid : cleaned;
}

// --- session_send_message -------------------------------------------------

async function sendMessage(registry: WorkerRegistry, args: Record<string, unknown>): Promise<unknown> {
  const target = stringArg(args, "target");
  const content = stringArg(args, "content");
  if (target === "") return contractError("validate", "target required");
  if (content === "") return contractError("validate", "content required");
  const resolved = registry.sessions.resolve(target);
  if (resolved.error !== undefined) return resolveFailure(resolved.error);
  const session = resolved.session;
  if (session === undefined) return contractError("resolve", `no session matches target: ${target}`);
  const from = registry.sourceLabel;
  // A deliberate relay message — never a settlement notice (W515 §4).
  const sent = registry.mailbox.send(session.meta.id, content, from, {
    kind: "relay",
    source: { kind: "worker-relay", form: "message", senderSessionId: from },
  });
  return {
    ok: true,
    delivered: true,
    queued: true,
    target: session.meta.id,
    sourceSession: from,
    message_id: sent.id,
  };
}

function resolveFailure(error: ResolveError): unknown {
  if (error.kind === "not_found") return contractError("resolve", `no session matches target: ${error.target}`);
  return {
    ok: false,
    step: "resolve",
    target: error.target,
    candidates: error.candidates.map((m) => ({ id: m.id, title: m.title, workspace: m.workspace, model: m.model })),
  };
}

// --- worker_status --------------------------------------------------------

async function workerStatus(registry: WorkerRegistry, args: Record<string, unknown>): Promise<unknown> {
  return registry.status(optionalArg(args, "wid"));
}

// --- arg helpers ----------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function optionalArg(args: Record<string, unknown>, key: string): string | null {
  const value = stringArg(args, key);
  return value === "" ? null : value;
}

/** Re-exported for the receipt protocol's readers. */
export { getExtra };
