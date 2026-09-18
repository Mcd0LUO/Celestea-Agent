/**
 * W855 (B6): the MODEL-VISIBLE FACE of a tool result, derived at READ time.
 *
 * The session log stores the ORIGINAL `tool_result.value`; the face (a bounded
 * head/tail window + locator, or a tool-authored truncation note) is produced
 * HERE by the projection. Keeping the pure rendering in core is what lets
 * `projection.ts` render it without importing the L1 retention policy.
 *
 * The primitives were moved out of `packages/agent-loop/src/retention.ts`
 * (W846/W855) unchanged, so the live and replayed faces stay byte-identical.
 */

import { serdeJsonString } from "./json.js";
import type { ToolResultSurface } from "./types.js";

/** Longest prefix of text within maxBytes, never splitting a code point. */
export function cutPrefixCodePoints(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let out = "";
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return out;
}

/** Longest suffix of text within maxBytes, never splitting a code point. */
export function cutSuffixCodePoints(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let out = "";
  const chars = Array.from(text);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? "";
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    used += n;
    out = ch + out;
  }
  return out;
}

export interface RetainedText {
  head: string;
  tail: string;
  keptBytes: number;
  omittedBytes: number;
  totalBytes: number;
}

/** Head+tail window over text (code-point safe) with the EXACT omitted count. */
export function retainHeadTail(text: string, headBytes: number, tailBytes: number): RetainedText {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) {
    return { head: text, tail: "", keptBytes: totalBytes, omittedBytes: 0, totalBytes };
  }
  const head = cutPrefixCodePoints(text, headBytes);
  const tail = cutSuffixCodePoints(text, tailBytes);
  const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  return { head, tail, keptBytes, omittedBytes: totalBytes - keptBytes, totalBytes };
}

/** The standardized omission clause + the tool-shaped retrieval instruction. */
export function formatOmissionNotice(surface: Extract<ToolResultSurface, { kind: "omitted" }>): string {
  return (
    "[omitted] " +
    String(surface.omitted_bytes) +
    " of " +
    String(surface.total_bytes) +
    " bytes kept out of the model context by the tool-result budget; full text: " +
    surface.locator +
    " (" +
    surface.retrieval_hint +
    ")"
  );
}

/** Bounded head/tail window + notice (the model-visible face of an omission). */
export function renderOmittedText(text: string, surface: Extract<ToolResultSurface, { kind: "omitted" }>): string {
  const window = retainHeadTail(text, surface.head_bytes, surface.tail_bytes);
  const notice = formatOmissionNotice(surface);
  if (window.tail === "") return window.head + "\n" + notice;
  return window.head + "\n...\n" + window.tail + "\n" + notice;
}

/**
 * The RAW face of one tool value: the bounded/annotated string when a surface is
 * present, else the value untouched. SSE/replay frames and the Studio transcript
 * use exactly this, so a live frame and its replay agree.
 */
export function toolSurfaceValue(value: unknown, surface?: ToolResultSurface): unknown {
  if (surface === undefined) return value;
  const text = typeof value === "string" ? value : serdeJsonString(value === undefined ? null : value);
  if (surface.kind === "omitted") return renderOmittedText(text, surface);
  return text === "" ? surface.note : text + "\n" + surface.note;
}

/**
 * The model-PROJECTED TEXT of one tool value with its surface applied. The
 * projection has ALWAYS JSON-encoded the value (`serdeJsonString`), so a
 * surface-less string stays `"hello"`; a surfaced one encodes its RAW face.
 */
export function toolSurfaceText(value: unknown, surface?: ToolResultSurface): string {
  if (surface === undefined) return serdeJsonString(value === undefined ? null : value);
  return serdeJsonString(toolSurfaceValue(value, surface));
}
