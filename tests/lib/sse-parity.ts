/**
 * `contracts/sse-events.json` -> executable payload assertions (W744, audit D3).
 *
 * The contract freezes, for each of the 8 SSE names, the payload KEYS and a
 * type DESCRIPTOR per key (`"string"`, `"any|null"`, `"'allow'|'deny'|'ask'|null"`,
 * `"array<{id,name,args}>"`, `"string?"`, …). Until W744 that table was never
 * compared with what the engine really emits: the SSE assertions lived on
 * `@celestea/agent-loop`'s copy of the mapping while production publishes
 * `@celestea/runtime`'s `loopEventToFrame`.
 *
 * This module turns each descriptor into a matcher, so a frame produced by the
 * PRODUCTION mapper is checked key-by-key against the frozen table and every
 * violation names the event, the key and the descriptor that was broken.
 *
 * Descriptor grammar (all forms used by the contract):
 *   `string` `integer` `number` `boolean` `object` `array` `any` `null`
 *   `'a'|'b'|null`   unions of the above and of quoted literals
 *   `string?`        trailing `?` = optional (the key may be absent)
 *   `array<{id,name,args}>`  array whose items carry those keys
 *   `... (free prose)`       a trailing parenthetical is a note, not a type
 *   `<statusline object>`    a placeholder: any value of the named shape
 *   a bare word / a phrase   a frozen example value (compared literally)
 */

import type { SseContract, SseEventContract } from "@celestea/core";

/** Where a contract event's payload keys come from (frozen + host extension). */
export interface PayloadKeyTable {
  /** Keys of `events[<name>].payload` — the frozen Rust payload. */
  frozen: string[];
  /** Keys declared in `payloadExtensions[<name>]` (W513/W515 host deltas). */
  extensions: string[];
}

/** One contract violation of a produced frame. */
export interface FrameViolation {
  event: string;
  key: string | null;
  message: string;
}

const PRIMITIVES = new Set(["string", "integer", "number", "boolean", "object", "array", "null"]);

type Matcher =
  | { kind: "any"; note: string | null }
  | { kind: "primitive"; name: string }
  | { kind: "literal"; value: string }
  | { kind: "optional"; inner: Matcher }
  | { kind: "union"; options: Matcher[]; source: string }
  | { kind: "arrayOf"; keys: string[] | null; element: Matcher | null; source: string };

/** Parse one payload type descriptor into a matcher (throws when empty). */
export function parseDescriptor(raw: string): Matcher {
  const withoutNote = stripNote(raw);
  const base = withoutNote.text.trim();
  if (base === "") throw new Error(`empty SSE payload descriptor: ${JSON.stringify(raw)}`);
  if (base.endsWith("?")) return { kind: "optional", inner: parseDescriptor(base.slice(0, -1)) };
  if (base.startsWith("array<") && base.endsWith(">")) return parseArrayDescriptor(base, withoutNote.note);
  if (base.includes("|")) return { kind: "union", options: base.split("|").map((part) => parseDescriptor(part)), source: base };
  if (PRIMITIVES.has(base)) return { kind: "primitive", name: base };
  if (base === "any") return { kind: "any", note: withoutNote.note };
  if (base.startsWith("<") && base.endsWith(">")) return { kind: "any", note: base };
  return { kind: "literal", value: unquote(base) };
}

function parseArrayDescriptor(base: string, note: string | null): Matcher {
  const inner = base.slice("array<".length, -1).trim();
  if (inner.startsWith("{") && inner.endsWith("}")) {
    const keys = inner.slice(1, -1).split(",").map((k) => k.trim()).filter((k) => k !== "");
    return { kind: "arrayOf", keys, element: null, source: base };
  }
  return { kind: "arrayOf", keys: null, element: parseDescriptor(inner), source: base };
}

/** `'allow'` -> `allow`: quoted literals are values, not types. */
function unquote(text: string): string {
  const quoted = text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')));
  return quoted ? text.slice(1, -1) : text;
}

/** Split `"string|null (only for outcome=error: '…')"` into type + note. */
function stripNote(raw: string): { text: string; note: string | null } {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(raw);
  if (match === null) return { text: raw, note: null };
  return { text: match[1] ?? "", note: match[2] ?? null };
}

/** The contract entry of one event name (throws when the contract lost it). */
export function contractEvent(contract: SseContract, name: string): SseEventContract {
  const found = contract.events.find((e) => e.name === name);
  if (found === undefined) throw new Error(`contracts/sse-events.json has no event '${name}' (known: ${contract.events.map((e) => e.name).join(", ")})`);
  return found;
}

/** Frozen keys + declared host extensions of one event's payload. */
export function payloadKeyTable(contract: SseContract, name: string): PayloadKeyTable {
  const event = contractEvent(contract, name);
  const extensions = extensionTable(contract)[name] ?? {};
  return { frozen: Object.keys(event.payload), extensions: Object.keys(extensions) };
}

/** `payloadExtensions` of the contract (absent = no declared host delta). */
export function extensionTable(contract: SseContract): Record<string, Record<string, string>> {
  const raw = (contract as unknown as Record<string, unknown>)["payloadExtensions"];
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name === "note") continue;
    if (value !== null && typeof value === "object") out[name] = value as Record<string, string>;
  }
  return out;
}

