/**
 * W742 §3 — the process entry stops GRACEFULLY on a real signal.
 *
 * This test runs the production entry in a child process (the only honest way to
 * observe signal handling) against a throwaway data root, and asserts the ordered
 * teardown the module documents: stop accepting traffic -> flush the grants audit
 * channel -> tear the engine down -> exit 0 by itself. Nothing here imports
 * `main.ts`: importing it would boot a second studio inside the test process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** The repo root (vitest runs from it) and the local tsx binary. */
const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Running {
  child: ChildProcess;
  output: () => string;
  exit: Promise<number | null>;
}

/** Start the real entry on an ephemeral port over a throwaway data root. */
function startStudio(): Running {
  const dir = mkdtempSync(join(tmpdir(), "w742-main-"));
  roots.push(dir);
  writeFileSync(join(dir, "workspaces.json"), JSON.stringify({ workspaces: [], active_session: null }));
  const child = spawn(TSX, [join(ROOT, "apps/studio/src/main.ts")], {
    cwd: dir,
    env: {
      ...process.env,
      STUDIO_TS_PORT: "0",
      CELESTEA_WORKSPACES_FILE: join(dir, "workspaces.json"),
      CELESTEA_PROVIDERS_FILE: join(dir, "providers.json"),
      CELESTEA_PROMPTS_FILE: join(dir, "prompts.json"),
      STUDIO_STATIC_ROOT: join(dir, "dist"),
    },
  });
  let text = "";
  const push = (chunk: Buffer): void => void (text += chunk.toString("utf8"));
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => text, exit };
}

/** Poll the child's output until it contains `needle`. */
async function until(run: Running, needle: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!run.output().includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; saw:\n${run.output()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Assert the ordered teardown: signal -> traffic -> audit -> engine -> exit. */
function expectOrderedTeardown(log: string, signal: string): void {
  const signalAt = log.indexOf(`${signal} received — draining`);
  const trafficAt = log.indexOf("traffic stopped");
  const auditAt = log.indexOf("audit flushed");
  const engineAt = log.indexOf("engine stopped");
  expect(signalAt).toBeGreaterThan(-1);
  expect(trafficAt).toBeGreaterThan(signalAt);
  expect(auditAt).toBeGreaterThan(trafficAt);
  expect(engineAt).toBeGreaterThan(auditAt);
  // The leak detector must never fire: nothing may hold the event loop.
  expect(log).not.toContain("something still holds the event loop");
}

describe("W742 §3: the studio exits gracefully on a signal", () => {
  it("SIGTERM drains, flushes the audit, stops the engine and exits 0", async () => {
    const run = startStudio();
    await until(run, "listening on");
    run.child.kill("SIGTERM");
    expect(await run.exit).toBe(0);
    expectOrderedTeardown(run.output(), "SIGTERM");
  }, 40_000);

  it("SIGINT follows the same path (Ctrl-C)", async () => {
    const run = startStudio();
    await until(run, "listening on");
    run.child.kill("SIGINT");
    expect(await run.exit).toBe(0);
    expectOrderedTeardown(run.output(), "SIGINT");
  }, 40_000);
});
