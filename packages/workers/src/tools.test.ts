import { describe, expect, it } from "vitest";
import { SESSION_LOG_SERVICE, type Context, type Tool, type ToolRegistry, type Llm, type AgentLoop } from "@celestea/core";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { getExtra } from "./registry-tsv.js";
import { deriveShort, tokenSafe, WORKER_TOOL_NAMES, workerToolSpec, workerTools } from "./tools.js";
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
    expect(workerToolSpec("send_message").name).toBe("send_message");
    expect(workerToolSpec("stop_worker").parameters["required"]).toEqual(["wid"]);
    // W7 red-on-old-code: the pre-W7 name is GONE from the frozen contract.
    expect(() => workerToolSpec("session_send_message")).toThrow(/contracts\/tools.json/);
  });

  it("W779: every spec carries the optional desc UI label from the contract", () => {
    for (const name of WORKER_TOOL_NAMES) {
      const spec = workerToolSpec(name);
      const properties = spec.parameters["properties"] as Record<string, { type?: string }>;
      expect(properties["desc"]?.type, name).toBe("string");
      expect(spec.parameters["required"] as string[], name).not.toContain("desc");
    }
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
      // W729: this registry declares no host mode and the spawn passed none.
      mode: null,
    });
    expect(registry.sessions.get("session-0")?.meta.title).toBe("W101·Do the thing");
  });

  it("W729: records the mode (explicit argument, else the owning session's)", async () => {
    const hinted = new WorkerRegistry({ tsvPath: null, logFactory: recordingSessionLog, now: () => 1_700_000_000_000, pid: 1, hostMode: "execution" });
    const hintedTools = new Map(workerTools(hinted).map((t) => [t.spec().name, t]));

    // 1. no argument: the worker inherits the spawning session's mode.
    await call(hintedTools, "spawn_worker", { wid: "W1", brief: "b" });
    expect(hinted.sessions.get("session-0")?.meta.mode).toBe("execution");
    expect(hinted.spawnInfo("session-0")?.mode).toBe("execution");
    expect(getExtra(hinted.getEntry("W1")!, "mode")).toBe("execution");

    // 2. an explicit mode overrides the inherited one (D3).
    await call(hintedTools, "spawn_worker", { wid: "W2", brief: "b", mode: "standard" });
    expect(hinted.sessions.get("session-1")?.meta.mode).toBe("standard");
    expect(getExtra(hinted.getEntry("W2")!, "mode")).toBe("standard");

    // 3. a registry whose session declared no mode records none (no token).
    const { registry, tools } = harness();
    await call(tools, "spawn_worker", { wid: "W3", brief: "b" });
    expect(registry.sessions.get("session-0")?.meta.mode).toBeNull();
    expect(getExtra(registry.getEntry("W3")!, "mode")).toBeNull();
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

describe("send_message", () => {
  it("validates target and content", async () => {
    const { tools } = harness();
    expect(await call(tools, "send_message", { content: "hi" })).toMatchObject({ step: "validate", error: "target required" });
    expect(await call(tools, "send_message", { target: "cli-main" })).toMatchObject({ step: "validate", error: "content required" });
  });

  it("resolves an id and queues the message on the target mailbox", async () => {
    const { registry, tools } = harness();
    registry.setSourceLabel("cli-main");
    registry.sessions.create({ title: "W1·t" });
    const result = await call(tools, "send_message", { target: "session-0", content: "please report" });
    expect(result).toMatchObject({ ok: true, delivered: true, queued: true, target: "session-0", sourceSession: "cli-main" });
    const queued = registry.mailbox.poll("session-0");
    expect(queued.map((m) => m.content)).toEqual(["please report"]);
    expect(queued[0]?.from_label).toBe("cli-main");
  });

  it("resolves a unique title and reports a missing target", async () => {
    const { registry, tools } = harness();
    registry.sessions.create({ title: "W2·audit" });
    expect(await call(tools, "send_message", { target: "W2·audit", content: "x" })).toMatchObject({ ok: true, target: "session-0" });
    expect(await call(tools, "send_message", { target: "ghost", content: "x" })).toEqual({
      ok: false,
      step: "resolve",
      error: "no session matches target: ghost",
    });
  });

  it("returns the candidate list for an ambiguous target", async () => {
    const { registry, tools } = harness();
    registry.sessions.create({ title: "dup" });
    registry.sessions.create({ title: "dup" });
    const result = await call(tools, "send_message", { target: "dup", content: "x" });
    expect(result["ok"]).toBe(false);
    expect(result["step"]).toBe("resolve");
    expect((result["candidates"] as unknown[]).length).toBe(2);
  });
});

describe("stop_worker", () => {
  it("validates wid", async () => {
    const { tools } = harness();
    expect(await call(tools, "stop_worker", {})).toMatchObject({ step: "validate", error: "wid required" });
  });

  it("writes STOPPED, aborts the driver, and keeps the row + session (只停不删)", async () => {
    const { registry, tools } = harness();
    await call(tools, "spawn_worker", { wid: "W1", brief: "b1" });
    const sid = registry.sessionFor("W1");
    expect(sid).not.toBe("");
    const result = await call(tools, "stop_worker", { wid: "W1", reason: "operator halt" });
    expect(result).toMatchObject({ ok: true, wid: "W1", status: "STOPPED", sessionId: sid });
    const row = registry.getEntry("W1")!;
    expect(row.status).toBe("STOPPED");
    expect(getExtra(row, "stop")).toBe("operator-halt");
    expect(getExtra(row, "state")).toBe("idle");
    expect(registry.getEntry("W1")).toBeDefined();
    expect(registry.sessions.get(sid)).toBeDefined();
  });

  it("rejects an unknown or already-terminal worker with a lookup failure", async () => {
    const { registry, tools } = harness();
    await call(tools, "spawn_worker", { wid: "W1", brief: "b1" });
    expect(await call(tools, "stop_worker", { wid: "W9" })).toMatchObject({ ok: false, step: "lookup" });
    await call(tools, "stop_worker", { wid: "W1" });
    expect(await call(tools, "stop_worker", { wid: "W1" })).toMatchObject({ ok: false, step: "lookup" });
  });

  it("freezes STOPPED and refuses to rewrite a DONE/FAILED row", async () => {
    const { registry, tools } = harness();
    await call(tools, "spawn_worker", { wid: "W1", brief: "b1" });
    await call(tools, "stop_worker", { wid: "W1", reason: "halt" });
    expect(registry.getEntry("W1")!.status).toBe("STOPPED");
    // a second stop is a lookup no-op and must NOT rewrite the frozen row.
    expect(await call(tools, "stop_worker", { wid: "W1", reason: "again" })).toMatchObject({ ok: false, step: "lookup" });
    expect(getExtra(registry.getEntry("W1")!, "stop")).toBe("halt");
    expect(getExtra(registry.getEntry("W1")!, "ended_at")).not.toBeNull();
    // DONE and FAILED are terminal too.
    await call(tools, "spawn_worker", { wid: "W2", brief: "b2" });
    registry.finalize("W2", { ok: true });
    expect(await call(tools, "stop_worker", { wid: "W2" })).toMatchObject({ ok: false, step: "lookup" });
    expect(registry.getEntry("W2")!.status).toBe("DONE");
    await call(tools, "spawn_worker", { wid: "W3", brief: "b3" });
    registry.finalize("W3", { ok: false, reason: "boom" });
    expect(await call(tools, "stop_worker", { wid: "W3" })).toMatchObject({ ok: false, step: "lookup" });
    expect(registry.getEntry("W3")!.status).toBe("FAILED");
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

  it.skipIf(typeof (globalThis as unknown as { gc?: unknown }).gc !== "function")(
    "lets the registry be collected once the tools are gone (no strong cycle)",
    async () => {
      // W839 (R3 B8 / W818-P2-1): the old case kept registry + tools in local
      // strong references and never collected, so WeakRef.deref() was trivially
      // still the registry - it observed nothing. Drop every local reference,
      // force a real collection (vitest forks run with --expose-gc), then require
      // the WeakRef to go empty; anything pinning the registry keeps it alive.
      const weak = ((): WeakRef<WorkerRegistry> => {
        const { registry, tools } = harness();
        const ref = new WeakRef(registry);
        expect(ref.deref()).toBe(registry);
        void tools;
        return ref;
      })();
      const forceGc = (globalThis as unknown as { gc?: () => void }).gc;
      // NB: do NOT call weak.deref() inside the loop: the temporary strong
      // reference from deref() would keep the target alive across every gc round
      // (verified: a control object survives exactly that shape). Collect first,
      // then observe once.
      for (let i = 0; i < 25; i++) {
        forceGc?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(weak.deref()).toBeUndefined();
    },
  );

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
