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

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixturePath,
  loadSessionEventSchema,
  loadTools,
  validateSessionEvent,
  type AskUserQuestionRequest,
  type Sandbox,
  type SessionEvent,
  type UserQuestionService,
} from "@celestea/core";
import { assembleTools, createAttachmentStore } from "@celestea/tools";
import { compareToolSpecs, describeFindings, uncoveredTools } from "./lib/tool-parity.js";
import { describeViolations, schemaAccepts, unsupportedKeywords, validateSchema } from "./lib/json-schema.js";
import { runProductionTurn } from "./lib/engine-corpus.js";

const SCHEMA = loadSessionEventSchema();
const CONTRACT = loadTools();
/**
 * The 7 specs `assembleTools` mounts on its own (the worker trio comes from the
 * frozen contract, and W783's `ask_user_question` is mounted only when the host
 * supplies a user-question service — see `REGISTRY_TOOLS_WITH_QUESTIONS`).
 */
const REGISTRY_TOOLS = ["http_request", "list_dir", "process_control", "read_file", "run_code", "run_shell", "write_file"];
const WORKER_TOOLS = ["send_message", "spawn_worker", "stop_worker", "worker_status"];
/** W783: the same registry once the host mounts the user-question capability. */
const QUESTION_TOOLS = ["ask_user_question"];
/** W804: mounted only once the host supplies a session attachment store. */
const READ_IMAGE_TOOL = "read_image";

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
  // W834 F07 (R3 batch A): the AttachmentRef shape is now inside the parity guard,
  // so the codec can no longer accept a bogus reference the frozen schema rejects.
  { what: "a non-hex attachment_id", row: { type: "user_message", text: "x", attachments: [{ attachment_id: "nothex", media_type: "image/png", width: 1, height: 1 }] }, names: "pattern" },
  { what: "an attachment width of 0", row: { type: "user_message", text: "x", attachments: [{ attachment_id: "ab".repeat(32), media_type: "image/png", width: 0, height: 1 }] }, names: "minimum" },
  { what: "a fractional attachment height", row: { type: "user_message", text: "x", attachments: [{ attachment_id: "ab".repeat(32), media_type: "image/png", width: 1, height: 1.5 }] }, names: "integer" },
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
    //    checks "string" (the contract enum has exactly generate|stream).
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

  it("leaves no contract tool uncovered (worker trio + W783 question tool come from elsewhere)", () => {
    // W783: 10 -> 11; W804: 11 -> 12; W7: 12 -> 13. ask_user_question, read_image
    // and the W7 worker pair are each covered by their own check below.
    expect(CONTRACT.tools).toHaveLength(13);
    expect(uncoveredTools(CONTRACT, specs, [...WORKER_TOOLS, ...QUESTION_TOOLS, READ_IMAGE_TOOL])).toEqual([]);
  });

  /**
   * W783: `ask_user_question` is OPTIONAL — `builtinTools` mounts it only when the
   * host hands over a user-question service. Both halves are asserted here, so
   * "the tool is missing" and "the tool is always mounted" both fail loudly: the
   * contract declares it, so a host that CAN ask must offer exactly this spec.
   */
  it("mounts ask_user_question when (and only when) a question service is supplied", () => {
    const without = assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas().map((s) => s.name);
    expect(without).not.toContain("ask_user_question");

    const mount = questionStub();
    const withQuestions = assembleTools({ guard: null, env: {}, sandbox: stubSandbox(), questions: mount.service }).registry.schemas();
    expect(withQuestions.map((s) => s.name)).toEqual([...REGISTRY_TOOLS, "ask_user_question"].sort());
    // The spec the model is offered must equal the frozen contract entry, field
    // for field — otherwise the tool would drift from what the contract promises.
    expect(describeFindings(compareToolSpecs(CONTRACT, withQuestions.filter((s) => s.name === "ask_user_question")))).toBe("");
  });

  /**
   * W804: `read_image` is OPTIONAL the same way: `builtinTools` mounts it only
   * when a session attachment store is supplied, and its spec must equal the
   * frozen contract entry field for field.
   */
  it("mounts read_image when (and only when) an attachment store is supplied", () => {
    const without = assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas().map((s) => s.name);
    expect(without).not.toContain(READ_IMAGE_TOOL);

    const dir = mkdtempSync(join(tmpdir(), "w804-att-"));
    const store = createAttachmentStore(join(dir, "attachments"));
    const withStore = assembleTools({ guard: null, env: {}, sandbox: stubSandbox(), attachments: store }).registry.schemas();
    expect(withStore.map((s) => s.name)).toContain(READ_IMAGE_TOOL);
    expect(describeFindings(compareToolSpecs(CONTRACT, withStore.filter((s) => s.name === READ_IMAGE_TOOL)))).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the mounted question tool parks on the service and returns its answers verbatim", async () => {
    const mount = questionStub();
    const registry = assembleTools({ guard: null, env: {}, sandbox: stubSandbox(), questions: mount.service }).registry;
    const out = await registry.dispatch({
      call_id: "q1",
      name: "ask_user_question",
      args: { questions: [{ id: "mode", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }], timeout_ms: 1000 },
    });
    expect(out.error).toBeNull();
    expect(out.value).toEqual({ answers: [{ id: "mode", selected: ["B"], custom: "自定义" }], timed_out: false });
    // The tool forwards exactly what the model asked, and its own timeout.
    expect(mount.seen).toHaveLength(1);
    expect(mount.seen[0]?.timeoutMs).toBe(1000);
    expect(mount.seen[0]?.questions[0]?.id).toBe("mode");
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

/**
 * W783: a user-question service that answers immediately, plus the request it
 * saw. The tool's job is to translate model arguments into a seam request and
 * the outcome back into a tool result; the host's own parking behaviour is
 * covered by the studio-side tests.
 */
function questionStub(): { service: UserQuestionService; seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = [];
  const service: UserQuestionService = {
    ask: (request) => {
      seen.push(request);
      return Promise.resolve({ answers: [{ id: "mode", selected: ["B"], custom: "自定义" }], timed_out: false });
    },
  };
  return { service, seen };
}

/** A sandbox that never runs: the specs are read, no command is executed. */
function stubSandbox(): Sandbox {
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxCpuSec: 600, maxOutputBytes: 1024, workdir: "/tmp", root: "/tmp", programDir: "/tmp/run-code", extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W744: the spec check never executes a command"));
  return { config, run: refuse, spawn: refuse };
}
