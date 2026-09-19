/**
 * W791 (P1) — `exposedRegistry`: the per-mode model-visible tool face.
 *
 * `docs/modes-standard-vs-execution.md` §5.2 #1/#2, M7/M8. Two claims are
 * asserted here, both on the REAL pipeline (real registry, real guard chain, real
 * broker + interpreter), never on a mock:
 *
 *   M7 (shape)  the `execution` face of a registry holding the production name
 *               set is EXACTLY the six kept names, and `standard` is the whole
 *               registry — the fold is a FACE, the inner registry keeps every
 *               tool;
 *   M8 (fold)   a direct `dispatch` of a folded name answers
 *               `tool_unavailable_in_mode` and the tool DID NOT RUN, while the
 *               SAME instance's `run_code` program can call that very tool —
 *               because the broker's `RegistryHandle` stays bound to the inner
 *               registry (the decorator never sees a sub-call).
 */

import type { ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { EXECUTION_TOOL_NAMES, executionExposure, exposedRegistry, faceForMode, TOOL_UNAVAILABLE_CODE, unavailableError } from "./exposure.js";
import { fnTool } from "./fn-tool.js";
import { assembleTools } from "./plugin.js";
import { ToolRegistryImpl } from "./registry.js";
import { startBrokerHarness, type BrokerHarness } from "./run-code/broker.test-util.js";

// W839 (R3 B8 / W818-P1-1): the harness is probed at COLLECTION time so the
// broker-backed case gates with a real it.skipIf. The old "if (!h.nodeReady)
// return" reported "no node here" as PASSED; vitest now counts it SKIPPED.
const h: BrokerHarness = await startBrokerHarness();

afterAll(async () => {
  await h.cleanup();
});

/** The production name set (contracts/tools.json; W884: 14, F4: +browser_open/act as this spec double tracks the keep list). */
const PRODUCTION_NAMES: readonly string[] = [
  "ask_user_question",
  "browser_act",
  "browser_open",
  "http_request",
  "list_dir",
  "load_skill",
  "process_control",
  "read_file",
  "run_code",
  "run_shell",
  "send_message",
  "stop_worker",
  "spawn_worker",
  "worker_status",
  "write_file",
];

/** A registry holding the production name set (specs only — nothing executes). */
function productionFace(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const name of PRODUCTION_NAMES) {
    registry.register(fnTool({ name, description: `${name} (exposure test double)`, parameters: { type: "object", properties: {} } }, async () => name));
  }
  return registry;
}

