/**
 * W741 acceptance tests — the composed sandbox follows the provider POLICY.
 *
 * The W738 §4 finding, fixed and pinned here:
 * 1. bwrap is used whenever the host can give it — with no grants at all and
 *    with a `network` grant — instead of the old unconditional
 *    `userspaceSandbox()` that never even asked the policy;
 * 2. `CELESTEA_SANDBOX_FALLBACK=fail` is READ on the default path and on the
 *    grants path, and it REFUSES to execute (structured
 *    `run_shell-sandbox: code=config`) instead of being swallowed by a `catch`
 *    that quietly returned the userspace provider;
 * 3. the decision (`degraded` / `fallback_reason` / `fallback_mode` /
 *    `fallback_source`) travels in every `run_shell` result and in the audit,
 *    so a degradation is observable rather than inferred from prose.
 *
 * Every test injects a `HostProbe`, so nothing depends on this host's bwrap. The
 * bwrap cases use a stand-in binary that records its own use and then execs the
 * command after `--`: the marker file is what proves the argv really went
 * through bwrap and not through the userspace path.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolOutput } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { userspaceSandboxWith, type HostProbe } from "@celestea/tools";
import { EMPTY_GRANTS, type EffectiveGrants, type EngineGrantEvent } from "./engine-grants.js";
import { engineTools, type EngineTools } from "./engine-plugins.js";
import { createOfflineLlm } from "./offline-llm.js";

const roots: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `w741-${name}-`));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const profile: Profile = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 0,
  max_parallel_tool_calls: 4,
  reasoning_effort: null,
  max_output_tokens: null,
  context_window_tokens: 65_536,
  system_prompt: "test",
  request_format: "chat_completions",
  temperature: null,
};

/** Session env pinned to one temp workdir (`CELAESTEA_*` is the real spelling). */
function envOf(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CELAESTEA_RUN_SHELL_WORKDIR: dir,
    CELESTEA_RUN_SHELL_ROOT: dir,
    CELESTEA_TOOL_WORKDIR: dir,
    HOME: dir,
    ...extra,
  };
}

/** A host probe with the shape `probeHost()` returns (uidThreads: null → floor). */
function probeWith(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    platform: "linux",
    bwrapPath: "/usr/bin/bwrap",
    bwrapVersion: "bubblewrap 0.11.1\n",
    bwrapUsable: true,
    bwrapRejectReason: null,
    prlimitPath: "/usr/bin/prlimit",
    shellUlimitWorks: true,
    uidThreads: null,
    ...overrides,
  };
}

/** A host that cannot give bwrap at all (the degradation / refusal trigger). */
const NO_BWRAP = { bwrapPath: null, bwrapVersion: null, bwrapUsable: false, bwrapRejectReason: "host cannot create a user namespace" };

const FALLBACK_ENV = "CELESTEA_SANDBOX_FALLBACK";

/**
 * The stand-in bwrap: records its use, drops every flag up to `--`, execs the
 * rest — i.e. exactly the bwrap → `/bin/sh -c <command>` shape.
 */
