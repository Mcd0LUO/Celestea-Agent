/**
 * Real-machine proofs for the bwrap provider (this host: bubblewrap 0.11.1).
 *
 * Everything here is `skipIf`-gated on the host probe, so the suite stays green
 * on a machine without bubblewrap while still being a hard gate where bwrap
 * works. The five claims W274 measured live are re-asserted as regressions:
 * 1. device nodes survive the mount order (`--ro-bind / /` before `--dev /dev`);
 * 2. the root is read-only, `/tmp` is private, the network namespace is empty;
 * 3. output over the cap is truncated *and* drained (no backpressure deadlock);
 * 4. a timeout kills the whole process group — no survivors;
 * 5. `--die-with-parent` reaps the tree when the Node parent is SIGKILLed.
 *
 * Survivor checks always match a per-run unique marker and kill only the pids
 * they matched (shared-host lesson from W274 §10: never `pkill -f`).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { isSandboxError } from "@celestea/core";

import { buildBwrapArgv, DEFAULT_BWRAP_OPTIONS } from "./bwrap-argv.js";
import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig, type SandboxConfigOverrides } from "./config.js";
import { ENV_SANDBOX_BWRAP, probeHost, resetProbeCache } from "./probe.js";
import { cleanupTempDirs, makeTempDir, makeDir } from "../testing/tmp.test-util.js";

const probe = probeHost();
const bwrap = probe.bwrapPath ?? "/usr/bin/bwrap";
const ROOT = process.cwd();
/** Unique per run, so a survivor scan can never hit another session's process. */
const MARK = `4567.${String(process.pid).slice(-4)}`;

function sandboxWith(overrides: SandboxConfigOverrides = {}, options: ConstructorParameters<typeof BwrapSandbox>[1] = {}) {
  const config = buildSandboxConfig({ workdir: ROOT, root: ROOT, timeoutMs: 10_000, maxTimeoutMs: 20_000, ...overrides });
  return new BwrapSandbox(config, { probe, ...options });
}

/** Pids whose `/proc/<pid>/cmdline` contains `needle`. */
function pidsMatching(needle: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").includes(needle)) found.push(Number(entry));
    } catch {
      /* process vanished mid-scan */
    }
  }
  return found;
}

