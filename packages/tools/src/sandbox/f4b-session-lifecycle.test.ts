/**
 * F4 step 2b -- session-level lifecycle with a REAL process.
 *
 * The browser child is registered in the session ProcessRegistry; the host's
 * existing shutdown hook calls `processes.dispose()`. This test proves the
 * mechanism with a real long-lived process (no browser needed): after dispose
 * the pid is gone, i.e. the browser cannot be left as an orphan.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProcessRegistry } from "../process/registry.js";
import { POSIX_SHELL } from "../testing/platform-gates.js";
import { buildSandboxConfig } from "./config.js";
import { UserspaceSandbox } from "./userspace.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("F4b · session process lifecycle", () => {
  it.skipIf(!POSIX_SHELL)("a registered long-lived child is reaped by ProcessRegistry.dispose()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4b-life-"));
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: dir, root: dir }), { rlimits: false });
    const spawned = await sandbox.spawn({ command: "sleep 30" });
    const processes = new ProcessRegistry();
    processes.insert(spawned.child, false);
    const pid = spawned.child.pid;
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid as number, 0)).not.toThrow();

    processes.dispose();
    await sleep(400);
    expect(() => process.kill(pid as number, 0)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
