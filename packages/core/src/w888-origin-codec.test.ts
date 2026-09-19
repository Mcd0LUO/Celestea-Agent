/**
 * W888 — the optional `origin` on a `user_message` row and the transcript block
 * it drives. The codec half lives with the codec; the projection half (6 origins
 * + the byte-identical user regression) is in packages/session.
 *
 * Policy decision (documented here): an UNKNOWN origin is a HARD ERROR, not a
 * silent fallback to 'user'. The projection branches on it, so a typo must not
 * smuggle an injected row through as if the human had typed it.
 */
import { describe, expect, it } from "vitest";
import { parseSessionEvent, serializeSessionEvent, validateSessionEvent } from "./session-event.js";
import type { SessionEvent } from "./types.js";

describe("W888 user_message.origin codec", () => {
  it("omits origin for a plain user row (pre-W888 bytes are unchanged)", () => {
    expect(serializeSessionEvent({ type: "user_message", text: "hi" })).toBe('{"type":"user_message","text":"hi"}');
    // Explicit 'user' is also omitted: it is the default.
    expect(serializeSessionEvent({ type: "user_message", text: "hi", origin: "user" })).toBe('{"type":"user_message","text":"hi"}');
  });

  it("writes a non-user origin after text (declaration order)", () => {
    expect(serializeSessionEvent({ type: "user_message", text: "x", origin: "memory" })).toBe('{"type":"user_message","text":"x","origin":"memory"}');
  });

  it("round-trips every legal origin", () => {
    for (const origin of ["skill", "memory", "receipt", "steering", "compact"] as const) {
      const ev: SessionEvent = { type: "user_message", text: "t", origin };
      const back = parseSessionEvent(serializeSessionEvent(ev));
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.event).toEqual(ev);
    }
  });

  it("normalises an absent/null/'user' origin to absent (serde Option)", () => {
    const bare = validateSessionEvent({ type: "user_message", text: "t" });
    expect(bare.ok && "origin" in bare.event).toBe(false);
    const nul = validateSessionEvent({ type: "user_message", text: "t", origin: null });
    expect(nul.ok && "origin" in nul.event).toBe(false);
    const user = validateSessionEvent({ type: "user_message", text: "t", origin: "user" });
    expect(user.ok && "origin" in user.event).toBe(false);
  });

  it("REJECTS an unknown origin (never a silent fallback to user)", () => {
    const bad = validateSessionEvent({ type: "user_message", text: "t", origin: "bogus" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toContain("origin");
    const numeric = validateSessionEvent({ type: "user_message", text: "t", origin: 7 });
    expect(numeric.ok).toBe(false);
  });

  it("keeps an old hand-written row readable (no origin field)", () => {
    const back = parseSessionEvent('{"type":"user_message","text":"legacy"}');
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.event).toEqual({ type: "user_message", text: "legacy" });
  });
});