/** Kill exactly the pids a scan returned (never a pattern-based kill). */
function reap(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(!probe.bwrapUsable)("bwrap provider (live)", () => {
  it("reads device nodes — the W274 argument-order regression", async () => {
    const run = await sandboxWith().run({ command: "exec 3</dev/zero && exec 4</dev/null && echo DEV-OK", timeoutMs: 10_000 });
    expect(run.stdout.trim()).toBe("DEV-OK");
    expect(run.exit_code).toBe(0);
    expect(run.sandbox.provider).toBe("bwrap");
  });

  it("would fail with the engine's old order — the regression test is not vacuous", () => {
    // Same command, both orders. dash *exits* when the redirection of `exec`
    // fails, so the old order yields no stdout at all plus EACCES on stderr.
    const tail = ["--tmpfs", "/tmp", "--", "/bin/sh", "-c", "exec 3</dev/zero && echo DEV-OK"];
    const wrong = spawnSync(bwrap, ["--unshare-all", "--dev", "/dev", "--proc", "/proc", "--ro-bind", "/", "/", ...tail], {
      encoding: "utf8",
    });
    const right = spawnSync(bwrap, ["--unshare-all", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...tail], {
      encoding: "utf8",
    });
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toContain("Permission denied");
    expect(wrong.status).not.toBe(0);
    expect(right.stdout.trim()).toBe("DEV-OK");
    expect(right.status).toBe(0);
  });

  it("keeps the root read-only, the workdir writable and /tmp private", async () => {
    const tmpProbe = `/tmp/w508-live-${MARK}`;
    const run = await sandboxWith().run({
      command: `touch /etc/w508-probe 2>&1 | head -1; touch ./w508-live-marker && echo WORKDIR-OK; rm -f ./w508-live-marker; touch ${tmpProbe}`,
      timeoutMs: 10_000,
    });
    expect(run.stdout).toContain("Read-only file system");
    expect(run.stdout).toContain("WORKDIR-OK");
    expect(existsSync(join(ROOT, "w508-live-marker"))).toBe(false);
    expect(existsSync(tmpProbe)).toBe(false); // written inside a private tmpfs
  });

  it("isolates the network namespace", async () => {
    const hostInterfaces = readdirSync("/sys/class/net").filter((name) => name !== "lo");
    expect(hostInterfaces.length).toBeGreaterThan(0);
    const run = await sandboxWith().run({ command: "cat /proc/net/dev", timeoutMs: 10_000 });
    const interfaces = run.stdout
      .split("\n")
      .slice(2)
      .map((line) => line.split(":")[0]?.trim() ?? "")
      .filter((name) => name !== "");
    expect(interfaces).toEqual(["lo"]);
    for (const hostInterface of hostInterfaces) expect(run.stdout).not.toContain(hostInterface);
  });

  it("truncates output past the cap, still drains the pipe and keeps the exit code", async () => {
    const started = Date.now();
    const run = await sandboxWith({ maxOutputBytes: 4_096 }).run({
      command: "head -c 200000 /dev/zero | tr '\\0' 'a'",
      timeoutMs: 15_000,
    });
    expect(run.stdout.length).toBe(4_096);
    expect(run.stdout_truncated).toBe(true);
    expect(run.exit_code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("kills the whole process group on timeout", async () => {
    const sleep = `sleep ${MARK}`;
    const command = `${sleep} & ${sleep} & wait`;
    let failure: unknown = null;
    try {
      await sandboxWith({ timeoutMs: 400, maxTimeoutMs: 20_000 }).run({ command, timeoutMs: 400 });
    } catch (error) {
      failure = error;
    }
    expect(isSandboxError(failure)).toBe(true);
    expect((failure as { kind: string }).kind).toBe("timeout");
    expect(await waitFor(() => pidsMatching(sleep).length === 0)).toBe(true);
    reap(pidsMatching(sleep));
    expect(pidsMatching(sleep)).toEqual([]);
  });

  it("reaps the sandbox tree when the Node parent is SIGKILLed (--die-with-parent)", async () => {
    const argv = bwrapArgvFor(`exec sleep ${MARK}`);
    const survivors = await surviveParentDeath(argv, `sleep ${MARK}`, 8_000);
    expect(survivors).toEqual([]);
  });

  it("leaves orphans without the flag — so the die-with-parent assertion is real", async () => {
    const mark = `${MARK}1`;
    const argv = bwrapArgvFor(`exec sleep ${mark}`).filter((flag) => flag !== "--die-with-parent");
    const survivors = await surviveParentDeath(argv, `sleep ${mark}`, 2_000);
    expect(survivors.length).toBeGreaterThan(0);
  });

  it("memoizes the probe per bwrap-relevant env, not globally", () => {
    expect(probeHost({ env: process.env, refresh: true }).bwrapUsable).toBe(true);
    const pinned = probeHost({ env: { ...process.env, [ENV_SANDBOX_BWRAP]: "/nonexistent/bwrap" } });
    expect(pinned.bwrapUsable).toBe(false);
    expect(pinned.bwrapRejectReason).toContain("not found");
    expect(probeHost({ env: process.env }).bwrapUsable).toBe(true);
    resetProbeCache();
  });

  it("applies the seccomp whitelist and still runs ordinary commands", async () => {
    const run = await sandboxWith({}, { run: { seccomp: true } }).run({ command: "echo ok; grep -E '^Seccomp:' /proc/self/status", timeoutMs: 10_000 });
    expect(run.stdout).toContain("ok");
    expect(run.stdout).toContain("Seccomp:\t2");
    expect(run.sandbox.seccomp).toBe(true);
  });
});

/**
 * Run `argv` under a throwaway Node parent, SIGKILL that parent, and return the
 * pids still running `needle` afterwards. The caller reaps nothing: the helper
 * already killed exactly the pids it matched.
 */
async function surviveParentDeath(argv: readonly string[], needle: string, settleMs: number): Promise<number[]> {
  const dir = makeDir(makeTempDir("orphan"), "drive");
  const pidFile = join(dir, "pid");
  const driver = join(dir, "driver.mjs");
  writeFileSync(driver, DRIVER_SCRIPT);
  const parent = spawn(process.execPath, [driver, JSON.stringify(argv), pidFile], { stdio: "ignore" });
  try {
    if (!(await waitFor(() => existsSync(pidFile)))) throw new Error("orphan driver never reported a pid");
    expect(await waitFor(() => pidsMatching(needle).length > 0, 3_000)).toBe(true);
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("close", resolve));
    await waitFor(() => pidsMatching(needle).length === 0, settleMs);
    return pidsMatching(needle);
  } finally {
    reap(pidsMatching(needle));
  }
}

/** bwrap argv for one sandboxed command, under the production option defaults. */
function bwrapArgvFor(command: string): string[] {
  return [...buildBwrapArgv(ROOT, DEFAULT_BWRAP_OPTIONS), "--", "/bin/sh", "-c", command];
}

/** Minimal parent whose only job is to die uncleanly, leaving bwrap behind. */
const DRIVER_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [argvJson, pidFile] = process.argv.slice(2);
const child = spawn("/usr/bin/bwrap", JSON.parse(argvJson), { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));
setTimeout(() => {}, 60000);
`;

describe.skipIf(probe.bwrapUsable)("bwrap provider (unavailable host)", () => {
  it("reports the probe verdict instead of pretending", () => {
    expect(probe.bwrapUsable).toBe(false);
    expect(probe.bwrapRejectReason).not.toBeNull();
  });
});

describe("live-test hygiene", () => {
  it("cleans its temp dirs", () => {
    cleanupTempDirs();
    expect(true).toBe(true);
  });
});
