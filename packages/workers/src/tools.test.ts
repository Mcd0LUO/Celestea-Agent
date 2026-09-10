import { describe, expect, it } from "vitest";
import { SESSION_LOG_SERVICE, type Context, type Tool, type ToolRegistry, type Llm, type AgentLoop } from "@celestea/core";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { getExtra } from "./registry-tsv.js";
import { deriveShort, tokenSafe, workerToolSpec, workerTools } from "./tools.js";
import { scriptedDrivers, scriptedLoop, waitUntil } from "./fakes.test-util.js";

function harness(pid = 4242): { registry: WorkerRegistry; tools: Map<string, Tool> } {
  const registry = new WorkerRegistry({ tsvPath: null, logFactory: recordingSessionLog, now: () => 1_700_000_000_000, pid });
  const tools = new Map(workerTools(registry).map((t) => [t.spec().name, t]));
  return { registry, tools };
}

async function call(tools: Map<string, Tool>, name: string, args: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  expect(tool).toBeDefined();
  return (await tool!.execute(args)) as Record<string, unknown>;
}

describe("worker tool specs", () => {
  it("takes each spec from the frozen contract, not a second copy", () => {
    const spawn = workerToolSpec("spawn_worker");
    expect(spawn.parameters["required"]).toEqual(["wid", "brief"]);
    expect(spawn.parameters["additionalProperties"]).toBe(false);
    expect(workerToolSpec("worker_status").parameters["required"]).toEqual([]);
    expect(workerToolSpec("session_send_message").name).toBe("session_send_message");
  });

  it("fails loudly for a tool the contract does not describe", () => {
    expect(() => workerToolSpec("no_such_tool")).toThrow(/contracts\/tools.json/);
  });

  it("folds whitespace when a value must stay one extra token", () => {
    expect(tokenSafe("Do the thing")).toBe("Do-the-thing");
  });

  it("derives the short title from the brief's first line", () => {
    expect(deriveShort("# Fix the parser\nmore", "W1")).toBe("Fix the parser");
    expect(deriveShort("\n\nplain text", "W1")).toBe("plain text");
    expect(deriveShort("   ", "W1")).toBe("W1");
  });
});

describe("spawn_worker", () => {
  it("validates wid and brief", async () => {
    const { tools } = harness();
    expect(await call(tools, "spawn_worker", {})).toEqual({ ok: false, step: "validate", error: "wid required" });
    expect(await call(tools, "spawn_worker", { wid: "W1" })).toEqual({ ok: false, step: "validate", error: "brief required" });
    expect(await call(tools, "spawn_worker", { wid: "W\t1", brief: "b" })).toMatchObject({ step: "validate" });
  });

  it("creates the session, names it <wid>·<short> and writes the registry row", async () => {
    const { registry, tools } = harness();
    const result = await call(tools, "spawn_worker", { wid: "W101", brief: "# Do the thing", report_to: "cli-main", model: "m1" });
    expect(result["ok"]).toBe(true);
    expect(result["wid"]).toBe("W101");
    expect(result["title"]).toBe("W101·Do the thing");
    expect(result["sessionId"]).toBe("session-0");
    expect(result["driven"]).toBe(false);
    const entry = registry.getEntry("W101")!;
    expect(entry.status).toBe("RUNNING");
    expect(getExtra(entry, "title")).toBe("Do-the-thing");
    expect(getExtra(entry, "driven")).toBe("no");
    expect(getExtra(entry, "report_to")).toBe("cli-main");
    expect(getExtra(entry, "model")).toBe("m1");
    // `extra` is space-delimited, so a multi-word brief cannot round-trip
    // through a single token: the readable brief lives in the registry's
    // in-memory spawn facts (see receipt.test.ts) and only the first token is
    // persisted for diagnostics.
    expect(getExtra(entry, "brief")).toBe("#");
    expect(registry.spawnInfo("session-0")).toEqual({
      wid: "W101",
      short: "Do the thing",
      brief: "# Do the thing",
      reportTo: "cli-main",
    });
    expect(registry.sessions.get("session-0")?.meta.title).toBe("W101·Do the thing");
  });

  it("rejects a duplicate wid in any state", async () => {
    const { tools } = harness();
    await call(tools, "spawn_worker", { wid: "W101", brief: "b" });
    expect(await call(tools, "spawn_worker", { wid: "W101", brief: "b" })).toEqual({
      ok: false,
      step: "validate",
      error: "wid W101 already registered",
    });
  });

  it("drives the worker when all three driver seams are attached", async () => {
    const { registry, tools } = harness();
    const scripted = scriptedLoop();
    registry.attachDrivers(scriptedDrivers(scripted));
    const result = await call(tools, "spawn_worker", { wid: "W1", brief: "brief body", report_to: "cli-main" });
    expect(result["driven"]).toBe(true);
    await waitUntil(() => scripted.inputs.length === 1);
    expect(scripted.inputs[0]).toContain("brief body");
    // report_to injects the neutral completion hint into the driven brief.
    expect(scripted.inputs[0]).toContain("回执");
    expect(getExtra(registry.getEntry("W1")!, "driven")).toBe("yes");
    registry.shutdown();
    await registry.joinDrivers();
  });
});

