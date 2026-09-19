/**
 * W888 — the transcript projection of a `user_message` origin.
 *
 * A non-user origin becomes an INBOX row (role "inbox", kind = origin, source =
 * human label); 'user'/absent keeps the EXACT pre-W888 object (the zero-regression
 * gate).
 */
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { originLabel, projectMessages, sessionEventToMessage } from "./messages.js";

const ORIGINS = ["skill", "memory", "receipt", "steering", "compact"] as const;

describe("W888 origin projection", () => {
  it("keeps a user row byte-identical (no origin / origin:user)", () => {
    const plain = sessionEventToMessage({ type: "user_message", text: "hi" });
    expect(plain).toEqual({ role: "user", content: "hi" });
    const explicitUser = sessionEventToMessage({ type: "user_message", text: "hi", origin: "user" });
    expect(explicitUser).toEqual({ role: "user", content: "hi" });
    // The JSON is the real zero-regression gate: the key must not appear.
    expect(JSON.stringify(plain)).toBe('{"role":"user","content":"hi"}');
  });

  it("maps each non-user origin to an inbox row with its label", () => {
    for (const origin of ORIGINS) {
      const out = sessionEventToMessage({ type: "user_message", text: "body", origin });
      expect(out).toEqual({ role: "inbox", kind: origin, content: "body", source: originLabel(origin) });
      expect(out?.role).not.toBe("user");
    }
  });

  it("labels are stable and non-empty", () => {
    for (const origin of ORIGINS) {
      const label = originLabel(origin);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
    expect(originLabel("memory")).toContain("记忆");
    expect(originLabel("skill")).toContain("技能");
  });

  it("carries attachments on both projections without changing the role", () => {
    const ref = { attachment_id: "a".repeat(64), media_type: "image/png", width: 1, height: 1 } as const;
    const user = sessionEventToMessage({ type: "user_message", text: "hi", attachments: [ref] });
    expect(user).toEqual({ role: "user", content: "hi", attachments: [ref] });
    const mem = sessionEventToMessage({ type: "user_message", text: "hi", origin: "memory", attachments: [ref] });
    expect(mem).toMatchObject({ role: "inbox", kind: "memory", attachments: [ref] });
  });

  it("a whole log projects the injected rows distinctly from the input", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "turn-0" },
      { type: "user_message", text: "skill catalog", origin: "skill" },
      { type: "user_message", text: "memory block", origin: "memory" },
      { type: "user_message", text: "[from W1] done", origin: "receipt" },
      { type: "user_message", text: "the real question" },
      { type: "assistant_message", text: "answer" },
      { type: "turn_end", id: "turn-0", outcome: "completed" },
    ];
    const projected = projectMessages(events);
    expect(projected.map((m) => m.role)).toEqual(["inbox", "inbox", "inbox", "user", "assistant"]);
    expect(projected.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
