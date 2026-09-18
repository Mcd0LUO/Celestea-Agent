/**
 * F4 live (OPT-IN): RLIMIT_AS kills the browser; the per-call exemption saves it.
 *
 * The default gate NEVER needs a browser: without CELESTEA_BROWSER_E2E=1 this
 * suite is a VISIBLE skip (and prints the opt-in), not a silent disappearance.
 *
 * Run it with:  CELESTEA_BROWSER_E2E=1 npx vitest run packages/tools/src/sandbox/f4-as-exemption-live.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findHeadlessShell } from "../browser/launch.js";
import { platformGates } from "../testing/platform-gates.js";
import { buildSandboxConfig } from "./config.js";
import { UserspaceSandbox } from "./userspace.js";

const OPT_IN = process.env["CELESTEA_BROWSER_E2E"] === "1";
const SHELL = findHeadlessShell();
const gates = platformGates();

if (!OPT_IN) {
  console.warn("[f4-as-exemption-live] browser live test skipped: set CELESTEA_BROWSER_E2E=1 to run it");
}

/** A self-contained command: start the browser, wait for its endpoint, report. */
function probeCommand(bin: string): string {
  return [
    "BIN=" + bin,
    "UDD=$(mktemp -d /tmp/f4-live-XXXX)",
    '$BIN --headless --no-sandbox --remote-debugging-port=0 --user-data-dir="$UDD" about:blank >/dev/null 2>"$UDD/err" &',
    "PID=$!",
    "for i in $(seq 1 100); do grep -q 'DevTools listening' \"$UDD/err\" 2>/dev/null && break; kill -0 $PID 2>/dev/null || break; sleep 0.05; done",
    "if grep -q 'DevTools listening' \"$UDD/err\" 2>/dev/null; then echo BROWSER_ALIVE; else wait $PID; echo \"BROWSER_DIED rc=$?\"; fi",
    "kill -TERM $PID 2>/dev/null",
    "true",
  ].join("\n");
}

describe.skipIf(!OPT_IN || SHELL === null || !gates.prlimitUsable)("F4 live · address-space exemption", () => {
  it("without the exemption the browser dies (133); with it the endpoint appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-live-"));
    const config = buildSandboxConfig({ workdir: dir, root: dir, timeoutMs: 60_000, maxTimeoutMs: 120_000, programDir: join(dir, "run-code") });
    const sandbox = new UserspaceSandbox(config, { rlimits: true });
    const command = probeCommand(SHELL as string);

    const plain = await sandbox.run({ command, timeoutMs: 60_000 });
    expect(plain.stdout).toContain("BROWSER_DIED rc=133");

    const exempt = await sandbox.run({ command, noAddressSpaceLimit: true, timeoutMs: 60_000 });
    expect(exempt.stdout).toContain("BROWSER_ALIVE");
  }, 90_000);
});
