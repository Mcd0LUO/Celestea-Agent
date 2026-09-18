/**
 * W855 #8b: a run_code sub-call's LOG COPY is bounded by the broker's own
 * log budget, independently of the model-context retention (which skips read
 * tools). Bounding the log copy must not shrink the value the PROGRAM
 * receives: the two budgets are different surfaces.
 */
import type { ToolExecOutcome } from "@celestea/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fnTool } from "../fn-tool.js";
import { ToolRegistryImpl } from "../registry.js";
import { runCodeToolWithHandle } from "../tools/run-code.js";
import { runCodeConfig } from "./limits.js";
import { echoSpec, startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

let h: BrokerHarness;
beforeAll(async () => {
  h = await startBrokerHarness();
});
afterAll(async () => {
  if (h !== undefined) await h.cleanup();
});

describe("W855 #8b run_code sub-call log copies", () => {
  it("bounds the log copy without shrinking the value the program receives", async () => {
    if (!h.nodeReady) return;
    const full = "V".repeat(4_000);
    const registry = new ToolRegistryImpl();
    registry.register(fnTool(echoSpec("read_file"), async () => full));
    registry.register(fnTool(echoSpec("write_file"), async () => null));
    registry.register(fnTool(echoSpec("list_dir"), async () => null));
    registry.register(fnTool(echoSpec("run_shell"), async () => ({ stdout: "", exit_code: 0 })));
    const { tool, handle } = runCodeToolWithHandle({
      sandbox: h.sandbox,
      config: runCodeConfig({ maxLogBytes: 800, maxSubOutputBytes: 100_000 }),
    });
    registry.register(tool);
    handle.set(registry);
    const code = [
      '  const v = tools.read_file({ path: "/big" });',
      "  console.log(v);",
      "  return v.length;",
    ].join("\n");
    const out = (await h.run(tool, "rc-w855-logcopy", { code })) as ToolExecOutcome;
    // The program keeps the FULL value (the wire budget is 100000 > 4000).
    expect(out.value).toBe(full.length);
    // The stdout LOG COPY is bounded independently and is not the model context.
    expect(out.render).toContain("stdout logs truncated at 800 bytes");
    expect(Buffer.byteLength(out.render ?? "", "utf8")).toBeLessThanOrEqual(800 + 256);
  });
});
