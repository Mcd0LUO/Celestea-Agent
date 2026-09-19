/**
 * F4 step 2b live (OPT-IN): a REAL headless browser through the REAL sandbox.
 *
 * Default gate: VISIBLE skip unless CELESTEA_BROWSER_E2E=1. Run with:
 *   CELESTEA_BROWSER_E2E=1 npx vitest run packages/tools/src/browser/browser-live.test.ts
 *
 * It proves the whole chain on this host: sandbox.spawn(noAddressSpaceLimit)
 * -> DevTools endpoint -> CDP -> AX snapshot -> PNG through the attachment
 * store -> dispose leaves NO orphan process and NO profile dir.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAttachmentStore } from "../attachments/store.js";
import { ProcessRegistry } from "../process/registry.js";
import { buildSandboxConfig } from "../sandbox/config.js";
import { platformGates } from "../testing/platform-gates.js";
import { UserspaceSandbox } from "../sandbox/userspace.js";
import { findHeadlessShell } from "./launch.js";
import { BrowserManager } from "./session.js";

const OPT_IN = process.env["CELESTEA_BROWSER_E2E"] === "1";
const SHELL = findHeadlessShell();
const gates = platformGates();

if (!OPT_IN) console.warn("[f4b-browser-live] skipped: set CELESTEA_BROWSER_E2E=1 to run the real-browser suite");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function browserProfileDirs(): string[] {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("celestea-browser-"));
  } catch {
    return [];
  }
}

function orphanPids(): string {
  try {
    // The bracket keeps pgrep from matching its own shell wrapper.
    return execSync("pgrep -af '[c]elestea-browser' || true", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

describe.skipIf(!OPT_IN || SHELL === null || !gates.posixShell)("F4b live · real browser through the real sandbox", () => {
  it("opens, snapshots, screenshots, acts, and leaves no orphan", async () => {
    const before = browserProfileDirs();
    const dir = mkdtempSync(join(tmpdir(), "f4b-live-"));
    const store = createAttachmentStore(join(dir, "attachments"));
    const processes = new ProcessRegistry();
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: dir, root: dir, timeoutMs: 60_000, maxTimeoutMs: 120_000, programDir: join(dir, "run-code") }), { rlimits: true });
    const manager = new BrowserManager({ sandbox, processes, attachments: store, findExecutable: () => SHELL as string, memoryLimitMb: 2048, disposeGraceMs: 5_000 });

    const value = await manager.open("data:text/html,<title>F4 Live</title><h1 id=h onclick=\"window.__clicked=1\">Hi</h1><input id=i>", { width: 1024, height: 640 });
    expect(value.title).toBe("F4 Live");
    expect(value.isolation.address_space_limit).toBe("exempted");
    expect(value.snapshot.included_nodes).toBeGreaterThan(0);
    expect(value.screenshot).not.toBeNull();
    expect(value.screenshot!.bytes).toBeGreaterThan(100);
    expect(value.attachments).toHaveLength(1);

    const acted = await manager.act({ action: "type", ref: value.snapshot.refs[0]!.ref, text: "hello" });
    expect(acted.ok).toBe(true);

    await manager.dispose();
    await sleep(1_500);
    expect(orphanPids()).toBe("");
    expect(browserProfileDirs().filter((name) => !before.includes(name))).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
