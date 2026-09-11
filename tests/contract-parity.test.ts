/**
 * W744 (audit D1 + D2) — the contracts stop being documents.
 *
 * D1: `contracts/session-event.schema.json` was never executed. Here it is run
 *     against the REAL event streams (every line of every golden session log,
 *     plus a live turn driven through the production assembly) and against
 *     deliberate mutations, so the schema and the hand-written codec can no
 *     longer drift apart unnoticed.
 * D2: only `run_code`'s spec was compared with `contracts/tools.json`. All 7
 *     builtin specs are now compared field by field against the implementation
 *     registry (`assembleTools(...).registry.schemas()` — what `GET /api/tools`
 *     serves), including the three worker tools' contract provenance.
 *
 * Every failure names the field, the event or the tool it came from.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixturePath, loadSessionEventSchema, loadTools, validateSessionEvent, type Sandbox, type SessionEvent } from "@celestea/core";
import { assembleTools } from "@celestea/tools";
import { compareToolSpecs, describeFindings, uncoveredTools } from "./lib/tool-parity.js";
import { describeViolations, schemaAccepts, unsupportedKeywords, validateSchema } from "./lib/json-schema.js";
import { runProductionTurn } from "./lib/engine-corpus.js";

const SCHEMA = loadSessionEventSchema();
const CONTRACT = loadTools();
/** The 7 specs `assembleTools` mounts (the worker trio comes from the contract). */
const REGISTRY_TOOLS = ["http_request", "list_dir", "process_control", "read_file", "run_code", "run_shell", "write_file"];
const WORKER_TOOLS = ["session_send_message", "spawn_worker", "worker_status"];

/** The golden fixtures are exported on demand (`pnpm golden:export`). */
const HAS_FIXTURES = existsSync(fixturePath("index.json"));

interface RealRow {
  label: string;
  row: unknown;
}

/** Every line of every golden session log, labelled `file:line [type]`. */
function realRows(): RealRow[] {
  const manifest = fixturePath("index.json");
  if (!existsSync(manifest)) return [];
  const sessions = (JSON.parse(readFileSync(manifest, "utf8")) as { sessions: Array<{ slug: string }> }).sessions;
  const rows: RealRow[] = [];
  for (const s of sessions) {
    const file = fixturePath("sessions", s.slug, "cli-main.jsonl");
    if (!existsSync(file)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trim() === "") return;
        const row = JSON.parse(line) as { type?: string };
        rows.push({ label: `${s.slug.slice(0, 24)}/cli-main.jsonl:${i + 1} [${String(row.type)}]`, row });
      });
  }
  return rows;
}

/** The frozen schema must reject this row, naming `names` in the message. */
const MUTATIONS: Array<{ what: string; row: unknown; names: string }> = [
  { what: "turn_start without id", row: { type: "turn_start" }, names: "id" },
  { what: "turn_start with a non-numeric turn id", row: { type: "turn_start", id: "turn-x" }, names: "pattern" },
  { what: "an unknown event type", row: { type: "tool_error", id: "c1" }, names: "oneOf" },
  { what: "user_message with a numeric text", row: { type: "user_message", text: 7 }, names: "text" },
  { what: "tool_call without args", row: { type: "tool_call", id: "c1", name: "read_file" }, names: "args" },
  { what: "tool_call with a numeric name", row: { type: "tool_call", id: "c1", name: 5, args: {} }, names: "name" },
  { what: "tool_result with a boolean error", row: { type: "tool_result", id: "c1", value: null, error: true }, names: "error" },
  { what: "turn_end with an unknown error kind", row: { type: "turn_end", id: "turn-0", outcome: { error: { kind: "timeout", message: "x" } } }, names: "kind" },
  { what: "turn_end with a string outcome typo", row: { type: "turn_end", id: "turn-0", outcome: "failed" }, names: "outcome" },
];

