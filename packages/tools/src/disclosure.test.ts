/**
 * W806 (P0) — dynamic tool disclosure: the cache-safe second hidden layer.
 *
 * Four claims, all executable on the real pipeline (real registry, real guard
 * chain, real broker):
 *
 *   C1 (policy)  the disclosed set only ever GROWS, only at `beginTurn()`, and
 *                every new name is APPENDED — the wire array is append-only, so
 *                the provider's byte-prefix cache keeps its prefix (design §3.5);
 *   C2 (safety)  a direct call to a withheld name is refused BEFORE execution,
 *                with the disclosure prose (not the mode fold's);
 *   C2b (union)  a name folded by the MODE can never be disclosed by the
 *                dynamic layer — the mode fold is a hard union;
 *   C3 (escape)  the SAME withheld name still runs from inside `run_code`: the
 *                decorator never sees a sub-call (the deliberate divergence from
 *                DSH `restrict()`, design §2.5/§4).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolExecOutcome, ToolRegistry } from "@celestea/core";

import { DisclosurePolicy, disclosureExposure } from "./disclosure.js";
import { exposedRegistry, TOOL_UNAVAILABLE_CODE } from "./exposure.js";
import { fnTool } from "./fn-tool.js";
import { assembleTools } from "./plugin.js";
import { ToolRegistryImpl } from "./registry.js";
import { startBrokerHarness, type BrokerHarness } from "./run-code/broker.test-util.js";

/** A registry holding [names] as inert recording doubles. */
function registryOf(names: readonly string[], ran: string[] = []): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const name of names) {
    const spec = { name, description: `${name} (disclosure test double)`, parameters: { type: "object", properties: {} } };
    registry.register(fnTool(spec, async () => {
      ran.push(name);
      return name;
    }));
  }
  return registry;
}

/** The names an exposed face offers, in wire order. */
function wire(face: ToolRegistry): string[] {
  return face.schemas().map((spec) => spec.name);
}

describe("DisclosurePolicy (W806 P0 / C1)", () => {
  it("grows only at beginTurn(), appends, and never reorders or shrinks", () => {
    const policy = new DisclosurePolicy({ universe: ["a", "b", "c", "d", "e"], initial: ["b", "c"] });
    expect(policy.disclosed()).toEqual(["b", "c"]);
    expect(policy.hidden()).toEqual(["a", "d", "e"]);
    expect(policy.active).toBe(true);

    // A refusal during the turn is a PROPOSAL: the wire array does not move.
    expect(policy.propose("d")).toBe(true);
    expect(policy.propose("a")).toBe(true);
    expect(policy.disclosed()).toEqual(["b", "c"]);
    expect(policy.hidden()).toEqual(["a", "d", "e"]);

    expect(policy.beginTurn()).toEqual(["d", "a"]);
    const turn1 = policy.disclosed();
    expect(turn1).toEqual(["b", "c", "d", "a"]);
    expect(policy.hidden()).toEqual(["e"]);

    // A turn that discloses nothing does not touch the wire array at all.
    expect(policy.beginTurn()).toEqual([]);
    expect(policy.disclosed()).toEqual(turn1);

    expect(policy.propose("e")).toBe(true);
    expect(policy.beginTurn()).toEqual(["e"]);
    const turn2 = policy.disclosed();
    // Monotonic containment + strict tail append: turn1 is a byte-prefix of turn2.
    expect(turn2.slice(0, turn1.length)).toEqual(turn1);
    expect(turn2.slice(turn1.length)).toEqual(["e"]);
    expect(turn1.every((name) => turn2.includes(name))).toBe(true);
    expect(new Set(turn2).size).toBe(turn2.length);
    expect(policy.active).toBe(false);
  });

  it("rejects unknown / blocked / already-offered / duplicate proposals", () => {
    const policy = new DisclosurePolicy({ universe: ["a", "b", "c"], initial: ["a"], blocked: ["c"] });
    expect(policy.propose("ghost")).toBe(false); // not in the universe
    expect(policy.propose("c")).toBe(false); // the mode fold is never disclosable
    expect(policy.propose("a")).toBe(false); // already offered
    expect(policy.propose("b")).toBe(true);
    expect(policy.propose("b")).toBe(false); // one pending entry per name
    expect(policy.beginTurn()).toEqual(["b"]);
    expect(policy.propose("b")).toBe(false); // now already disclosed
    expect(policy.beginTurn()).toEqual([]);
  });

  it("C2b: the mode fold is a hard union — a blocked name stays hidden forever", () => {
    const policy = new DisclosurePolicy({ universe: ["run_code", "read_file"], initial: ["run_code"], blocked: ["read_file"] });
    expect(policy.isBlocked("read_file")).toBe(true);
    expect(policy.propose("read_file")).toBe(false);
    expect(policy.beginTurn()).toEqual([]);
    expect(policy.disclosed()).toEqual(["run_code"]);
    expect(policy.hidden()).toEqual(["read_file"]);
    // Nothing disclosable is withheld, so the dynamic layer is inert.
    expect(policy.active).toBe(false);
  });

  it("snapshot/universeNames expose the static universe and the live face", () => {
    const policy = new DisclosurePolicy({ universe: ["a", "b"], initial: ["a"] });
    expect(policy.universeNames()).toEqual(["a", "b"]);
    expect(policy.snapshot()).toEqual({ disclosed: ["a"], hidden: ["b"] });
    policy.propose("b");
    policy.beginTurn();
    expect(policy.snapshot()).toEqual({ disclosed: ["a", "b"], hidden: [] });
  });
});

