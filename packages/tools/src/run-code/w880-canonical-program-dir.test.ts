/**
 * W880 real-machine: run_code's program directory lives under CELESTEA_HOME
 * (outside the workspace), and the bwrap provider binds it into the namespace so
 * the child can actually read and execute it.
 *
 * Gated on bwrap being the selected provider (the file stays green on a host
 * without bubblewrap but is a hard gate where it works).
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workspaceSubdir } from "@celestea/core";
import type { ToolExecOutcome } from "@celestea/core";

import { BWRAP_PROVIDER } from "../sandbox/bwrap-argv.js";
import { sessionSandboxConfig } from "../sandbox/config.js";
import { selectSandboxDetailed } from "../sandbox/provider.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

const home = mkdtempSync(join(tmpdir(), "w880-home-"));
const ws = mkdtempSync(join(tmpdir(), "w880-ws-"));
const env = { ...process.env, CELESTEA_HOME: home };
const runCodeDir = workspaceSubdir(ws, "run-code", { env });

let h: BrokerHarness | undefined;
let provider = "unset";

beforeAll(async () => {
  h = await startBrokerHarness({
    sandboxFor: () => {
      const selection = selectSandboxDetailed({ env, config: sessionSandboxConfig({ workspace: ws }, env) });
      provider = selection.provider;
      return selection.sandbox;
    },
  });
});

afterAll(async () => {
  if (h !== undefined) await h.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe("W880 · run_code canonical program dir (real bwrap)", () => {
  it("executes a program placed under <CELESTEA_HOME>/.../run-code", async (ctx) => {
    if (provider !== BWRAP_PROVIDER || h === undefined || !h.nodeReady) ctx.skip("bwrap or /usr/bin/node unavailable here");
    const tool = h!.mount(h!.echoRegistry());
    const code = "function main() { return { argv1: process.argv[1], cwd: process.cwd() }; }";
    const out = (await h!.run(tool, "rc-w880", { code })) as ToolExecOutcome;
    const value = out.value as { argv1: string; cwd: string };
    console.log("[W880] provider=" + provider + " run_code result=" + JSON.stringify(value));
    expect(provider).toBe(BWRAP_PROVIDER);
    expect(value.argv1.startsWith(`${runCodeDir}/run_code_`)).toBe(true);
    expect(value.cwd).toBe(ws); // bwrap --chdir <workspace>
    expect(readdirSync(runCodeDir)).toEqual([]); // cleanup removed the program
  });
});

