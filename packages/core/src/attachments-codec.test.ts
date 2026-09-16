/**
 * W804 (multimodal P0, stage 2): attachment references through the session log.
 *
 * Pins three contracts the design calls out as high risk:
 *   - R1 the hand-written serializer has an EXPLICIT attachments branch
 *     (read -> write -> read must be byte-identical, not just deep-equal);
 *   - backward compatibility: a legacy row without attachments is byte-identical
 *     and still parses;
 *   - the red line: the log NEVER stores base64 (no data: URL) — only references.
 */

import { describe, expect, it } from "vitest";
import { isImageRef, messageImages, userMessage, type ImageRef } from "./message.js";
import { deriveMessagesFrom } from "./projection.js";
import { parseSessionEvent, serializeSessionEvent } from "./session-event.js";
import type { SessionEvent } from "./types.js";

const ID = "ab".repeat(32);
const REF: ImageRef = {
  attachment_id: ID,
  media_type: "image/png",
  width: 1024,
  height: 768,
  name: "shot.png",
};
const ROW =
  '{"type":"user_message","text":"look","attachments":[{"attachment_id":"' +
  ID +
  '","media_type":"image/png","width":1024,"height":768,"name":"shot.png"}]}';

describe("user_message.attachments codec (stage 2, R1)", () => {
  it("serializes the reference with serde field order and omits absent optionals", () => {
    expect(serializeSessionEvent({ type: "user_message", text: "look", attachments: [REF] })).toBe(ROW);
    expect(serializeSessionEvent({ type: "user_message", text: "x", attachments: [{ ...REF, name: undefined }] })).toBe(
      '{"type":"user_message","text":"x","attachments":[{"attachment_id":"' +
        ID +
        '","media_type":"image/png","width":1024,"height":768}]}',
    );
  });

  it("read -> write -> read is byte-identical (the /compact rewrite path)", () => {
    const once = parseSessionEvent(ROW);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const rewritten = serializeSessionEvent(once.event);
    expect(rewritten).toBe(ROW);
    const twice = parseSessionEvent(rewritten);
    expect(twice.ok && twice.event).toEqual(once.event);
  });

  it("keeps a legacy row byte-identical and normalizes it with no attachments key", () => {
    expect(serializeSessionEvent({ type: "user_message", text: "hi" })).toBe('{"type":"user_message","text":"hi"}');
    const r = parseSessionEvent('{"type":"user_message","text":"hi"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toEqual({ type: "user_message", text: "hi" });
  });

  it("drops unknown fields (explicit user_message branch, field whitelist)", () => {
    const r = parseSessionEvent('{"type":"user_message","text":"hi","future_field":1,"attachments":null}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toEqual({ type: "user_message", text: "hi" });
  });

  it("drops unknown fields INSIDE an attachment reference", () => {
    const line =
      '{"type":"user_message","text":"x","attachments":[{"attachment_id":"' +
      ID +
      '","media_type":"image/png","width":1,"height":2,"extra":true}]}';
    const r = parseSessionEvent(line);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toEqual({ type: "user_message", text: "x", attachments: [{ attachment_id: ID, media_type: "image/png", width: 1, height: 2 }] });
    expect(serializeSessionEvent(r.event)).toBe(
      '{"type":"user_message","text":"x","attachments":[{"attachment_id":"' + ID + '","media_type":"image/png","width":1,"height":2}]}',
    );
  });

  it("rejects a malformed attachments field (torn tail, never a silent image)", () => {
    for (const line of [
      '{"type":"user_message","text":"x","attachments":"nope"}',
      '{"type":"user_message","text":"x","attachments":[{"attachment_id":"' + ID + '","media_type":"image/png","width":1}]}',
      '{"type":"user_message","text":"x","attachments":[{"attachment_id":"' + ID + '","media_type":"image/svg+xml","width":1,"height":2}]}',
    ]) {
      expect(parseSessionEvent(line).ok, line).toBe(false);
    }
  });

  it("NEVER stores base64 / data URLs in the log (red line)", () => {
    const line = serializeSessionEvent({ type: "user_message", text: "look", attachments: [REF] });
    expect(line).not.toContain("data:");
    expect(line).not.toContain("base64");
    expect(line).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
    expect(line.length).toBeLessThan(500);
  });
});

describe("deriveMessagesFrom carries attachments (stage 2, section 4.2A/6.4)", () => {
  const base: SessionEvent[] = [
    { type: "turn_start", id: "t1" },
    { type: "user_message", text: "look", attachments: [REF] },
  ];

  it("projects a user attachment into an image content block", () => {
    const msgs = deriveMessagesFrom(base);
    const user = msgs[msgs.length - 1];
    expect(user?.role).toBe("user");
    expect(user?.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(messageImages(user!)).toEqual([REF]);
  });

  it("stays byte-identical to the pre-W804 projection when there is no attachment", () => {
    const withAtt = deriveMessagesFrom(base)[0];
    const without = deriveMessagesFrom([{ type: "user_message", text: "look" }])[0];
    expect(without).toEqual(userMessage("look"));
    expect(JSON.stringify(without)).toBe(JSON.stringify(userMessage("look")));
    expect(withAtt).not.toEqual(without);
  });

  it("projects tool_result value.attachments onto the same tool message", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "t1" },
      { type: "tool_call", id: "c1", name: "read_image", args: { path: "a.png" } },
      { type: "tool_result", id: "c1", value: { ok: true, attachments: [REF] }, error: null },
    ];
    const msgs = deriveMessagesFrom(events);
    const tool = msgs.find((m) => m.role === "tool");
    expect(tool?.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(messageImages(tool!)).toEqual([REF]);
    // The JSON metadata stays in the text block (path/dimensions are visible).
    expect(tool?.content[0]).toMatchObject({ type: "text" });
  });

  it("ignores a malformed tool value attachments field (no bogus image)", () => {
    const events: SessionEvent[] = [
      { type: "tool_call", id: "c1", name: "x", args: {} },
      { type: "tool_result", id: "c1", value: { ok: true, attachments: [{ attachment_id: 5 }] }, error: null },
    ];
    const tool = deriveMessagesFrom(events).find((m) => m.role === "tool");
    expect(tool?.content.map((c) => c.type)).toEqual(["text"]);
  });
});

/**
 * W834 F07 (R3 batch A): the codec must enforce the FROZEN AttachmentRef schema
 * (contracts/session-event.schema.json:22-61) — 64 lowercase hex chars and
 * integer dimensions >= 1 — not merely "string + finite number". The probe is
 * the codec entry point itself plus the row-level parser that consumes it.
 */
describe("AttachmentRef codec matches the frozen schema (W834 F07)", () => {
  const HEX = "ab".repeat(32);
  const base = { media_type: "image/png", width: 1, height: 1 };

  it("accepts only 64-lowercase-hex ids and positive integer dimensions", () => {
    const cases: Array<{ what: string; ref: Record<string, unknown>; ok: boolean }> = [
      { what: "valid 64-hex id", ref: { ...base, attachment_id: HEX }, ok: true },
      { what: "non-hex id", ref: { ...base, attachment_id: "nothex" }, ok: false },
      { what: "uppercase hex id", ref: { ...base, attachment_id: "AB".repeat(32) }, ok: false },
      { what: "short id", ref: { ...base, attachment_id: "ab".repeat(31) }, ok: false },
      { what: "zero width", ref: { ...base, attachment_id: HEX, width: 0 }, ok: false },
      { what: "negative width", ref: { ...base, attachment_id: HEX, width: -5 }, ok: false },
      { what: "fractional width", ref: { ...base, attachment_id: HEX, width: 1.5 }, ok: false },
      { what: "zero height", ref: { ...base, attachment_id: HEX, height: 0 }, ok: false },
      { what: "negative height", ref: { ...base, attachment_id: HEX, height: -1 }, ok: false },
      { what: "fractional height", ref: { ...base, attachment_id: HEX, height: 2.5 }, ok: false },
    ];
    for (const c of cases) expect(isImageRef(c.ref), c.what + ": " + JSON.stringify(c.ref)).toBe(c.ok);
  });

  it("parseSessionEvent REJECTS a row whose attachment breaks the frozen schema", () => {
    const malformed = [
      { attachment_id: "nothex", media_type: "image/png", width: 1, height: 1 },
      { attachment_id: HEX, media_type: "image/png", width: 0, height: 1 },
      { attachment_id: HEX, media_type: "image/png", width: 1, height: 1.5 },
    ];
    for (const ref of malformed) {
      const line = JSON.stringify({ type: "user_message", text: "x", attachments: [ref] });
      expect(parseSessionEvent(line).ok, line).toBe(false);
    }
    // ...and a well-formed reference is still accepted (the fix tightens, never widens).
    const ok = JSON.stringify({ type: "user_message", text: "x", attachments: [{ attachment_id: HEX, media_type: "image/png", width: 2, height: 3 }] });
    expect(parseSessionEvent(ok).ok).toBe(true);
  });
});