/** Every key the contract knows for one event, with its descriptor. */
export function descriptorTable(contract: SseContract, name: string): Record<string, string> {
  const event = contractEvent(contract, name);
  return { ...event.payload, ...(extensionTable(contract)[name] ?? {}) };
}

/**
 * Check one produced payload against the frozen table: key set (frozen keys
 * required, extensions allowed, nothing else) plus the type of every key.
 */
export function checkPayload(contract: SseContract, name: string, payload: Record<string, unknown>): FrameViolation[] {
  const event = contractEvent(contract, name);
  const table = payloadKeyTable(contract, name);
  const descriptors = descriptorTable(contract, name);
  const out: FrameViolation[] = [];
  const known = new Set([...table.frozen, ...table.extensions]);

  for (const key of table.frozen) {
    if (key in payload) continue;
    if (isOptional(descriptors[key])) continue;
    out.push(violation(name, key, `missing contract payload key '${key}' (contracts/sse-events.json events[${name}].payload)`));
  }
  for (const key of Object.keys(payload)) {
    if (known.has(key)) continue;
    out.push(violation(name, key, `payload key '${key}' is declared neither in events[${name}].payload (${table.frozen.join(", ") || "-"}) nor in payloadExtensions.${name} — extend the contract or stop emitting it`));
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!(key in payload)) continue;
    const problem = matchValue(parseDescriptor(descriptor), payload[key]);
    if (problem !== null) {
      out.push(violation(name, key, `payload key '${key}' = ${show(payload[key])} does not match the frozen type ${JSON.stringify(descriptor)}: ${problem} (contracts/sse-events.json events[${name}].payload.${key})`));
    }
  }
  void event;
  return out;
}

/** `string?` / `'autowake'?` — the key may be absent (or null). */
function isOptional(descriptor: string | undefined): boolean {
  if (descriptor === undefined) return false;
  return stripNote(descriptor).text.trim().endsWith("?");
}

/** `null` when the value satisfies the matcher, else why it does not. */
export function matchValue(matcher: Matcher, value: unknown): string | null {
  switch (matcher.kind) {
    case "any":
      return null;
    case "primitive":
      return primitiveProblem(matcher.name, value);
    case "literal":
      return value === matcher.value ? null : `expected the frozen value ${JSON.stringify(matcher.value)}`;
    case "optional":
      return value === undefined || value === null ? null : matchValue(matcher.inner, value);
    case "union": {
      if (matcher.options.some((option) => matchValue(option, value) === null)) return null;
      return `none of ${matcher.options.map(describeMatcher).join(" | ")} accepts it`;
    }
    case "arrayOf":
      return arrayOfProblem(matcher, value);
  }
}

/** `array<…>`: every item must satisfy the element shape. */
function arrayOfProblem(matcher: Matcher & { kind: "arrayOf" }, value: unknown): string | null {
  if (!Array.isArray(value)) return `expected array<${matcher.source}>, got ${typeName(value)}`;
  for (let i = 0; i < value.length; i++) {
    const problem = itemProblem(matcher, value[i], i);
    if (problem !== null) return problem;
  }
  return null;
}

function itemProblem(matcher: Matcher & { kind: "arrayOf" }, item: unknown, index: number): string | null {
  if (matcher.keys !== null) return keyedItemProblem(matcher.keys, item, index);
  if (matcher.element === null) return null;
  const problem = matchValue(matcher.element, item);
  return problem === null ? null : `item [${index}]: ${problem}`;
}

function keyedItemProblem(keys: readonly string[], item: unknown, index: number): string | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return `item [${index}] must be an object with {${keys.join(",")}}, got ${typeName(item)}`;
  }
  const missing = keys.find((key) => !(key in (item as Record<string, unknown>)));
  return missing === undefined ? null : `item [${index}] is missing the contract key '${missing}'`;
}

function primitiveProblem(name: string, value: unknown): string | null {
  if (name === "null") return value === null ? null : `expected null, got ${typeName(value)}`;
  if (name === "object") return value !== null && typeof value === "object" && !Array.isArray(value) ? null : `expected a JSON object, got ${typeName(value)}`;
  if (name === "array") return Array.isArray(value) ? null : `expected an array, got ${typeName(value)}`;
  if (name === "integer") return typeof value === "number" && Number.isInteger(value) ? null : `expected an integer, got ${show(value)}`;
  if (name === "number") return typeof value === "number" ? null : `expected a number, got ${typeName(value)}`;
  return typeof value === name ? null : `expected ${name}, got ${typeName(value)}`;
}

function describeMatcher(matcher: Matcher): string {
  switch (matcher.kind) {
    case "any":
      return matcher.note ?? "any";
    case "primitive":
      return matcher.name;
    case "literal":
      return JSON.stringify(matcher.value);
    case "optional":
      return `${describeMatcher(matcher.inner)}?`;
    case "union":
      return matcher.source;
    case "arrayOf":
      return matcher.source;
  }
}

function violation(event: string, key: string | null, message: string): FrameViolation {
  return { event, key, message: `SSE event '${event}': ${message}` };
}

/** One-line rendering of a violation list. */
export function describeFrameViolations(violations: readonly FrameViolation[]): string {
  return violations.map((v) => v.message).join("\n");
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function show(v: unknown): string {
  const text = JSON.stringify(v);
  if (text === undefined) return "undefined";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
