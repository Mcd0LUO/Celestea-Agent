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
