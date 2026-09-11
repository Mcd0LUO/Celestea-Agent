/**
 * Worker wiring — the part of composition that only `runtime` can do.
 *
 * Layer rules say an L1 package never imports another L1 package, so
 * `packages/workers` cannot reach the `Llm` / `ToolRegistry` / `AgentLoop`
 * implementations and cannot build a session log with a real projection. The
 * composition root can: it resolves the three driver seams from the Context and
 * hands them to the registry (`attach_drivers`, Rust W206/W232), injects the
 * worker session log factory, registers the HOST conversation so worker
 * receipts have an address, and returns the drain hook the turn runner uses.
 *
 * Nothing here is mandatory: with `workers: false` the generation runs without
 * orchestration and every hook degrades to a no-op.
 */

import { Context, type SessionLog } from "@celestea/core";
import { InMemorySessionLog } from "@celestea/session";
import {
  WorkerRegistry,
  WORKER_REGISTRY_SERVICE,
  workersPlugin,
  type SessionLogFactory,
  type WorkerDrivers,
  type WorkerSession,
} from "@celestea/workers";
import { mountPlugins } from "@celestea/core";
import type { PendingReceipt } from "./turn-runner.js";
import { HOST_SESSION_ID, RESULTS_DIR } from "./tokens.js";

const DEFAULT_WORKER_PLUGIN = "celestea.runtime.workers";

export interface WorkerWiring {
  /** `false` disables orchestration wiring entirely (default: enabled). */
  enabled?: boolean;
  /** Pre-built registry (the host owns it); otherwise one is created + mounted. */
  registry?: WorkerRegistry;
  /** `null` = in-memory table only; default = the shared `/tmp` registry.tsv. */
  tsvPath?: string | null;
  resultsDir?: string;
  sourceLabel?: string;
  /** Worker session log factory (default: `InMemorySessionLog`). */
  logFactory?: SessionLogFactory;
  /** Host conversation id (default `cli-main`; the host passes the session id). */
  hostSessionId?: string;
  /**
   * Prefix of the worker session ids this registry mints (`session-` by
   * default). Every session runtime owns its OWN registry since W513, so the
   * host passes a session-derived prefix: `worker:<sid>` ids stay unique in the
   * merged `GET /api/sessions` list.
   */
  sessionIdPrefix?: string;
  /** Model token recorded on the host session meta. */
  hostModel?: string | null;
  /**
   * W729 §2.3: the host session's mode, inherited by every spawn that does not
   * pass one. `null` = the host declared none (the spawn then records none).
   */
  hostMode?: string | null;
}

export interface WorkerHost {
  registry: WorkerRegistry;
  hostSessionId: string;
  /** Name of the plugin this wiring mounted (null when a host plugin provided it). */
  mountedPlugin: string | null;
  /** Poll the host mailbox: the messages to inject at the next boundary. */
  drain: () => PendingReceipt[];
  /** Messages waiting in the host mailbox (the loop's close guard reads it). */
  pending: () => number;
  /** Attach driver seams so a spawn is driven, not merely registered. */
  attach: (drivers: WorkerDrivers | null) => boolean;
}

/**
 * Resolve the registry: an already-mounted one wins (a host plugin provided it),
 * otherwise create and mount the default alone. Returns null when disabled.
 */
export function ensureWorkerWiring(ctx: Context, wiring: WorkerWiring | false | undefined): WorkerHost | null {
  if (wiring === false || wiring?.enabled === false) return null;
  const provided = ctx.get<WorkerRegistry>(WORKER_REGISTRY_SERVICE);
  const registry = provided ?? mountDefault(ctx, wiring ?? {});
  const hostSessionId = wiring?.hostSessionId ?? HOST_SESSION_ID;
  registerHost(registry, hostSessionId, wiring?.hostModel ?? null, wiring?.hostMode ?? null);
  return {
    registry,
    hostSessionId,
    mountedPlugin: provided === undefined ? DEFAULT_WORKER_PLUGIN : null,
    drain: () => drainHost(registry, hostSessionId),
    pending: () => registry.mailbox.pending(hostSessionId),
    attach: (drivers) => attachDrivers(registry, drivers),
  };
}

function mountDefault(ctx: Context, wiring: WorkerWiring): WorkerRegistry {
  const registry = new WorkerRegistry({
    tsvPath: wiring.tsvPath === undefined ? undefined : wiring.tsvPath,
    resultsDir: wiring.resultsDir ?? RESULTS_DIR,
    sourceLabel: wiring.sourceLabel ?? "celestea.runtime",
    logFactory: wiring.logFactory ?? ((): SessionLog => new InMemorySessionLog()),
    ...(wiring.sessionIdPrefix === undefined ? {} : { sessionIdPrefix: wiring.sessionIdPrefix }),
    hostMode: wiring.hostMode ?? null,
  });
  mountPlugins(ctx, [workersPlugin({ registry, name: DEFAULT_WORKER_PLUGIN })]);
  return registry;
}

/** Register the host conversation so receipts can be addressed to it (W232). */
function registerHost(registry: WorkerRegistry, hostSessionId: string, model: string | null, mode: string | null): void {
  const host: WorkerSession = {
    meta: { id: hostSessionId, title: hostSessionId, workspace: null, model, mode },
    log: new InMemorySessionLog(),
  };
  registry.registerHostSession(host);
  // The spawn default: a worker inherits the mode of its owning session (W729).
  registry.setHostMode(mode);
}

/**
 * FIFO drain of the host queue, annotated with the sender label, the envelope
 * (`source`) and an IDEMPOTENCY key (W515 §3/§4): a receipt replayed by a
 * restarted driver carries the same id and is injected once.
 */
function drainHost(registry: WorkerRegistry, hostSessionId: string): PendingReceipt[] {
  return registry.mailbox.poll(hostSessionId).map((m) => ({
    text: m.content,
    from: m.from_label,
    id: `mailbox:${m.id}`,
    kind: m.kind,
    source: m.source ?? { kind: "worker-relay", form: "message", senderSessionId: m.from_label },
  }));
}

function attachDrivers(registry: WorkerRegistry, drivers: WorkerDrivers | null): boolean {
  if (drivers === null) return false;
  registry.attachDrivers(drivers);
  return true;
}
