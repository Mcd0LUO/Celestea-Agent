/**
 * Plugin-mount tests: the loop provides itself into a Context under
 * `AGENT_LOOP_SERVICE` (rule 3: everything is a plugin) and resolves the driver
 * seams lazily at turn start.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_SERVICE,
  assistantText,
  defaultAgentConfig,
  mountPlugins,
  type AgentLoop,
  type Message,
} from "@celestea/core";
import {
  contextWith,
  eventsOfType,
  FakeSessionLog,
  FakeToolRegistry,
  makeLoop,
  ScriptLlm,
} from "./fakes.test-util.js";
import { DefaultAgentLoop } from "./loop.js";
import { agentLoopPlugin, createAgentLoop } from "./plugin.js";

/** `StreamEvent::Done(message)`. */
function doneText(text: string): Message {
  return assistantText(text);
}

describe("agentLoopPlugin", () => {
  it("provides a DefaultAgentLoop under the well-known service token", () => {
    const ctx = contextWith({
      llm: new ScriptLlm([{ kind: "done", message: doneText("hi") }]),
      session: new FakeSessionLog(),
      registry: new FakeToolRegistry(),
    });

    mountPlugins(ctx, [agentLoopPlugin(defaultAgentConfig())]);

    expect(ctx.get<AgentLoop>(AGENT_LOOP_SERVICE)).toBeInstanceOf(DefaultAgentLoop);
    expect(agentLoopPlugin(defaultAgentConfig()).name()).toBe("celestea.agent-loop.DefaultAgentLoop");
    expect(agentLoopPlugin(defaultAgentConfig(), {}, "custom.loop").name()).toBe("custom.loop");
  });

  it("drives a full turn through the loop resolved from the Context", async () => {
    const session = new FakeSessionLog();
    const ctx = contextWith({
      llm: new ScriptLlm([{ kind: "text", text: "hi" }, { kind: "done", message: doneText("hi") }]),
      session,
      registry: new FakeToolRegistry(),
    });
    mountPlugins(ctx, [agentLoopPlugin({ ...defaultAgentConfig(), max_steps: 4 })]);

    const loop = ctx.require<AgentLoop>(AGENT_LOOP_SERVICE);
    await loop.runTurn(ctx, "hello");

    expect(eventsOfType(session, "assistant_message").map((e) => e.text)).toEqual(["hi"]);
    expect(eventsOfType(session, "turn_end")).toHaveLength(1);
  });

  it("lets a later mount patch an earlier loop (last registration wins)", () => {
    const ctx = contextWith({
      llm: new ScriptLlm([{ kind: "done", message: doneText("hi") }]),
      session: new FakeSessionLog(),
      registry: new FakeToolRegistry(),
    });
    const replacement = makeLoop({ max_steps: 99 });

    mountPlugins(ctx, [agentLoopPlugin(defaultAgentConfig()), agentLoopPlugin(defaultAgentConfig(), {})]);
    ctx.provide(AGENT_LOOP_SERVICE, replacement);

    expect(ctx.get<AgentLoop>(AGENT_LOOP_SERVICE)).toBe(replacement);
  });

  it("builds a loop through the createAgentLoop factory", () => {
    const loop = createAgentLoop(defaultAgentConfig());
    expect(loop).toBeInstanceOf(DefaultAgentLoop);
    expect(loop.agentConfig.max_steps).toBe(defaultAgentConfig().max_steps);
  });
});
