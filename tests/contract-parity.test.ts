// @vitest-environment node
/**
 * W896 测试收敛：合并 2 个同环境、同夹具的分域测试文件。
 * 来源（纯搬运，用例与断言逐字未改）：
 *   - tests/contract-parity.test.ts
 *   - tests/contract-sse-parity.test.ts
 *
 * 为什么合并：这些小文件各只装 3–8 条用例，却各自付一次 fork 启动 + 环境构建
 * （实测 ~426ms/文件）。合并后仍由同一 vitest project 收集，覆盖不变。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { assembleTools, createAttachmentStore } from "@celestea/tools";
import { compareToolSpecs, describeFindings, uncoveredTools } from "./lib/tool-parity.js";
import { describeViolations, schemaAccepts, unsupportedKeywords, validateSchema } from "./lib/json-schema.js";
import { runProductionTurn, productionMapper } from "./lib/engine-corpus.js";
import { loadSse, type LoopEvent } from "@celestea/core";
import { questionFrame } from "@celestea/runtime";
import { loopEventToSse } from "@celestea/agent-loop";
import { createStudioBus } from "@celestea/studio";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { checkPayload, describeFrameViolations, descriptorTable, payloadKeyTable } from "./lib/sse-parity.js";

/* ===== contract-parity.test.ts ===== */
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

const SCHEMA = loadSessionEventSchema();
const CONTRACT = loadTools();
/**
 * The 8 specs `assembleTools` mounts on its own (the worker trio comes from the
 * frozen contract, W783's `ask_user_question` is mounted only when the host
 * supplies a user-question service, W804's `read_image` only with an attachment
 * store, and W884's `load_skill` is always mounted). F4's browser tools ride
 * that same attachment store, so they are conditional too.
 */