describe("disclosureExposure over exposedRegistry (W806 P0 / C2)", () => {
  it("refuses a withheld direct call before execution, with the disclosure prose", async () => {
    const ran: string[] = [];
    const inner = registryOf(["read_file", "run_code", "write_file"], ran);
    const policy = new DisclosurePolicy({ universe: inner.names(), initial: ["run_code", "write_file"] });
    const face = exposedRegistry(inner, disclosureExposure(policy));
    expect(wire(face)).toEqual(["run_code", "write_file"]);

    const direct = await face.dispatch({ call_id: "d1", name: "read_file", args: {} });
    expect(direct.error).toContain(TOOL_UNAVAILABLE_CODE);
    expect(direct.error).toContain("NEXT turn boundary");
    expect(direct.error).not.toContain("execution mode");
    expect(direct.decision?.kind).toBe("deny");
    expect(direct.value).toBeNull();
    expect(ran).toEqual([]); // it did NOT run
    expect(policy.disclosed()).toEqual(["run_code", "write_file"]); // proposal only

    // A disclosed name still passes straight through to the inner pipeline.
    const kept = await face.dispatch({ call_id: "d2", name: "write_file", args: {} });
    expect(kept.decision?.kind).toBe("allow");
    expect(ran).toEqual(["write_file"]);
  });

  it("beginTurn appends the newly disclosed name at the TAIL", async () => {
    const inner = registryOf(["read_file", "run_code", "write_file"]);
    const policy = new DisclosurePolicy({ universe: inner.names(), initial: ["run_code", "write_file"] });
    const face = exposedRegistry(inner, disclosureExposure(policy));
    await face.dispatch({ call_id: "d1", name: "read_file", args: {} });
    expect(policy.beginTurn()).toEqual(["read_file"]);
    expect(wire(face)).toEqual(["run_code", "write_file", "read_file"]);
    // The already-cached prefix is untouched — the disclosure is a pure append.
    expect(wire(face).slice(0, 2)).toEqual(["run_code", "write_file"]);
  });

  it("keeps a LATE registration appended (append-only across registrations)", () => {
    const inner = registryOf(["a", "c"]);
    const policy = new DisclosurePolicy({ universe: inner.names(), initial: ["a"] });
    const face = exposedRegistry(inner, disclosureExposure(policy));
    expect(wire(face)).toEqual(["a"]); // seeds the wire order
    // A tool registered AFTER the policy was built must not be inserted: it is
    // appended, so a later dynamic disclosure still lands at the very tail.
    inner.register(fnTool({ name: "b", description: "late", parameters: { type: "object", properties: {} } }, async () => "b"));
    expect(wire(face)).toEqual(["a", "b"]);
    policy.propose("c");
    policy.beginTurn();
    expect(wire(face)).toEqual(["a", "b", "c"]);
  });

  it("C2b: a blocked name keeps the MODE's refusal prose (union semantics)", async () => {
    const inner = registryOf(["read_file", "run_code"]);
    const policy = new DisclosurePolicy({ universe: inner.names(), initial: ["run_code"], blocked: ["read_file"] });
    const face = exposedRegistry(inner, disclosureExposure(policy));
    const out = await face.dispatch({ call_id: "d1", name: "read_file", args: {} });
    expect(out.error).toContain(TOOL_UNAVAILABLE_CODE);
    expect(out.error).toContain("execution mode");
    expect(out.decision?.kind).toBe("deny");
    expect(policy.beginTurn()).toEqual([]);
    expect(policy.hidden()).toEqual(["read_file"]);
  });
});

// --- C3: a withheld tool still runs from inside a real program ---------------
let h: BrokerHarness;

beforeAll(async () => {
  h = await startBrokerHarness();
});

afterAll(async () => {
  if (h !== undefined) await h.cleanup();
});

describe("run_code escape hatch (W806 P0 / C3)", () => {
  it("a dynamically withheld tool is reachable from a program's sub-call", async () => {
    if (!h.pythonReady) return; // the broker matrix skips without an interpreter
    const ran: string[] = [];
    const recorder = fnTool(
      {
        name: "read_file",
        description: "recording read_file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            command: { type: "string" },
            content: { type: "string" },
            workdir: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      async (args) => {
        ran.push(String((args as { path?: unknown }).path));
        return { echo: "read_file", args };
      },
    );
    const assembly = assembleTools({ tools: [recorder], sandbox: h.sandbox, env: process.env, guard: null });
    const universe = assembly.registry.schemas().map((spec) => spec.name);
    const policy = new DisclosurePolicy({ universe, initial: ["run_code"] });
    const face = exposedRegistry(assembly.registry, disclosureExposure(policy));
    expect(wire(face)).toEqual(["run_code"]);

    const direct = await face.dispatch({ call_id: "d1", name: "read_file", args: { path: "/tmp/direct.txt" } });
    expect(direct.error).toContain(TOOL_UNAVAILABLE_CODE);
    expect(ran).toEqual([]);

    const runCode = assembly.registry.get("run_code");
    const code = `
async def main():
    return tools.read_file(path="/tmp/inner.txt")
`;
    const out = (await h.run(runCode as Parameters<BrokerHarness["run"]>[0], "rc-w806", { code, language: "python" })) as ToolExecOutcome;
    expect(out.value).toEqual({ echo: "read_file", args: { path: "/tmp/inner.txt" } });
    expect(ran).toEqual(["/tmp/inner.txt"]);
  });
});
