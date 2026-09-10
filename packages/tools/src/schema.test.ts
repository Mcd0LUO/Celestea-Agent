import { describe, expect, it } from "vitest";

import { validateArgs } from "./schema.js";

const toolSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    timeout_ms: { type: "integer", minimum: 1 },
    method: { type: "string", enum: ["GET", "POST"] },
    headers: { type: "object", additionalProperties: { type: "string" } },
    list: { type: "array", items: { type: "string" } },
    flag: { type: "boolean" },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("validateArgs", () => {
  it("accepts a well-formed object", () => {
    expect(validateArgs(toolSchema, { path: "/x", timeout_ms: 5, flag: true })).toBeNull();
  });

  it("rejects a missing required property", () => {
    expect(validateArgs(toolSchema, {})?.message).toBe("missing required property 'path'");
  });

  it("rejects a non-object argument payload", () => {
    expect(validateArgs(toolSchema, "nope")?.message).toBe("args must be object (got string)");
  });

  it("reports the property path on a type mismatch", () => {
    expect(validateArgs(toolSchema, { path: 7 })?.message).toBe("property 'path' must be string (got number)");
  });

  it("rejects unexpected properties when additionalProperties is false", () => {
    const fail = validateArgs(toolSchema, { path: "/x", nope: 1 });
    expect(fail?.message).toBe("unexpected property 'nope' (additionalProperties: false)");
  });

  it("enforces enum membership", () => {
    expect(validateArgs(toolSchema, { path: "/x", method: "GET" })).toBeNull();
    expect(validateArgs(toolSchema, { path: "/x", method: "TRACE" })?.message).toBe("property 'method' must be one of [GET, POST]");
  });

  it("enforces a numeric minimum and integrality", () => {
    expect(validateArgs(toolSchema, { path: "/x", timeout_ms: 1 })).toBeNull();
    expect(validateArgs(toolSchema, { path: "/x", timeout_ms: 0 })?.message).toBe("property 'timeout_ms' must be >= 1 (got 0)");
    expect(validateArgs(toolSchema, { path: "/x", timeout_ms: 1.5 })?.message).toBe("property 'timeout_ms' must be integer (got number)");
  });

  it("validates nested items and nested properties", () => {
    expect(validateArgs(toolSchema, { path: "/x", list: ["a"] })).toBeNull();
    expect(validateArgs(toolSchema, { path: "/x", list: ["a", 2] })?.message).toBe("property 'list[1]' must be string (got number)");
    expect(validateArgs(toolSchema, { path: "/x", headers: { a: 1 } })?.message).toBe("property 'headers.a' must be string (got number)");
  });

  it("treats a missing schema as unconstrained", () => {
    expect(validateArgs(undefined, { anything: 1 })).toBeNull();
    expect(validateArgs({}, { anything: 1 })).toBeNull();
  });
});
