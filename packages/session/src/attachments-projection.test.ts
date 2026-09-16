/**
 * W804 (stage 2): the Studio projection carries attachment references for
 * GET /api/sessions/{id}/messages, without changing a no-attachment message.
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { projectMessages, sessionEventToMessage } from "./messages.js";

const REF = {
  attachment_id: "cd".repeat(32),
  media_type: "image/jpeg" as const,
  width: 64,
  height: 32,
};

describe("Studio projection attachments", () => {
  it("attaches references to the user row", () => {
    const ev: SessionEvent = { type: "user_message", text: "see", attachments: [REF] };
    expect(sessionEventToMessage(ev)).toEqual({ role: "user", content: "see", attachments: [REF] });
  });

  it("omits the key entirely when there are no attachments (byte-identical)", () => {
    const ev: SessionEvent = { type: "user_message", text: "hi" };
    const msg = sessionEventToMessage(ev);
    expect(msg).toEqual({ role: "user", content: "hi" });
    expect(Object.keys(msg as object)).toEqual(["role", "content"]);
  });

  it("keeps the full message list shape", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "t1" },
      { type: "user_message", text: "see", attachments: [REF] },
      { type: "assistant_message", text: "ok" },
    ];
    expect(projectMessages(events)).toEqual([
      { role: "user", content: "see", attachments: [REF] },
      { role: "assistant", content: "ok" },
    ]);
  });
});
