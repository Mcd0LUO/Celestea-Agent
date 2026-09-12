/**
 * (e) The SSE envelope: construction (host side) and parsing (client side).
 *
 * A turn's frames are built in `apps/studio` (`createStudioBus`: envelope
 * `{v,session,turn,seq,payload}`, frozen field order, one global `seq`) and
 * serialized exactly as the endpoint writes them (`event: <name>` + `data:
 * <envelope JSON>`). The read side is the replay harness's `parseWire`, which is
 * the code that has to agree with the writer byte-for-byte.
 *
 * Both are reached through the `@celestea/studio` public barrel. If that barrel
 * cannot be loaded (it pulls the whole host app), the construction row falls
 * back to `core`'s SDK-side bus — the same envelope shape — and the fallback is
 * recorded in the row so a fallback number is never mistaken for a host number.
 */

import {
  assistantText,
  type LoopEvent,
  type SseEnvelope,
  type SseEventName,
} from "@celestea/core";
import { doneEvent, loopEventToSse, toolCallEvent, toolResultEvent, turnEndEvent } from "@celestea/agent-loop";
import { loopEventToFrame } from "@celestea/runtime";
import { caseOf, timeValue, type BenchCase } from "./timing.js";

/** Frames per encoded document (the decode row parses one document). */
const FRAMES = 200;
/** The turn number every frame carries (session-local, as the host writes it). */
const TURN = 7;
const SESSION = "sess-bench";

/** What the encoder needs; both the host bus and core's bus satisfy it. */
interface EnvelopeBus {
  emit(event: SseEventName, turn: number, payload: Record<string, unknown>, session?: string | null): {
    event: SseEventName;
    envelope: SseEnvelope;
  };
}

interface SseImpl {
  bus: EnvelopeBus;
  parseWire: (text: string) => unknown[];
  source: string;
}

/** The real host bus + parser, else core's bus + a local parse (recorded). */
async function loadSse(): Promise<SseImpl> {
  try {
    const studio = await import("@celestea/studio");
    return { bus: studio.createStudioBus() as EnvelopeBus, parseWire: studio.parseWire as (t: string) => unknown[], source: "apps/studio createStudioBus + parseWire" };
  } catch (error) {
    const core = await import("@celestea/core");
    const bus = core.createSseBus();
    return {
      // `core`'s SDK-side bus returns `{kind, data}`; the host returns
      // `{event, envelope}`. The adapter only renames fields of a REAL call.
      bus: { emit: (event, turn, payload) => { const frame = bus.emit(event, turn, payload); return { event: frame.kind, envelope: frame.data }; } },
      parseWire: fallbackParse,
      source: `core createSseBus + local parse (studio barrel unavailable: ${error instanceof Error ? error.message : "unknown"})`,
    };
  }
}

/** Mirrors `parseWire` for the fallback path only (`event: …` / `data: …`). */
function fallbackParse(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")) ?? "")
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
}

/** One representative LoopEvent per frame kind, in the order a turn emits them. */
function sampleEvents(): LoopEvent[] {
  return [
    { kind: "thinking", delta: "the user wants the file summarised" },
    { kind: "text", delta: "reading the file" },
    toolCallEvent({ id: "call-1", name: "read_file", args: { path: "src/a.ts" } }),
    toolResultEvent({ call_id: "call-1", value: { content: "export const a = 1;\n" }, render: null, error: null, decision: { kind: "allow" } }),
    doneEvent(assistantText("a.ts exports two constants; nothing else stands out.")),
    turnEndEvent("completed"),
  ];
}

/** `event: <name>\ndata: <envelope>\n\n` — the wire block the endpoint writes. */
function wireBlock(bus: EnvelopeBus, event: LoopEvent): string {
  const frame = loopEventToFrame(event);
  const built = bus.emit(frame.event, TURN, frame.payload, SESSION);
  return `event: ${built.event}\ndata: ${JSON.stringify(built.envelope)}\n\n`;
}

/** A document of `FRAMES` wire blocks (what a client receives in one batch). */
function wireDocument(bus: EnvelopeBus): string {
  const events = sampleEvents();
  let out = "";
  for (let i = 0; i < FRAMES; i += 1) {
    const event = events[i % events.length] ?? events[0];
    if (event !== undefined) out += wireBlock(bus, event);
  }
  return out;
}

/** (e) Encode and decode rows. Async because the host barrel is imported late. */
export async function sseCases(): Promise<BenchCase[]> {
  const impl = await loadSse();
  const events = sampleEvents();
  let cursor = 0;
  const encodeOne = (): number => {
    const event = events[cursor % events.length] ?? events[0];
    cursor += 1;
    return event === undefined ? 0 : wireBlock(impl.bus, event).length;
  };
  const encode = timeValue(encodeOne, { targetMs: 40 });
  const document = wireDocument(impl.bus);
  const frames = impl.parseWire(document).length;
  const decode = timeValue(() => impl.parseWire(document).length);
  let mapCursor = 0;
  const mapping = timeValue(() => {
    const event = events[mapCursor % events.length] ?? events[0];
    mapCursor += 1;
    if (event === undefined) return 0;
    const frame = loopEventToSse(event);
    return frame.event.length + Object.keys(frame.payload).length;
  });
  return [
    caseOf("SSE frame encode", "1 frame", encode, `loopEventToFrame + envelope + JSON + wire block (${impl.source})`, { impl: impl.source }),
    caseOf("SSE wire decode", `${FRAMES} frames`, decode, `parseWire over one ${document.length.toLocaleString("en-US")}-byte document`, {
      impl: impl.source,
      frames,
      frames_per_ms: Math.round((frames / decode.median_ms) * 100) / 100,
    }),
    caseOf("LoopEvent -> SSE name/payload", "1 event", mapping, "the contract mapping alone (no envelope, no JSON), cycling all 6 event kinds", {}),
  ];
}