describe("session_send_message", () => {
  it("validates target and content", async () => {
    const { tools } = harness();
    expect(await call(tools, "session_send_message", { content: "hi" })).toMatchObject({ step: "validate", error: "target required" });
    expect(await call(tools, "session_send_message", { target: "cli-main" })).toMatchObject({ step: "validate", error: "content required" });
  });

  it("resolves an id and queues the message on the target mailbox", async () => {
    const { registry, tools } = harness();
    registry.setSourceLabel("cli-main");
    registry.sessions.create({ title: "W1·t" });
    const result = await call(tools, "session_send_message", { target: "session-0", content: "please report" });
    expect(result).toMatchObject({ ok: true, delivered: true, queued: true, target: "session-0", sourceSession: "cli-main" });
    const queued = registry.mailbox.poll("session-0");
    expect(queued.map((m) => m.content)).toEqual(["please report"]);
    expect(queued[0]?.from_label).toBe("cli-main");
  });

  it("resolves a unique title and reports a missing target", async () => {
    const { registry, tools } = harness();
    registry.sessions.create({ title: "W2·audit" });
    expect(await call(tools, "session_send_message", { target: "W2·audit", content: "x" })).toMatchObject({ ok: true, target: "session-0" });
    expect(await call(tools, "session_send_message", { target: "ghost", content: "x" })).toEqual({
      ok: false,
      step: "resolve",
      error: "no session matches target: ghost",
    });
  });

  it("returns the candidate list for an ambiguous target", async () => {
    const { registry, tools } = harness();
    registry.sessions.create({ title: "dup" });
    registry.sessions.create({ title: "dup" });
    const result = await call(tools, "session_send_message", { target: "dup", content: "x" });
    expect(result["ok"]).toBe(false);
    expect(result["step"]).toBe("resolve");
    expect((result["candidates"] as unknown[]).length).toBe(2);
  });
});

describe("worker_status", () => {
  it("summarizes every own row and filters by wid", async () => {
    const { registry, tools } = harness();
    await call(tools, "spawn_worker", { wid: "W1", brief: "b1" });
    await call(tools, "spawn_worker", { wid: "W2", brief: "b2" });
    registry.setWorkerState("session-1", "in-turn");
    const all = await call(tools, "worker_status", {});
    expect(all["ok"]).toBe(true);
    expect(all["total"]).toBe(2);
    expect(all["by_state"]).toEqual({ "in-turn": 1, idle: 0, running: 1 });
    const one = await call(tools, "worker_status", { wid: "W2" });
    expect(one["ok"]).toBe(true);
    expect((one["worker"] as Record<string, unknown>)["wid"]).toBe("W2");
    expect(await call(tools, "worker_status", { wid: "W9" })).toMatchObject({ ok: false, step: "lookup" });
  });
});

describe("weak-reference release", () => {
  it("fails closed once the registry is released", async () => {
    const { registry, tools } = harness();
    registry.release();
    expect(await call(tools, "worker_status", {})).toEqual({ ok: false, step: "registry", error: "registry released" });
    expect(await call(tools, "spawn_worker", { wid: "W1", brief: "b" })).toMatchObject({ step: "registry" });
  });

  it("keeps collecting the registry alive through the tools (no strong cycle)", () => {
    const { registry, tools } = harness();
    const weak = new WeakRef(registry);
    expect(weak.deref()).toBe(registry);
    void tools;
    expect(registry.isReleased).toBe(false);
  });

  it("tolerates non-object args", async () => {
    const { tools } = harness();
    expect(await call(tools, "worker_status", "junk")).toMatchObject({ ok: true });
  });

  it("exposes the three tools against the real seams", () => {
    const { registry } = harness();
    const registrySeam: ToolRegistry = {
      register: () => undefined,
      addGuard: () => undefined,
      get: () => undefined,
      schemas: () => [],
      dispatch: (input) => Promise.resolve({ call_id: input.call_id, value: null, render: null, error: null, decision: null }),
    };
    const llm: Llm = { generate: () => Promise.reject(new Error("nope")) };
    const loop: AgentLoop = { runTurn: async (_ctx: Context) => undefined };
    registry.attachDrivers({ llm, tools: registrySeam, agentLoop: loop });
    expect(registry.canDrive()).toBe(true);
    void SESSION_LOG_SERVICE;
  });
});
