import { describe, expect, it } from "vitest";
import { Context, TOOL_REGISTRY_SERVICE } from "@celestea/core";
import { createWorkerRegistry, workersPlugin } from "./plugin.js";
import { WORKER_REGISTRY_SERVICE, WorkerRegistry } from "./registry.js";
import { FakeToolRegistry } from "./fakes.test-util.js";

describe("workersPlugin", () => {
  it("provides the registry under the frozen token and registers the three tools", () => {
    const ctx = Context.root();
    const tools = new FakeToolRegistry();
    ctx.provide(TOOL_REGISTRY_SERVICE, tools);
    ctx.provide(WORKER_REGISTRY_SERVICE, new WorkerRegistry({ tsvPath: null }));
    workersPlugin({ name: "w1" }).mount(ctx);
    expect(ctx.get(WORKER_REGISTRY_SERVICE)).toBeInstanceOf(WorkerRegistry);
    expect(tools.order).toEqual(["spawn_worker", "session_send_message", "worker_status"]);
  });

  it("mounts over an earlier registry (last provider wins)", () => {
    const ctx = Context.root();
    const first = new WorkerRegistry({ tsvPath: null });
    const second = new WorkerRegistry({ tsvPath: null });
    workersPlugin({ registry: first }).mount(ctx);
    workersPlugin({ registry: second }).mount(ctx);
    expect(ctx.get(WORKER_REGISTRY_SERVICE)).toBe(second);
  });

  it("skips tool registration when asked, and when no registry seam exists", () => {
    const ctx = Context.root();
    const tools = new FakeToolRegistry();
    ctx.provide(TOOL_REGISTRY_SERVICE, tools);
    workersPlugin({ registerTools: false }).mount(ctx);
    expect(tools.order).toEqual([]);
    const bare = Context.root();
    expect(() => workersPlugin().mount(bare)).not.toThrow();
    expect(bare.get(WORKER_REGISTRY_SERVICE)).toBeDefined();
  });

  it("builds a registry from options (or reuses the provided handle)", () => {
    const provided = new WorkerRegistry({ tsvPath: null });
    expect(createWorkerRegistry({ registry: provided })).toBe(provided);
    const built = createWorkerRegistry({ tsvPath: null, sourceLabel: "W278", resultsDir: "/tmp/r" });
    expect(built.sourceLabel).toBe("W278");
    expect(built.resultsDir).toBe("/tmp/r");
  });
});