describe("exposedRegistry (W791 P1)", () => {
  it("M7: execution exposes exactly the eight kept names; standard exposes the whole registry", () => {
    const inner = productionFace();
    const execution = exposedRegistry(inner, executionExposure(inner.names()));
    expect(execution.schemas().map((s) => s.name).sort()).toEqual(["browser_act", "browser_open", "http_request", "load_skill", "process_control", "run_code", "send_message", "spawn_worker", "stop_worker", "worker_status"]);
    expect(execution.schemas().map((s) => s.name).sort()).toEqual([...EXECUTION_TOOL_NAMES].sort());
    // The inner registry is untouched: the fold is a FACE, not a removal — this
    // is what keeps `run_code` able to reach the folded tools.
    expect(inner.schemas().map((s) => s.name).sort()).toEqual([...PRODUCTION_NAMES].sort());
    // register / get are pass-throughs (the very path the registry handle uses).
    expect(execution.get("read_file")).toBe(inner.get("read_file"));
  });

  it("M7: the hidden set is fixed at wrap time — the wrap site decides new names", () => {
    const inner = productionFace();
    const execution = exposedRegistry(inner, executionExposure(inner.names()));
    // In production the only post-wrap registrations are the three worker tools,
    // which the keep list wants VISIBLE (`ensureWorkerWiring` registers through
    // this same face). A brand-new tool type therefore has to be decided about at
    // the wrap site instead of being folded implicitly.
    inner.register(fnTool({ name: "later_tool", description: "registered after the wrap", parameters: { type: "object", properties: {} } }, async () => "later"));
    expect(execution.schemas().map((s) => s.name)).toContain("later_tool");
    expect(execution.schemas().map((s) => s.name)).not.toContain("read_file");
  });

  it("M8 (first assertion): a folded name is REFUSED without executing, and says why", async () => {
    const inner = productionFace();
    const ran: string[] = [];
    inner.register(
      fnTool({ name: "read_file", description: "recording read_file", parameters: { type: "object", properties: {} } }, async () => {
        ran.push("read_file");
        return "content";
      }),
    );
    const execution = exposedRegistry(inner, executionExposure(inner.names()));
    const out = await execution.dispatch({ call_id: "c1", name: "read_file", args: {} });
    expect(out.error).toContain(TOOL_UNAVAILABLE_CODE);
    expect(out.error).toContain("read_file");
    // It did NOT run: nothing reached the tool, and the verdict is a deny.
    expect(ran).toEqual([]);
    expect(out.decision?.kind).toBe("deny");
    expect(out.value).toBeNull();
    expect(out.call_id).toBe("c1");
    // A kept name still passes straight through to the inner pipeline.
    const kept = await execution.dispatch({ call_id: "c2", name: "run_code", args: {} });
    expect(kept.decision?.kind).toBe("allow");
  });

  it.skipIf(!h.nodeReady)("M8 (second assertion): the assembled run_code reaches the folded tool from inside a program", async () => {
    const ran: string[] = [];
    const recorder = fnTool(
      { name: "read_file", description: "recording read_file", parameters: { type: "object", properties: { path: { type: "string" }, command: { type: "string" }, content: { type: "string" }, workdir: { type: "string" }, timeout_ms: { type: "integer" } }, additionalProperties: false } },
      async (args) => {
        ran.push(String((args as { path?: unknown }).path));
        return { echo: "read_file", args };
      },
    );
    // The PRODUCTION assembly (`plugin.ts`): it registers `run_code` and binds the
    // broker's handle to the registry it registered it into. The decorator is then
    // applied the way `engineTools` applies it — to the FACE only.
    const assembly = assembleTools({ tools: [recorder], sandbox: h.sandbox, env: process.env, guard: null });
    const runCode = assembly.registry.get("run_code");
    expect(runCode).toBeDefined();
    const execution = exposedRegistry(assembly.registry, executionExposure(assembly.registry.names()));
    expect(execution.schemas().map((s) => s.name)).toEqual(["run_code"]);

    const direct = await execution.dispatch({ call_id: "d1", name: "read_file", args: { path: "/tmp/direct.txt" } });
    expect(direct.error).toContain(TOOL_UNAVAILABLE_CODE);
    expect(ran).toEqual([]);

    // W833 (R3 B3 / W812 P2-4): assert the escape hatch on the DEFAULT
    // TypeScript matrix; a host without python3 can no longer skip it silently.
    const code = `
  const r = tools.read_file({ path: "/tmp/inner.txt" });
  return r;
`;
    const out = (await h.run(runCode as Parameters<BrokerHarness["run"]>[0], "rc-m8", { code })) as ToolExecOutcome;
    expect(out.value).toEqual({ echo: "read_file", args: { path: "/tmp/inner.txt" } });
    expect(out.render).toBeNull();
    expect(ran).toEqual(["/tmp/inner.txt"]);
  });

  it("the refusal text is stable and names both ways out", () => {
    const text = unavailableError("read_file");
    expect(text.startsWith(`${TOOL_UNAVAILABLE_CODE}: `)).toBe(true);
    expect(text).toContain("tools.read_file(");
    expect(text).toContain("standard mode");
    // A custom guidance template substitutes EVERY `{tool}` slot.
    expect(unavailableError("write_file", "no {tool} here, no {tool} there")).toBe(`${TOOL_UNAVAILABLE_CODE}: no write_file here, no write_file there`);
  });

  it("executionExposure is a KEEP list: a name outside it is folded, never inherited", () => {
    const opts = executionExposure(["run_code", "read_file", "ask_user_question"]);
    expect(opts.hidden).toEqual(["read_file", "ask_user_question"]);
    expect(executionExposure([...EXECUTION_TOOL_NAMES]).hidden).toEqual([]);
  });
});

describe("faceForMode with a permission deny list (W857)", () => {
  it("subtracts the denied names ON TOP of the mode fold and never restores a folded one", () => {
    const specs = productionFace().schemas();
    const standard = faceForMode(specs, "standard");
    expect(standard.map((s) => s.name).sort()).toEqual([...PRODUCTION_NAMES].sort());
    // An empty deny is the pre-W857 face byte for byte.
    expect(faceForMode(specs, "standard", [])).toEqual(standard);
    // standard (the whole registry) minus exactly the denied name.
    expect(
      faceForMode(specs, "standard", ["write_file"])
        .map((s) => s.name)
        .sort(),
    ).toEqual(PRODUCTION_NAMES.filter((name) => name !== "write_file").sort());
    // execution already folds read_file/write_file: denying them changes nothing,
    // i.e. the deny is an INTERSECTION and cannot add a folded name back.
    expect(
      faceForMode(specs, "execution", ["read_file", "write_file"])
        .map((s) => s.name)
        .sort(),
    ).toEqual([...EXECUTION_TOOL_NAMES].sort());
    // ...and denying a KEPT name removes exactly that one.
    expect(
      faceForMode(specs, "execution", ["run_code"])
        .map((s) => s.name)
        .sort(),
    ).toEqual([...EXECUTION_TOOL_NAMES].filter((name) => name !== "run_code").sort());
  });
});

// --- the broker harness (see the top of the file) ----------------------------
