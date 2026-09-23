/**
 * The SSE publishers the host raises on behalf of ONE session (W515 §2/§4).
 *
 * Two concerns that look alike and are kept together for that reason:
 *   - an injected message's placement change (`status` frames: `queued` /
 *     `steering` on acceptance, `context` when a boundary consumes it);
 *   - a parked user question (`question`, W783).
 *
 * Both are "the adapter knows the session id and the bus; nobody else does", so
 * both are built from the same two callbacks and neither needs the engine.
 *
 * NOTE (pure move, W783): the injection publisher below is W515 behaviour that
 * used to live inline in `real-runtime-adapter.ts`. Nothing about what it emits
 * changed — only where it is written down.
 */

import { createSessionInbox, subCallFrame, type InjectedMessage, type SessionInbox } from "@celestea/runtime";
import type { InjectionPlacement, PendingInjection, SessionEvent } from "@celestea/core";
import { inboxMessageOf } from "./inbox-message.js";
import type { StudioBus } from "../sse.js";

/**
 * The session hooks the composer consumes (inbox + observed boundaries).
 * Structurally identical to `session-compose.ts`'s own `SessionInjectionHooks`;
 * the `onInjected` parameter is the composer's tamer `PendingInjection` view,
 * because the composer reports a drained message before it is materialized.
 */
export interface SessionInjectionHooks {
  inbox: SessionInbox;
  onInjected: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void;
}

/** Reach the bus and the clock without owning either. */
export interface PublisherDeps {
  /** Emit one status frame for this session. */
  emitStatus: (sessionId: string | null, payload: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * The injection hooks of one session: the ACCEPT side is observed when the inbox
 * queues a message, and the CONSUME side only through `onInjected`, which knows
 * WHICH boundary drained it (a mailbox receipt never enters the inbox, so it
 * cannot be reported here).
 */
export function injectionHooksOf(sessionId: string | null, deps: PublisherDeps): SessionInjectionHooks {
  const publish = (placement: InjectionPlacement, message: InjectedMessage, boundary?: "turn-start" | "step"): void => {
    deps.emitStatus(sessionId, {
      phase: "progress",
      placement,
      ...(boundary === undefined ? {} : { boundary }),
      message: {
        id: message.id,
        kind: message.kind,
        from: message.from,
        lane: message.lane,
        source: message.source,
        summary: message.source.summary ?? message.text.slice(0, 120),
      },
      statusline: {},
    });
  };
  return {
    inbox: createSessionInbox(deps.now, { onQueued: (message, placement) => publish(placement, message) }),
    onInjected: (messages, boundary) => {
      for (const message of messages) publish("context", inboxMessageOf(message as InjectedMessage), boundary);
    },
  };
}

/**
 * W1467: one `run_code` SUB-CALL row as an SSE frame on its session.
 *
 * A sub-call never becomes a `LoopEvent` (the program's `tools.read_file(...)`
 * bridge is dispatched by the broker, not by the agent loop), so this frame is
 * host-emitted exactly like the `question` frame above — which is why it lives
 * here rather than in the adapter. The payload is built by the runtime's own
 * `subCallFrame`, the module that owns every frozen payload, so the live frame
 * and the replayed one come from ONE builder and cannot drift.
 *
 * A row that is not a sub-call publishes nothing: the enclosing `run_code` call
 * already has its own frame from the agent loop, and publishing it twice would
 * render two identical cards.
 */
export function publishSubCall(
  sessionId: string | null,
  event: SessionEvent,
  bus: StudioBus | null | undefined,
  turnOf: (sessionId: string | null) => number,
): void {
  const frame = subCallFrame(event);
  if (frame === null) return;
  bus?.emit(frame.event, turnOf(sessionId), frame.payload, sessionId);
}