describe("W744 · session-event schema EXECUTED against the real event streams", () => {
  const rows = realRows();

  it("implements every keyword the frozen schema uses (a construct can never become a no-op check)", () => {
    const unsupported = unsupportedKeywords(SCHEMA);
    expect(describeViolations(unsupported)).toBe("");
  });

  it.skipIf(!HAS_FIXTURES)("accepts every line of every golden session log (real production JSONL)", () => {
    expect(rows.length).toBeGreaterThan(500);
    const failures = rows
      .map((r) => ({ label: r.label, violations: validateSchema(SCHEMA, r.row) }))
      .filter((r) => r.violations.length > 0)
      .map((r) => `${r.label} -> ${describeViolations(r.violations)}`);
    expect(failures.join("\n")).toBe("");
  });

  it("accepts the live event stream of a real turn over the production assembly", async () => {
    const turn = await runProductionTurn();
    const kinds = new Set(turn.events.map((e) => e.type));
    // The corpus must be exhaustive, or the check below would be vacuous.
    expect([...kinds].sort()).toEqual(["assistant_message", "thinking_delta", "tool_call", "tool_result", "turn_end", "turn_start", "user_message"]);
    const failures = turn.events
      .map((e, i) => ({ label: `live:${i} [${e.type}]`, violations: validateSchema(SCHEMA, e as unknown) }))
      .filter((r) => r.violations.length > 0)
      .map((r) => `${r.label} -> ${describeViolations(r.violations)}`);
    expect(failures.join("\n")).toBe("");
  });

  it("rejects every deliberate mutation of a real row and names the broken field", () => {
    for (const mutation of MUTATIONS) {
      const violations = validateSchema(SCHEMA, mutation.row);
      const text = describeViolations(violations);
      expect(violations.length, `${mutation.what}: the frozen schema accepted it (${text})`).toBeGreaterThan(0);
      expect(text, `${mutation.what}: the failure never names '${mutation.names}' (${text})`).toContain(mutation.names);
    }
  });

  it.skipIf(!HAS_FIXTURES)("keeps exactly the two known codec/schema deltas (no silent divergence)", () => {
    const both = [...rows, ...MUTATIONS.map((m) => ({ label: `mutation: ${m.what}`, row: m.row }))];
    const disagreements = both
      .map((r) => ({ label: r.label, codec: validateSessionEvent(r.row).ok, schema: schemaAccepts(SCHEMA, r.row) }))
      .filter((r) => r.codec !== r.schema)
      .map((r) => `${r.label}: codec=${String(r.codec)} schema=${String(r.schema)}`);
    // 1. `turn-<n>` is a frozen schema pattern; the core codec only checks "string"
    //    (@celestea/session enforces the arithmetic on the ids it mints).
    // 2. `TurnOutcome.error.kind` is an enum in the contract; `isTurnOutcome` only
    //    checks "string" (the Rust enum has exactly generate|stream).
    // The third delta (the deserializer tolerates ABSENT `Option` fields while the
    // schema freezes the serialized wire shape) is pinned by the test below.
    expect(disagreements).toEqual([
      "mutation: turn_start with a non-numeric turn id: codec=true schema=false",
      "mutation: turn_end with an unknown error kind: codec=true schema=false",
    ]);
  });

  it("pins the deserializer leniency the schema deliberately does not model", () => {
    const withoutOptions = { type: "tool_result", id: "c1" };
    // serde: an absent `Option` field IS `None`, so the engine reads this row...
    const codec = validateSessionEvent(withoutOptions);
    expect(codec.ok).toBe(true);
    if (codec.ok) expect((codec.event as { value?: unknown }).value).toBeUndefined();
    // ...but it can never be PRODUCED: serde writes non-skipped Options as null.
    expect(describeViolations(validateSchema(SCHEMA, withoutOptions))).toContain("$.value");
  });

  it("reads the legacy turn_end row the same way in both places (serde default)", () => {
    const legacy = { type: "turn_end", id: "turn-0" };
    expect(validateSchema(SCHEMA, legacy)).toEqual([]);
    const codec = validateSessionEvent(legacy);
    expect(codec.ok).toBe(true);
    if (codec.ok) expect((codec.event as SessionEvent & { outcome: string }).outcome).toBe("completed");
  });
});

describe("W744 · all 7 builtin tool specs match the implementation registry", () => {
  const specs = assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas();

  it("the registry of record holds exactly the 7 contract tools", () => {
    expect(specs.map((s) => s.name)).toEqual(REGISTRY_TOOLS);
  });

  it("compares name + description + parameters of 7/7 against contracts/tools.json", () => {
    const findings = compareToolSpecs(CONTRACT, specs);
    expect(describeFindings(findings)).toBe("");
    expect(specs).toHaveLength(REGISTRY_TOOLS.length);
  });

  it("leaves no contract tool uncovered (the trio comes from the frozen contract)", () => {
    expect(CONTRACT.tools).toHaveLength(10);
    expect(uncoveredTools(CONTRACT, specs, WORKER_TOOLS)).toEqual([]);
  });

  it("catches a single mutated field, naming the tool and the JSON path", () => {
    const base = specs.find((s) => s.name === "run_shell");
    expect(base).toBeDefined();
    const mutations: Array<{ what: string; spec: typeof base; names: string }> = [
      { what: "description reworded", spec: { ...base!, description: `${base!.description} (drifted)` }, names: "tool 'run_shell' field description" },
      { what: "a parameter removed", spec: { ...base!, parameters: withoutKey(base!.parameters, "properties", "background") }, names: "$.tools[run_shell].parameters.properties" },
      { what: "required list changed", spec: { ...base!, parameters: { ...base!.parameters, required: ["command", "workdir"] } }, names: "$.tools[run_shell].parameters.required" },
      { what: "additionalProperties flipped", spec: { ...base!, parameters: { ...base!.parameters, additionalProperties: true } }, names: "$.tools[run_shell].parameters.additionalProperties" },
      { what: "a renamed tool", spec: { ...base!, name: "shell_run" }, names: "does not declare" },
    ];
    for (const mutation of mutations) {
      const text = describeFindings(compareToolSpecs(CONTRACT, [mutation.spec!]));
      expect(text, `${mutation.what}: the parity check stayed green`).not.toBe("");
      expect(text, `${mutation.what}: the finding never names '${mutation.names}' (${text})`).toContain(mutation.names);
    }
  });
});

/** Drop one nested key without mutating the frozen spec. */
function withoutKey(parameters: Record<string, unknown>, parent: string, key: string): Record<string, unknown> {
  const inner = { ...(parameters[parent] as Record<string, unknown>) };
  delete inner[key];
  return { ...parameters, [parent]: inner };
}

/** A sandbox that never runs: the specs are read, no command is executed. */
function stubSandbox(): Sandbox {
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024, workdir: "/tmp", root: "/tmp", extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W744: the spec check never executes a command"));
  return { config, run: refuse, spawn: refuse };
}
