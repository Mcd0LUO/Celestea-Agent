/**
 * The plugin spine: Plugin / Context / EventBus / Llm / ToolGuard / AgentLoop
 * seams, each mirroring a Rust module in `crates/core/src`.
 */

import { describe, expect, it } from "vitest";
import { defaultAgentConfig } from "./agent.js";
import { Context } from "./context.js";
import { createEventBus } from "./event-bus.js";
import { LlmRegistry, type Llm } from "./llm.js";
import { definePlugin, mountPlugins, NamedRegistry, pluginNames } from "./plugin.js";
import { isTerminalStreamEvent, LlmError, type StreamEvent } from "./stream.js";

describe("Context", () => {
  it("provides and gets by token, replacing on re-provide", () => {
    const ctx = Context.root();
    ctx.provide("svc", 42);
    expect(ctx.get("svc")).toBe(42);
    ctx.provide("svc", 43);
    expect(ctx.get<number>("svc")).toBe(43);
    expect(ctx.has("missing")).toBe(false);
  });

  it("keys by token identity (a class constructor works as a token)", () => {
    class Service {}
    const ctx = Context.root();
    const svc = new Service();
    ctx.provide(Service, svc);
    expect(ctx.get(Service)).toBe(svc);
  });

  it("scopes: the child falls back to the parent and can shadow it", () => {
    const parent = Context.root();
    parent.provide("name", "parent");
    parent.provide("n", 7);
    const child = parent.scoped();
    expect(child.get("name")).toBe("parent");
    child.provide("n", 9);
    expect(child.get<number>("n")).toBe(9);
    expect(parent.get<number>("n")).toBe(7);
    expect(child.localTokens()).toEqual(["service:n"]);
  });

  it("require throws for a missing service", () => {
    expect(() => Context.root().require("nope")).toThrow(/service not provided/);
  });
});

describe("Plugin", () => {
  it("mounts in order and reports names", () => {
    const ctx = Context.root();
    const seen: string[] = [];
    const a = definePlugin("a", () => seen.push("a"));
    const b = definePlugin("b", (c) => {
      seen.push("b");
      c.provide("b", true);
    });
    mountPlugins(ctx, [a, b]);
    expect(seen).toEqual(["a", "b"]);
    expect(pluginNames([a, b])).toEqual(["a", "b"]);
    expect(ctx.get("b")).toBe(true);
  });
});

describe("NamedRegistry", () => {
  it("applies patch semantics: last registration wins", () => {
    const reg = new NamedRegistry<number>();
    reg.insert("k", 1);
    reg.insert("k", 2);
    reg.insert("other", 3);
    expect(reg.get("k")).toBe(2);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.size).toBe(3);
    expect(reg.entries().map((e) => e.name)).toEqual(["k", "k", "other"]);
  });
});

describe("EventBus", () => {
  it("broadcasts only to listeners of the same event type", () => {
    const bus = createEventBus();
    let sum = 0;
    bus.on<number>("ping", (e) => (sum += e));
    bus.emit("ping", 3);
    bus.emit("ping", 4);
    bus.emit("pong", 100);
    expect(sum).toBe(7);
  });

  it("bail short-circuits in registration order and treats null as an answer", () => {
    const bus = createEventBus();
    const hits: string[] = [];
    bus.bail<{ path: string }, string>("req", (e) => {
      hits.push("first");
      return e.path === "blocked" ? "denied" : undefined;
    });
    bus.bail<{ path: string }, string>("req", () => {
      hits.push("second");
      return "fallback";
    });
    expect(bus.runBail("req", { path: "blocked" })).toBe("denied");
    expect(hits).toEqual(["first"]);
    expect(bus.runBail("req", { path: "ok" })).toBe("fallback");

    const other = createEventBus();
    other.bail<number, string>("n", () => null as unknown as string);
    expect(other.runBail("n", 1)).toBeNull();
  });

  it("returns undefined when every bail listener passes", () => {
    const bus = createEventBus();
    bus.bail<number, string>("n", () => undefined);
    bus.bail<number, string>("n", () => undefined);
    expect(bus.runBail("n", 1)).toBeUndefined();
  });

  it("waterfall transforms in registration order", () => {
    const bus = createEventBus();
    bus.waterfall<{ base: number }, number>("ctx", (e, v) => v + e.base);
    bus.waterfall<{ base: number }, number>("ctx", (_e, v) => v * 2);
    bus.waterfall<{ base: number }, number>("ctx", (_e, v) => v + 1);
    expect(bus.runWaterfall("ctx", { base: 10 }, 0)).toBe(21);
  });

  it("keeps the three modes independent and reports counts", () => {
    const bus = createEventBus();
    bus.on<number>("e", () => undefined);
    bus.bail<number, string>("e", () => undefined);
    bus.waterfall<number, number>("e", (_e, v) => v);
    expect(bus.counts("e")).toEqual({ on: 1, bail: 1, waterfall: 1 });
    expect(bus.counts("other")).toEqual({ on: 0, bail: 0, waterfall: 0 });
  });
});

describe("Llm seam", () => {
  const noop: Llm = {
    generate: () => Promise.reject(new LlmError("noop")),
  };

  it("resolves providers by name with last-registration-wins", () => {
    const reg = new LlmRegistry();
    reg.register("deepseek", noop);
    reg.register("openai", noop);
    reg.register("deepseek", noop);
    expect(reg.resolve("deepseek")).toBe(noop);
    expect(reg.resolve("anthropic")).toBeUndefined();
    expect(reg.list()).toEqual(["deepseek", "openai"]);
  });

  it("rejects with LlmError (the Rust Err arm)", async () => {
    await expect(noop.generate({} as never)).rejects.toBeInstanceOf(LlmError);
  });

  it("marks only done/failed/interrupted as terminal", () => {
    const kinds: Array<[StreamEvent, boolean]> = [
      [{ kind: "text", text: "x" }, false],
      [{ kind: "thinking", text: "x" }, false],
      [{ kind: "usage", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cache_read: 0, reasoning_tokens: 0 } }, false],
      [{ kind: "done", message: { role: "assistant", content: [{ type: "text", content: "x" }], tool_call_id: null } }, true],
      [{ kind: "failed", kindOf: "stream", message: "boom" }, true],
      [{ kind: "interrupted" }, true],
    ];
    for (const [ev, terminal] of kinds) expect(isTerminalStreamEvent(ev), ev.kind).toBe(terminal);
  });
});

describe("AgentLoop seam", () => {
  it("defaults carry the celestea identity (Rust agent.rs test)", () => {
    const cfg = defaultAgentConfig();
    expect(cfg.system_prompt).toContain("celestea");
    expect(cfg.system_prompt).toContain("concise");
    expect(cfg.system_prompt).not.toContain("helpful assistant");
    expect(cfg.max_steps).toBe(16);
    expect(cfg.context_window_tokens).toBe(65_536);
  });
});
