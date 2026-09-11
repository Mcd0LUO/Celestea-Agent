/**
 * Normalize a drained injection into the inbox shape the SSE publisher expects.
 *
 * The inbox's own message type is richer than the wire payload (`at`, defaulted
 * `lane`/`kind`/`source`), and the host needs the WIRE shape to publish a
 * `placement: "context"` frame (W515 §2). Keeping the mapping here — instead of
 * inline in the adapter — keeps the adapter about the HTTP contract.
 */

import type { PendingInjection } from "@celestea/core";
import type { InjectedMessage } from "@celestea/runtime";

export function inboxMessageOf(message: PendingInjection): InjectedMessage {
  return {
    text: message.text,
    from: message.from,
    at: 0,
    lane: message.lane ?? "next-turn",
    kind: message.kind ?? "user",
    id: message.id ?? "",
    source: message.source ?? { kind: "user", form: "message" },
    duplicate: false,
  };
}
