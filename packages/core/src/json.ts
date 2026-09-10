/** JSON helpers shared by the replay/export toolchain. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface ParseResult<T> {
  ok: true;
  value: T;
} 
export interface ParseFailure {
  ok: false;
  error: string;
}

export function tryParseJson(text: string): ParseResult<unknown> | ParseFailure {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable stringify (sorted object keys) for structural diffs. */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** First structural difference between two JSON values, or null when equal. */
export function firstJsonDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return `${path}: type ${ta} != ${tb}`;
  if (ta === "array") {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return `${path}: array length ${aa.length} != ${bb.length}`;
    for (let i = 0; i < aa.length; i++) {
      const d = firstJsonDiff(aa[i], bb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const k of keys) {
      if (!(k in ao)) return `${path}.${k}: missing on left`;
      if (!(k in bo)) return `${path}.${k}: missing on right`;
      const d = firstJsonDiff(ao[k], bo[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// serde_json-compatible text (the engine re-serializes every Value)
// ---------------------------------------------------------------------------

/**
 * `serde_json::to_string` equivalent for the JSON subset the engine carries.
 *
 * Why not `JSON.stringify`: the Rust engine stores every `args` / `value` as a
 * `serde_json::Value`, whose object map is a **BTreeMap** — so a re-serialized
 * value always has its keys in sorted order, and `None` becomes `null` rather
 * than an omitted key. `derive_messages` embeds this text in the model-visible
 * history ("Error: …" or the JSON of the value) and `PersistentSessionLog`
 * writes each event through it, so the difference is observable in the log and
 * in the derived messages. Values that `serde_json::Value` cannot hold
 * (undefined, functions, NaN/Infinity) have no Rust counterpart and map to
 * `null`, matching the `unwrap_or_else(|_| "null")` fallback in
 * `crates/session/src/log.rs:192`.
 */
export function serdeJsonString(value: unknown): string {
  return writeValue(value);
}

function writeValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return serdeNumber(v);
    case "boolean":
      return v ? "true" : "false";
    case "object": {
      if (Array.isArray(v)) return `[${v.map(writeValue).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${writeValue(o[k])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

/**
 * Rust number formatting (ryu shortest round-trip): integers keep their plain
 * form and exponents lose the JS `+` sign (`1e+21` -> `1e21`).
 * Known residual difference: a JSON literal `1.0` is stored as `f64` by
 * serde_json and prints back as `1.0`, while JS has a single number type and
 * prints `1`. No engine-written log contains such a literal (asserted by
 * `packages/core/src/json.test.ts:fixture logs carry no float literals`).
 */
function serdeNumber(n: number): string {
  if (!Number.isFinite(n)) return "null";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return n.toString().replace("e+", "e");
}