function fakeBwrap(dir: string): string {
  const path = join(dir, "fake-bwrap");
  const marker = join(dir, "used-by-bwrap");
  const script = [
    "#!/bin/sh",
    `printf x >> '${marker}'`,
    "while [ $# -gt 0 ]; do",
    '  if [ "$1" = "--" ]; then shift; break; fi',
    "  shift",
    "done",
    'exec "$@"',
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

interface ComposeOptions {
  probe: Partial<HostProbe>;
  env?: NodeJS.ProcessEnv;
  grants?: EffectiveGrants;
  events?: EngineGrantEvent[];
}

function compose(dir: string, options: ComposeOptions): EngineTools {
  return engineTools({
    profile,
    llm: createOfflineLlm(),
    workers: null,
    env: options.env ?? envOf(dir),
    probe: probeWith(options.probe),
    grants: options.grants ?? EMPTY_GRANTS,
    ...(options.events === undefined ? {} : { audit: (event) => options.events?.push(event) }),
  });
}

async function runShell(tools: EngineTools, command: string): Promise<ToolOutput> {
  return tools.registry.dispatch({ call_id: "c1", name: "run_shell", args: { command } });
}

/** `run_shell`'s canonical value: streams + the meta the tool reports back. */
function shellValue(out: ToolOutput): { stdout: string; exit_code: number | null; sandbox: Record<string, unknown> } {
  return out.value as { stdout: string; exit_code: number | null; sandbox: Record<string, unknown> };
}

describe("W741 §1 — the production composition prefers bwrap by policy", () => {
  it("runs on bwrap when the host can give it, with no grants at all", async () => {
    const dir = tempDir("bwrap");
    const tools = compose(dir, { probe: { bwrapPath: fakeBwrap(dir) } });
    expect(tools.decision).toEqual({ provider: "bwrap", degraded: false, reason: null, mode: "userspace", source: "policy" });

    const out = await runShell(tools, "printf bwrap-path");
    expect(out.error).toBeNull();
    expect(shellValue(out).stdout).toBe("bwrap-path");
    expect(shellValue(out).exit_code).toBe(0);
    // the stand-in binary ran: the command really went through the bwrap argv
    expect(existsSync(join(dir, "used-by-bwrap"))).toBe(true);
    expect(shellValue(out).sandbox).toMatchObject({
      provider: "bwrap",
      degraded: false,
      fallback_reason: null,
      fallback_mode: "userspace",
      fallback_source: "policy",
    });
  });

  it("keeps bwrap for a `network` grant (the grant only adds --share-net)", async () => {
    const dir = tempDir("bwrap-net");
    const tools = compose(dir, {
      probe: { bwrapPath: fakeBwrap(dir) },
      grants: { ...EMPTY_GRANTS, network: true },
    });
    expect(tools.decision.provider).toBe("bwrap");
    expect(tools.decision.degraded).toBe(false);
    const out = await runShell(tools, "printf net-grant");
    expect(shellValue(out).stdout).toBe("net-grant");
    // the grant reached the bwrap argv: `--share-net` ⇒ the net ns is NOT isolated
    expect(shellValue(out).sandbox).toMatchObject({ provider: "bwrap", net_isolated: false, fallback_source: "policy" });
  });
});

describe("W741 §2 — CELESTEA_SANDBOX_FALLBACK=fail refuses instead of degrading", () => {
  it("refuses on the default path and never runs the command", async () => {
    const dir = tempDir("fail-default");
    const marker = join(dir, "must-not-exist");
    const events: EngineGrantEvent[] = [];
    const tools = compose(dir, { probe: NO_BWRAP, env: envOf(dir, { [FALLBACK_ENV]: "fail" }), events });
    expect(tools.decision).toMatchObject({ provider: "none", degraded: false, source: "refused", mode: "fail" });
    expect(tools.decision.reason).toContain("sandbox_unavailable: host cannot create a user namespace");
    expect(events.some((event) => event.event === "deny" && event.cap === "sandbox")).toBe(true);

    await expect(tools.sandbox.run({ command: `touch ${marker}` })).rejects.toThrowError(/sandbox_unavailable/);
    await expect(tools.sandbox.spawn({ command: `touch ${marker}` })).rejects.toThrowError(/code=config/);
    expect(existsSync(marker)).toBe(false);

    const out = await runShell(tools, `touch ${marker}`);
    expect(out.value).toBeNull();
    expect(out.error).toContain("run_shell-sandbox: code=config");
    expect(out.error).toContain("refuses to execute without OS isolation");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses in the grants path too — no silent userspace fallback (the W738 §4 defect)", async () => {
    const dir = tempDir("fail-grant");
    const marker = join(dir, "must-not-exist");
    const events: EngineGrantEvent[] = [];
    const tools = compose(dir, {
      probe: NO_BWRAP,
      env: envOf(dir, { [FALLBACK_ENV]: "fail" }),
      grants: { ...EMPTY_GRANTS, network: true },
      events,
    });
    expect(tools.decision.source).toBe("refused");
    expect(tools.decision.mode).toBe("fail");
    expect(events.map((event) => event.event)).toContain("deny");

    const out = await runShell(tools, `touch ${marker}`);
    expect(out.error).toContain("run_shell-sandbox: code=config");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses (never guesses) when the fallback value itself is unreadable", async () => {
    const dir = tempDir("fail-typo");
    const tools = compose(dir, { probe: { bwrapPath: fakeBwrap(dir) }, env: envOf(dir, { [FALLBACK_ENV]: "userpsace" }) });
    expect(tools.decision).toMatchObject({ provider: "none", source: "refused", mode: null });
    expect(tools.decision.reason).toContain("invalid CELESTEA_SANDBOX_FALLBACK='userpsace'");
    await expect(tools.sandbox.run({ command: "printf never" })).rejects.toThrowError(/code=config/);
  });
});

describe("W741 §3 — degradation happens only when the policy says so, and is observable", () => {
  it("degrades to userspace under the default mode, and reports it in the ToolOutput", async () => {
    const dir = tempDir("degrade");
    const tools = compose(dir, { probe: NO_BWRAP });
    expect(tools.decision).toMatchObject({ provider: "userspace", degraded: true, source: "policy", mode: "userspace" });

    const out = await runShell(tools, "printf degraded-ok");
    expect(out.error).toBeNull();
    expect(shellValue(out).stdout).toBe("degraded-ok");
    expect(shellValue(out).sandbox).toMatchObject({
      provider: "userspace",
      degraded: true,
      fallback_mode: "userspace",
      fallback_source: "policy",
    });
    expect(String(shellValue(out).sandbox["fallback_reason"])).toContain("host cannot create a user namespace");
  });

  it("degrades when — and only when — the operator says `userspace`", async () => {
    const dir = tempDir("degrade-explicit");
    const tools = compose(dir, { probe: NO_BWRAP, env: envOf(dir, { [FALLBACK_ENV]: "userspace" }) });
    expect(tools.decision).toMatchObject({ provider: "userspace", degraded: true, mode: "userspace", source: "policy" });

    const out = await runShell(tools, "printf explicit-userspace");
    expect(out.error).toBeNull();
    expect(shellValue(out).stdout).toBe("explicit-userspace");
    expect(shellValue(out).sandbox).toMatchObject({ provider: "userspace", degraded: true, fallback_mode: "userspace" });
  });

  it("accepts userspace under `fail` ONLY through the `unsandboxed` grant, and audits it", async () => {
    const dir = tempDir("grant-unsandboxed");
    const events: EngineGrantEvent[] = [];
    const tools = compose(dir, {
      probe: NO_BWRAP,
      env: envOf(dir, { [FALLBACK_ENV]: "fail" }),
      grants: { ...EMPTY_GRANTS, unsandboxed: true },
      events,
    });
    expect(tools.decision).toMatchObject({ provider: "userspace", degraded: true, source: "grant" });
    expect(events.some((event) => event.event === "degraded_by_grant")).toBe(true);

    const out = await runShell(tools, "printf granted-ok");
    expect(shellValue(out).stdout).toBe("granted-ok");
    expect(shellValue(out).sandbox).toMatchObject({ degraded: true, fallback_source: "grant" });
  });

  it("marks an injected sandbox as an explicit bypass (`degraded` stays unknown)", async () => {
    const dir = tempDir("injected");
    const tools = engineTools({
      profile,
      llm: createOfflineLlm(),
      workers: null,
      env: envOf(dir),
      sandbox: userspaceSandboxWith({ workdir: dir, root: dir, timeoutMs: 5_000, maxTimeoutMs: 10_000 }),
    });
    expect(tools.decision).toMatchObject({ provider: "UserspaceSandbox", degraded: null, source: "injected" });

    const out = await runShell(tools, "printf injected-ok");
    expect(shellValue(out).stdout).toBe("injected-ok");
    expect(shellValue(out).sandbox).toMatchObject({ degraded: null, fallback_source: "injected" });
  });

  it("records a refusal in the audit sink as a decision, not a log line", async () => {
    const dir = tempDir("audit");
    const events: EngineGrantEvent[] = [];
    const tools = compose(dir, { probe: NO_BWRAP, env: envOf(dir, { [FALLBACK_ENV]: "fail" }), events });
    const out = await runShell(tools, "printf nothing-runs");
    expect(out.value).toBeNull();
    const deny = events.find((event) => event.event === "deny");
    expect(deny).toMatchObject({ event: "deny", cap: "sandbox", provider: "none" });
    expect(String(deny?.reason)).toContain("sandbox_unavailable");
    expect(String(deny?.detail)).toContain("an 'unsandboxed' session grant is the only override");
  });
});
