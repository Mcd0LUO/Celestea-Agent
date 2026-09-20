/**
 * W880 real-machine e2e: a full HTTP Studio turn whose scripted model calls
 * run_code, with CELESTEA_HOME pinned to a temp data root. The real engine, the
 * real tool registry and the real sandbox run; only the model is offline.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import { workspaceSubdir } from "@celestea/core";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, readSessionLog, turns, waitIdle } from "./test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const CODE = "function main() { return { argv1: process.argv[1], cwd: process.cwd() }; }";

describe("W880 · HTTP turn runs run_code from CELESTEA_HOME", () => {
  it("places and executes the program under <home>/workspaces/<ws>/run-code", async () => {
    const home = mkdtempSync(join(tmpdir(), "w880-e2e-home-"));
    const h = makeEngineHarness({
      sessions: { s1: turns(1) },
      env: { CELESTEA_HOME: home },
      llm: { script: [{ tool_calls: [{ id: "call-1", name: "run_code", args: { code: CODE } }] }] },
    });
    harnesses.push(h);
    try {
      await activate(h, "sample-ws/s1");
      const started = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "go" }));
      expect(started.status).toBe(202);
      await waitIdle(h);
      const runDir = workspaceSubdir(h.workspace, "run-code", { env: { CELESTEA_HOME: home } });
      const events = parseSessionJsonl(readSessionLog(h, "s1")).events;
      const result = events.find((e) => e.type === "tool_result");
      expect(result).toBeDefined();
      const value = (result as { value: { argv1: string; cwd: string } }).value;
      console.log("[W880 e2e] run_code result=" + JSON.stringify(value) + " runDir=" + runDir);
      expect(value.argv1.startsWith(join(runDir, "run_code_"))).toBe(true);
      expect(value.cwd).toBe(h.workspace);
      expect(readdirSync(runDir)).toEqual([]);
      expect(existsSync(join(h.workspace, ".celestea"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

