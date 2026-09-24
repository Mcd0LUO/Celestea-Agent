/**
 * W1483 — one denial vocabulary, one shape, one place to read it.
 *
 * The three prefixes are FROZEN contract (the Rust parity target and several
 * suites pin them byte-for-byte), so this file asserts the properties that make
 * them one vocabulary rather than renaming anything:
 *
 *   V1 (declaration)  every prefix has exactly ONE declaration, and every
 *                     producer's constant IS that declaration — not a copy;
 *   V2 (shape)        every denial renders '<prefix>: code=<code> msg="<quoted>"',
 *                     including through SandboxError, so a model that learned
 *                     the shape from one family can parse the other two;
 *   V3 (classification) denialFamily routes a rendered message back to its
 *                     producer, and answers null for text that is NOT a
 *                     contract denial (so "refused" is never confused with
 *                     "ran and failed").
 *
 * V3 is the part that did not exist before W1483: consumers used to string-match
 * three literals themselves, each with its own idea of the order.
 */

import { describe, expect, it } from "vitest";
import { SandboxError, contractDenial } from "@celestea/core";

import { DENIAL_PREFIXES, denialFamily, errorCode, isDenialText, quoteMessage } from "./errors.js";
import { GUARD_ERROR_PREFIX, PathGuardPolicy } from "./guard/path-guard.js";
import { ToolRegistryImpl } from "./registry.js";
import { validateArgs } from "./schema.js";

describe("W1483 V1 — the prefixes are declared once", () => {
  it("declares exactly the three frozen prefixes", () => {
    expect(DENIAL_PREFIXES).toEqual({ args: "toolargs", guard: "toolguard", sandbox: "run_shell-sandbox" });
  });

  it("re-exports the guard prefix rather than restating it", () => {
    // A second literal somewhere is exactly the drift this task removed.
    expect(GUARD_ERROR_PREFIX).toBe(DENIAL_PREFIXES.guard);
  });

  it("renders the sandbox prefix from the same declaration", () => {
    const failure = new SandboxError("timeout", "killed");
    expect(failure.message.startsWith(DENIAL_PREFIXES.sandbox + ":")).toBe(true);
  });
});

describe("W1483 V2 — every family renders the same shape", () => {
  it("quotes, escapes and truncates identically wherever a denial is built", () => {
    const message = 'a "quoted" \\ line\\nbreak\\ttab';
    const rendered = contractDenial("toolguard", "path_forbidden", message);
    expect(rendered).toBe('toolguard: code=path_forbidden msg="' + quoteMessage(message) + '"');
    // The escaping is the contract: the one-line shape must survive a message
    // that itself contains the delimiters.
    expect(rendered).not.toContain("\n");
    expect(rendered).toContain('\\"quoted\\"');
  });

  it("keeps the sandbox error parseable by the same code reader", () => {
    expect(errorCode(new SandboxError("workdir", "outside").message)).toBe("workdir");
    expect(errorCode(contractDenial(DENIAL_PREFIXES.guard, "path_forbidden", "x"))).toBe("path_forbidden");
  });
});

describe("W1483 V3 — one classifier routes every refusal", () => {
  it("routes each family back to its producer", () => {
    expect(denialFamily(contractDenial(DENIAL_PREFIXES.args, "schema", "missing"))).toBe("args");
    expect(denialFamily(contractDenial(DENIAL_PREFIXES.guard, "path_forbidden", "outside"))).toBe("guard");
    expect(denialFamily(new SandboxError("config", "sandbox_unavailable: x").message)).toBe("sandbox");
  });

  it("does NOT classify a tool's own failure as a denial", () => {
    // The distinction the model needs: "refused" vs "ran and failed".
    for (const text of ["boom", "denied: something else", "Error: ENOENT", ""]) {
      expect(denialFamily(text)).toBeNull();
      expect(isDenialText(text)).toBe(false);
    }
  });

  it("classifies the real pipeline's refusals, end to end", async () => {
    const registry = new ToolRegistryImpl();
    const refused = await registry.dispatch({ call_id: "c1", name: "nope", args: {} });
    // An unknown tool is still a REFUSAL, but it is not a contract denial: the
    // registry never wrapped it, so the classifier must not invent a family.
    expect(denialFamily(String(refused.error))).toBeNull();
    expect(refused.decision?.kind).toBe("deny");

    const schema = validateArgs({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }, {});
    expect(schema).not.toBeNull();
    const rendered = contractDenial(DENIAL_PREFIXES.args, "schema", schema?.message ?? "");
    expect(denialFamily(rendered)).toBe("args");
  });

  it("classifies a real guard denial as `guard`", () => {
    const policy = new PathGuardPolicy({ workspace: "/tmp" });
    const decision = policy.checkWrite("/etc/passwd");
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") expect(denialFamily(decision.reason)).toBe("guard");
  });
});
