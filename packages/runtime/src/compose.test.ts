import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_SERVICE,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  definePlugin,
  type AgentConfig,
  type Context,
  type Plugin,
} from "@celestea/core";
import { WORKER_REGISTRY_SERVICE, workerTools } from "@celestea/workers";
import { agentConfigFromProfile, MIN_STEPS } from "./agent-config.js";
import { compose } from "./compose.js";
import { ComposeError } from "./errors.js";
import { sanitizeConfigJson, sanitizeProfile } from "./sanitize.js";
import { fakeLlm, fakeLoop, memoryLog, memorySessionPlugin, recordingRegistryPlugin, testProfile } from "./fakes.test-util.js";

/** A plugin that records its own mount and provides `value` under `token`. */
function markerPlugin(name: string, token: string, value: unknown, log: string[]): Plugin {
  return definePlugin(name, (ctx) => {
    log.push(name);
    ctx.provide(token, value);
  });
}

const WORKER_NAMES = ["spawn_worker", "session_send_message", "worker_status"];

describe("compose", () => {
  it("mounts plugins in order and lets the last provider win the token", () => {
    const order: string[] = [];
    const runtime = compose({
      profile: testProfile(),
      plugins: [
        memorySessionPlugin(memoryLog(), "p1"),
        markerPlugin("p1", "test.marker", "first", order),
        markerPlugin("p2", "test.marker", "second", order),
      ],
      workers: false,
    });
    expect(order).toEqual(["p1", "p2"]);
    expect(runtime.ctx.get<string>("test.marker")).toBe("second");
    expect(runtime.pluginNames).toEqual(["p1", "p1", "p2"]);
  });

  it("mounts the default worker wiring last so its three tools land in the registry", () => {
    const tools = recordingRegistryPlugin();
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(), tools.plugin],
      workers: { tsvPath: null },
    });
    expect(runtime.pluginNames).toEqual(["test.session", "test.tools", "celestea.runtime.workers"]);
    for (const name of WORKER_NAMES) expect(tools.registered).toContain(name);
    expect(runtime.workers).not.toBeNull();
    expect(tools.registry.get("worker_status")).toBeDefined();
  });

  it("fails loudly when no plugin provides a session log", () => {
    expect(() => compose({ profile: testProfile(), workers: false })).toThrow(ComposeError);
  });

  it("resolves the optional seams and leaves them null when absent", () => {
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], workers: false });
    expect(runtime.session).toBeDefined();
    expect(runtime.llm).toBeNull();
    expect(runtime.tools).toBeNull();
    expect(runtime.agentConfig.model).toBe("deepseek-chat");
  });

  it("resolves llm / tools / agentLoop when plugins provide them", () => {
    const tools = recordingRegistryPlugin();
    const loop = fakeLoop(() => ({ text: "hi" }));
    const runtime = compose({
      profile: testProfile(),
      plugins: [
        memorySessionPlugin(),
        tools.plugin,
        definePlugin("llm", (ctx) => ctx.provide(LLM_SERVICE, fakeLlm("x"))),
        definePlugin("loop", (ctx) => ctx.provide(AGENT_LOOP_SERVICE, { runTurn: async () => undefined })),
      ],
      loopFactory: loop.factory,
      workers: false,
    });
    expect(runtime.llm).toBeNull();
    expect(runtime.tools?.schemas()).toEqual([]);
    expect(runtime.pluginNames).toContain("loop");
  });

  it("derives the agent config from the profile with the step floor", () => {
    const cfg = agentConfigFromProfile(testProfile({ max_steps: 0, max_parallel_tool_calls: 7 }));
    expect(cfg.max_steps).toBe(MIN_STEPS);
    expect(cfg.max_parallel_tool_calls).toBe(7);
    expect(agentConfigFromProfile(testProfile({ max_steps: 12 })).max_steps).toBe(12);
  });

  it("keeps the profile's identity prompt in the loop config", () => {
    const runtime = compose({ profile: testProfile({ system_prompt: "You are celestea." }), plugins: [memorySessionPlugin()], workers: false });
    expect(runtime.agentConfig.system_prompt).toBe("You are celestea.");
  });

  it("shares the injected usage tracker and status tracker services", () => {
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], workers: false });
    const same: Context = runtime.ctx;
    expect(same.get("celestea.runtime.UsageTracker")).toBe(runtime.usage);
    expect(same.get("celestea.runtime.StatusTracker")).toBe(runtime.status);
    expect(same.get("celestea.core.EventBus")).toBeDefined();
  });
});

describe("sanitized config", () => {
  it("whitelists the profile and never carries a key value", () => {
    const profile = testProfile({ api_key_env: "DEEPSEEK_API_KEY", api_key_file: "/home/u/.key" });
    const cfg = sanitizeProfile(profile);
    expect(cfg.api_key_env).toBe("DEEPSEEK_API_KEY");
    expect(cfg.has_api_key_file).toBe(true);
    const json = sanitizeConfigJson(cfg);
    expect(json).toContain("deepseek-chat");
    expect(json).not.toContain("/home/u/.key");
    expect(Object.keys(cfg)).not.toContain("api_key");
  });

  it("redacts a credential that sneaks into base_url", () => {
    const json = sanitizeConfigJson(sanitizeProfile(testProfile({ base_url: "http://h/v1?token=abcdef0123456789" })));
    expect(json).not.toContain("abcdef0123456789");
  });
});

describe("worker tools registration", () => {
  it("registers exactly the three contract specs", () => {
    const tools = workerTools(compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin()],
      workers: { tsvPath: null },
    }).workers!);
    expect(tools.map((t) => t.spec().name)).toEqual([...WORKER_NAMES]);
    expect(tools[0]?.spec().parameters["required"]).toEqual(["wid", "brief"]);
  });

  it("provides the worker registry service under the frozen token", () => {
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], workers: { tsvPath: null } });
    expect(runtime.ctx.get(WORKER_REGISTRY_SERVICE)).toBe(runtime.workers);
  });
});

describe("loop bindings", () => {
  it("hands the loop its config, signal, sink and usage recorder", async () => {
    const loop = fakeLoop(() => ({ text: "hello" }));
    const runtime = compose({
      profile: testProfile({ model: "m1" }),
      plugins: [memorySessionPlugin()],
      loopFactory: loop.factory,
      agentConfig: { max_steps: 5 } as Partial<AgentConfig>,
      workers: false,
    });
    await runtime.runTurn("go");
    expect(loop.record.configs[0]?.model).toBe("m1");
    expect(loop.record.configs[0]?.max_steps).toBe(5);
    expect(loop.record.signals[0]).toBeInstanceOf(AbortSignal);
    expect(loop.record.usage[0]).toBe(runtime.usage);
  });

  it("resolves a Context-mounted loop when no factory is passed", async () => {
    const seen: string[] = [];
    const plugin = definePlugin("loop", (ctx) =>
      ctx.provide(AGENT_LOOP_SERVICE, { runTurn: async (_c: Context, input: string) => void seen.push(input) }),
    );
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(), plugin, definePlugin("tools", (c) => c.provide(TOOL_REGISTRY_SERVICE, recordingRegistryPlugin().registry))],
      workers: false,
    });
    await runtime.runTurn("from-context");
    expect(seen).toEqual(["from-context"]);
  });
});