const REGISTRY_TOOLS = ["forget", "http_request", "list_dir", "load_skill", "process_control", "read_file", "remember", "run_code", "run_shell", "write_file"];
/** F4 step 2b: mounted with the attachment store (screenshots ride its chain). */
const BROWSER_TOOLS = ["browser_act", "browser_open"];
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

  // W881: the real-session fixtures were removed from the public repo; the
  // retained synthetic golden logs total ~62 rows, so the corpus is no longer
  // >500 lines but must still be non-trivial.
  it.skipIf(!HAS_FIXTURES)("accepts every line of every golden session log (golden JSONL)", () => {
    expect(rows.length).toBeGreaterThan(50);
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

describe("W744 · all 8 builtin tool specs match the implementation registry", () => {
  const specs = assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas();

  it("the registry of record holds exactly the 8 contract tools", () => {
    expect(specs.map((s) => s.name)).toEqual(REGISTRY_TOOLS);
  });

  it("compares name + description + parameters of 8/8 against contracts/tools.json", () => {
    const findings = compareToolSpecs(CONTRACT, specs);
    expect(describeFindings(findings)).toBe("");
    expect(specs).toHaveLength(REGISTRY_TOOLS.length);
  });

  it("leaves no contract tool uncovered (worker trio + W783 question tool come from elsewhere)", () => {
    // W783: 10 -> 11; W804: 11 -> 12; W7: 12 -> 13; W884: 13 -> 14; F4: 14 -> 16;
    // B2: 16 -> 18. ask_user_question, read_image, the browser pair and the W7
    // worker tools are each covered by their own check below; remember/forget are
    // in REGISTRY_TOOLS (always mounted like load_skill).
    expect(CONTRACT.tools).toHaveLength(18);
    expect(uncoveredTools(CONTRACT, specs, [...WORKER_TOOLS, ...QUESTION_TOOLS, READ_IMAGE_TOOL, ...BROWSER_TOOLS])).toEqual([]);
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

  /**
   * F4 step 2b: browser_open/browser_act are mounted with the SAME condition as
   * read_image (the session attachment store: the screenshot rides the existing
   * image chain), and their specs must equal the frozen contract entries.
   */
  it("mounts browser_open/browser_act when (and only when) an attachment store is supplied", () => {
    const without = assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas().map((s) => s.name);
    expect(without).not.toContain("browser_open");
    expect(without).not.toContain("browser_act");

    const dir = mkdtempSync(join(tmpdir(), "f4b-browser-"));
    const store = createAttachmentStore(join(dir, "attachments"));
    const withStore = assembleTools({ guard: null, env: {}, sandbox: stubSandbox(), attachments: store }).registry.schemas();
    for (const name of BROWSER_TOOLS) expect(withStore.map((s) => s.name)).toContain(name);
    expect(describeFindings(compareToolSpecs(CONTRACT, withStore.filter((s) => BROWSER_TOOLS.includes(s.name))))).toBe("");
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
  // W891: "/tmp" is POSIX-only; the host temp dir exists on every platform.
  const base = tmpdir();
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxCpuSec: 600, maxOutputBytes: 1024, workdir: base, root: base, programDir: join(base, "run-code"), extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W744: the spec check never executes a command"));
  return { config, run: refuse, spawn: refuse };
}

/* ===== contract-sse-parity.test.ts ===== */
/**
 * W744 (audit D3) — the SSE payload contract is asserted on the PRODUCTION
 * mapper, not on the agent-loop copy.
 *
 * Production publishes `@celestea/runtime`'s `loopEventToFrame`: `compose()`
 * uses it whenever the host passes no `frameMapper` (compose.ts), and no host
 * does. The previous assertions lived in `packages/agent-loop/src/events.test.ts`
 * against `loopEventToSse` — a copy — so a drift in the production file was
 * invisible.
 *
 * Every check below is driven by `contracts/sse-events.json`: key sets and the
 * per-key type descriptors, so a rename, a dropped key or a wrong type fails
 * with the event name and the key in the message.
 */


const SSE = loadSse();
/** The 6 contract events a `LoopEvent` can produce (status/compact are host-emitted). */
const LOOP_EVENTS: Array<{ kind: LoopEvent["kind"]; contractName: string }> = [
  { kind: "text", contractName: "text" },
  { kind: "thinking", contractName: "thinking" },
  { kind: "tool_call", contractName: "tool" },
  { kind: "tool_result", contractName: "tool_result" },
  { kind: "turn_end", contractName: "turn_end" },
  { kind: "done", contractName: "done" },
];
/** One representative LoopEvent per kind (both branches where a union exists). */
const SAMPLES: LoopEvent[] = [
  { kind: "text", delta: "hi" },
  { kind: "thinking", delta: "hmm" },
  { kind: "tool_call", id: "c1", name: "read_file", args: { path: "x" } },
  { kind: "tool_result", callId: "c1", ok: true, value: { a: 1 }, render: null, error: null, decision: "allow" },
  { kind: "tool_result", callId: "c2", ok: false, value: null, render: null, error: "boom", decision: "deny" },
  { kind: "tool_result", callId: "c3", ok: true, value: "v", render: null, error: null, decision: null },
  { kind: "turn_end", outcome: "completed" },
  { kind: "turn_end", outcome: "cancelled" },
  { kind: "turn_end", outcome: "step_limit" },
  { kind: "turn_end", outcome: "interrupted" },
  { kind: "turn_end", outcome: { error: { kind: "generate", message: "boom" } } },
  { kind: "done", text: "x", tool_calls: [{ id: "c1", name: "t", args: {} }] },
];

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("W744 · SSE payloads: the production runtime/frames.ts vs contracts/sse-events.json", () => {
  it("maps every LoopEvent kind onto its contract event name (production mapper)", () => {
    for (const row of LOOP_EVENTS) {
      const sample = SAMPLES.find((s) => s.kind === row.kind);
      expect(sample, `no sample for LoopEvent kind '${row.kind}'`).toBeDefined();
      const frame = productionMapper(sample!);
      expect(frame.event, `LoopEvent '${row.kind}' must publish the contract event '${row.contractName}'`).toBe(row.contractName);
    }
  });

  it("checks every sample payload against the frozen key set and type table", () => {
    const failures: string[] = [];
    for (const sample of SAMPLES) {
      const frame = productionMapper(sample);
      for (const violation of checkPayload(SSE, frame.event, frame.payload)) {
        failures.push(`${violation.message} [LoopEvent kind '${sample.kind}', runtime/frames.ts]`);
      }
    }
    expect(describeFrameViolations(failures.map((f) => ({ event: "", key: null, message: f })))).toBe("");
  });

  it("the runtime's default mapper IS loopEventToFrame (compose with no frameMapper override)", async () => {
    const auto = await runProductionTurn("default mapper");
    const explicit = await runProductionTurn("default mapper", { mapper: productionMapper });
    expect(auto.frames.map((f) => f.event)).toEqual(explicit.frames.map((f) => f.event));
    expect(JSON.stringify(auto.frames)).toBe(JSON.stringify(explicit.frames));
  });

  it("checks every frame of a live engine turn (the frames GET /api/events publishes)", async () => {
    const turn = await runProductionTurn("live frames");
    expect([...new Set(turn.frames.map((f) => f.event))].sort()).toEqual(["done", "text", "thinking", "tool", "tool_result", "turn_end"]);
    const failures: string[] = [];
    for (const frame of turn.frames) {
      for (const violation of checkPayload(SSE, frame.event, frame.payload)) failures.push(`${violation.message} [live turn, runtime/frames.ts]`);
    }
    expect(failures.join("\n")).toBe("");
  });

  it("keeps the agent-loop copy in lockstep with the production mapper", () => {
    for (const sample of SAMPLES) {
      expect(loopEventToSse(sample), `agent-loop's copy drifted from runtime/frames.ts on '${sample.kind}'`).toEqual(productionMapper(sample));
    }
  });

  /**
   * W785 (E §4.4 D8): the fallback frame is a `status` frame — the event NAME set
   * is unchanged (still 9) and every field it adds is declared. This validates the
   * PRODUCTION payload shape (`real-runtime-adapter.emitFallback`) against the
   * frozen table, so widening `phase` or adding a key without touching the
   * contract fails here instead of drifting silently.
   */
  it("accepts the W785 fallback status frame without touching the event-name set", () => {
    const payload = {
      phase: "fallback",
      statusline: {},
      effective_model: "model-b",
      from: "primary",
      to: "backup",
      reason: "http_503",
      attempt: 1,
    };
    expect(describeFrameViolations(checkPayload(SSE, "status", payload))).toBe("");
    // The value that was added is a payload VALUE; the names are frozen at
    // W1528's 10 (W785 added no name, W1528 added `terminal`).
    expect(SSE.events.map((e) => e.name)).toHaveLength(10);
    expect(SSE.count).toBe(10);
  });

  it("binds all 10 contract events to a named producer (none unbound, none invented)", () => {
    const loopNames = LOOP_EVENTS.map((r) => r.contractName);
    // W783: `question` is host-emitted by the user-questions service while the
    // turn is parked — a LoopEvent can never produce it, so it is named here.
    // W1528: `terminal` is the same shape of fact — a pty's bytes come from the
    // terminal handler, and no loop is involved.
    const hostNames = ["status", "compact", "question", "terminal"];
    expect([...loopNames, ...hostNames].sort()).toEqual(SSE.events.map((e) => e.name).sort());
    expect(payloadKeyTable(SSE, "status").extensions.length).toBeGreaterThan(0);
    // W783: `question` is host-emitted but a first-class contract event, so its
    // payload is declared in the events table itself (not in payloadExtensions).
    expect(payloadKeyTable(SSE, "question").frozen).toEqual(["id", "questions", "expires_at", "timeout_ms", "session"]);
  });

  /**
   * W783: `question` has no LoopEvent producer — a parked tool call emits no
   * loop event — so the check above only proves it is DECLARED. Here the
   * PRODUCTION builder (`packages/runtime/src/frames.ts`) is executed and its
   * frame is validated against the frozen table, which is what stops the payload
   * from drifting the moment somebody edits it.
   */
  it("checks the production question frame against the contract", () => {
    const frame = questionFrame({
      session: "sample-ws/s1",
      id: "q-7",
      questions: [{ id: "mode", question: "选哪个？", options: [{ label: "A（推荐）" }, { label: "B" }] }],
      expiresAt: 1_700_000_300_000,
      timeoutMs: 300_000,
    });
    expect(frame.event).toBe("question");
    expect(describeFrameViolations(checkPayload(SSE, frame.event, frame.payload))).toBe("");
    // Every declared key must actually be produced (a key that is never written
    // is a contract promise the host does not keep).
    expect(Object.keys(frame.payload).sort()).toEqual(Object.keys(descriptorTable(SSE, "question")).sort());
  });

  it("checks the host-emitted compact payload (production endpoint) against the contract", async () => {
    const h = makeHarness({ session: { name: "s1", log: `${JSON.stringify({ type: "turn_start", id: "turn-0" })}\n` } });
    harnesses.push(h);
    const sub = h.studio.services.bus.subscribe();
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs1/compact", jsonRequest("POST"));
    expect(res.status).toBe(200);
    const frame = await sub.next();
    sub.close();
    expect(frame?.event).toBe("compact");
    const payload = payloadOf(frame);
    expect(describeFrameViolations(checkPayload(SSE, "compact", payload))).toBe("");
    expect(Object.keys(payload).sort()).toEqual(Object.keys(SSE.events.find((e) => e.name === "compact")?.payload ?? {}).sort());
  });

  it("checks the production lagged status frame (bus overflow) against the contract", async () => {
    const bus = createStudioBus({ capacity: 1 });
    const sub = bus.subscribe();
    bus.emit("text", 1, { delta: "a" }, "ws/a");
    bus.emit("text", 1, { delta: "b" }, "ws/a"); // overflows the session bucket
    // The overflow drops the session's WHOLE bucket (no replay) and hands the
    // client one lagged status, which is the next - and only - frame.
    const lagged = await sub.next();
    sub.close();
    expect(lagged?.event).toBe("status");
    const payload = payloadOf(lagged);
    expect(describeFrameViolations(checkPayload(SSE, "status", payload))).toBe("");
    expect(payload["phase"]).toBe(SSE.lagged.payload["phase"]);
    expect(payload["hint"]).toBe(SSE.lagged.payload["hint"]);
    expect(payload["dropped"]).toBe(2);
  });

  it("validates a real envelope against envelopeSchema widened by the declared W513 keys", () => {
    const bus = createStudioBus();
    const frame = bus.emit("text", 3, { delta: "x" }, "ws/s1");
    expect(validateSchema(widenedEnvelopeSchema(), frame.envelope)).toEqual([]);
    // ...and the widened schema still rejects an undeclared envelope key.
    const drifted = { ...frame.envelope, extra: 1 };
    expect(validateSchema(widenedEnvelopeSchema(), drifted).map((v) => v.path)).toContain("$.extra");
  });

  it("REJECTS a drifted mapper, naming the event and the key (the check has teeth)", () => {
    const toolResult = SAMPLES.filter((s) => s.kind === "tool_result");
    const renamed = checkPayload(SSE, "tool_result", { id: "c1", ok: true, value: null, render: null, error: null, verdict: "allow" });
    const text = describeFrameViolations(renamed);
    expect(text).toContain("missing contract payload key 'decision'");
    expect(text).toContain("verdict");
    expect(toolResult.length).toBeGreaterThan(0);

    const wrongType = checkPayload(SSE, "tool_result", { id: "c1", ok: "yes", value: null, render: null, error: null, decision: "maybe" });
    const typeText = describeFrameViolations(wrongType);
    expect(typeText).toContain("payload key 'ok'");
    expect(typeText).toContain("expected boolean");
    expect(typeText).toContain("payload key 'decision'");
    expect(typeText).toContain("'allow'|'deny'|'ask'|null");

    const droppedKey = checkPayload(SSE, "done", { text: "x" });
    expect(describeFrameViolations(droppedKey)).toContain("missing contract payload key 'tool_calls'");
  });
});

/** The frame payload as a record (`SseEnvelope.payload` is typed `unknown`). */
function payloadOf(frame: { envelope: { payload: unknown } } | null | undefined): Record<string, unknown> {
  const payload = frame?.envelope.payload;
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** `transport.envelopeSchema` widened by the declared W513 extension keys. */
function widenedEnvelopeSchema(): Record<string, unknown> {
  const transport = SSE.transport as unknown as Record<string, unknown>;
  const base = transport["envelopeSchema"] as Record<string, unknown>;
  const extensions = (transport["envelopeExtensions"] ?? {}) as Record<string, unknown>;
  const properties = { ...(base["properties"] as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(extensions)) {
    if (key !== "note" && schema !== null && typeof schema === "object") properties[key] = schema;
  }
  return { ...base, properties };
}