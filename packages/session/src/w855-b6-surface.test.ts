/**
 * W855 (B6): the session log stores the ORIGINAL tool value; the model-visible
 * face (bounded preview + locator, or a truncation note) is produced by the
 * projection at read time, so live and replay agree byte for byte.
 */
import { describe, expect, it } from "vitest";
import {
  retainHeadTail,
  serializeSessionEvent,
  toolResultText,
  type SessionEvent,
  type ToolResultSurface,
} from "@celestea/core";
import { parseSessionJsonl, serializeSessionJsonl } from "./jsonl.js";
import { deriveMessages, projectMessages } from "./index.js";
import { deriveSseTranscript } from "./replay.js";

const ORIGINAL = "ORIGINAL-LINE\n".repeat(200); // 2800 bytes
const WINDOW = retainHeadTail(ORIGINAL, 64, 32);
const SURFACE: ToolResultSurface = {
  kind: "omitted",
  omitted_bytes: WINDOW.omittedBytes,
  total_bytes: WINDOW.totalBytes,
  locator: "/tmp/spills/c1-1.txt",
  retrieval_hint: 'read_file path="/tmp/spills/c1-1.txt"',
  head_bytes: 64,
  tail_bytes: 32,
};

const EVENTS: SessionEvent[] = [
  { type: "user_message", text: "run it" },
  { type: "tool_call", id: "c1", name: "run_shell", args: { command: "cat big" } },
  { type: "tool_result", id: "c1", value: ORIGINAL, error: null, surface: SURFACE },
  { type: "turn_end", id: "t1", outcome: "completed" },
];

/** The text blocks of one projected message, joined. */
function textOf(message: { content: ReadonlyArray<{ type: string; content?: unknown }> }): string {
  return message.content.map((c) => (c.type === "text" && typeof c.content === "string" ? c.content : "")).join("");
}

describe("W855 B6 tool-result surfaces", () => {
  it("serializes the ORIGINAL value plus the surface, and round-trips byte for byte", () => {
    const row: SessionEvent = { type: "tool_result", id: "c1", value: ORIGINAL, error: null, surface: SURFACE };
    const line = serializeSessionEvent(row);
    expect(line).toContain('"surface":{"kind":"omitted"');
    // The full original IS in the log (not a bounded preview).
    expect(line).toContain(JSON.stringify(ORIGINAL));
    const parsed = parseSessionJsonl(line + "\n").events;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ value: ORIGINAL, surface: SURFACE });
    expect(serializeSessionEvent(parsed[0]!)).toBe(line);
  });

  it("projects the ORIGINAL to the bounded model face (never the full body)", () => {
    const face = toolResultText(null, ORIGINAL, SURFACE);
    expect(face).toContain("[omitted]");
    expect(face).toContain(SURFACE.locator);
    expect(face).not.toBe(ORIGINAL);
    expect(Buffer.byteLength(face, "utf8")).toBeLessThan(Buffer.byteLength(ORIGINAL, "utf8"));

    const messages = deriveMessages(EVENTS);
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(textOf(tool!)).toBe(face);
  });

  it("derives the SAME model context from the live events and from the replayed JSONL", () => {
    const live = deriveMessages(EVENTS);
    const replayed = parseSessionJsonl(serializeSessionJsonl(EVENTS)).events;
    const replay = deriveMessages(replayed);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(live));
    // …and the shared context is the bounded face, not the original.
    const tool = live.find((m) => m.role === "tool");
    expect(textOf(tool!)).toContain("[omitted]");
    expect(textOf(tool!)).not.toBe(ORIGINAL);
  });

  it("applies a tool-authored truncation note to the model face (C7)", () => {
    const truncation: ToolResultSurface = { kind: "truncation", note: "[truncated] 'x': showing first 10 of 100 bytes (budget)" };
    const face = toolResultText(null, "hello", truncation);
    expect(face).toBe(JSON.stringify("hello\n" + truncation.note));
    // No surface => unchanged (old behaviour).
    expect(toolResultText(null, "hello")).toBe('"hello"');
  });

  it("the Studio projection shows the face and carries the descriptor", () => {
    const rows = projectMessages(EVENTS);
    const tool = rows.find((m) => m.role === "tool" && m.kind === "result");
    expect(tool).toBeDefined();
    expect(String(tool!.tool_value)).toContain("[omitted]");
    expect(tool!.tool_surface).toEqual(SURFACE);
  });

  it("the replayed SSE transcript carries the face, not the original", () => {
    const frames = deriveSseTranscript(EVENTS);
    const frame = frames.find((f) => f.event === "tool_result");
    expect(frame).toBeDefined();
    expect(String(frame!.data.payload["value"])).toContain("[omitted]");
    expect(frame!.data.payload["value"]).not.toBe(ORIGINAL);
  });
});
