/**
 * serde_json-compatible text + a guard on the fixtures the parity tests rely
 * on: no engine-written log contains a float literal, so the single difference
 * between JS numbers and serde_json's `f64`/integer split (a literal `1.0`
 * round-trips as `1.0` in Rust and `1` in JS) cannot affect any golden.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstJsonDiff, serdeJsonString, sortKeys, stableStringify } from "./json.js";

const SESSIONS_DIR = fileURLToPath(new URL("../../../fixtures/sessions", import.meta.url));

describe("serdeJsonString", () => {
  it("sorts object keys like serde_json's BTreeMap", () => {
    expect(serdeJsonString({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("writes None as null and drops undefined array entries as null", () => {
    expect(serdeJsonString(undefined)).toBe("null");
    expect(serdeJsonString(null)).toBe("null");
    expect(serdeJsonString([1, undefined, "x"])).toBe('[1,null,"x"]');
  });

  it("keeps integers plain and normalises exponents", () => {
    expect(serdeJsonString(0)).toBe("0");
    expect(serdeJsonString(-12)).toBe("-12");
    expect(serdeJsonString(1e21)).toBe("1e21");
    expect(serdeJsonString(1.5)).toBe("1.5");
  });

  it("escapes control characters like serde_json (one-byte forms + \\u00xx)", () => {
    expect(serdeJsonString("a\nb\tc\u0001")).toBe('"a\\nb\\tc\\u0001"');
    expect(serdeJsonString("中文 ok")).toBe('"中文 ok"');
  });

  it("treats non-JSON values as null (serde_json cannot hold them)", () => {
    expect(serdeJsonString(() => 1)).toBe("null");
    expect(serdeJsonString(Number.NaN)).toBe("null");
    expect(serdeJsonString(Number.POSITIVE_INFINITY)).toBe("null");
  });
});

describe("JSON diff helpers", () => {
  it("sorts keys for stable output", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(sortKeys([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
  });

  it("reports the first structural difference", () => {
    expect(firstJsonDiff({ a: 1 }, { a: 1 })).toBeNull();
    expect(firstJsonDiff({ a: 1 }, { a: 2 })).toBe("$.a: 1 != 2");
    expect(firstJsonDiff([1, 2], [1])).toBe("$: array length 2 != 1");
    expect(firstJsonDiff({ a: 1 }, { b: 1 })).toBe("$.a: missing on right");
  });
});

/** Blank out JSON string literals so number tokens can be scanned textually. */
function stripJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    out += ch;
  }
  return out;
}

describe.skipIf(!existsSync(SESSIONS_DIR))("fixture logs carry no float literals", () => {
  it("keeps every number in the golden logs integral", () => {
    const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const log = readFileSync(join(SESSIONS_DIR, d.name, "cli-main.jsonl"), "utf8");
      const floats = stripJsonStrings(log).match(/\d\.\d|[eE][+-]?\d/g);
      expect(floats, `${d.name} float literals`).toBeNull();
    }
  });
});
