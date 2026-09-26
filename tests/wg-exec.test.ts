/**
 * G2 — `POST /api/exec` (immediate execution, no model in the loop).
 *
 * The endpoint must reuse the run_shell path and pass the PERMISSION gate. This
 * suite drives it through the real HTTP app with a fake runtime adapter; the
 * permission cases plant the same `permission.json` the engine reads.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getJson, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const S1 = "sample-ws/s1";
const SESSION = { name: "s1", log: "" };

/** A custom preset that DENIES run_shell (the permission-gate negative case). */
const SHELL_DENY_PRESET = {
  id: "wg-no-shell",
  label: "no shell",
  network: false,
  workspaceWritable: true,
  toolRootsWritable: false,
  writeRoots: [],
  allPaths: false,
  unsandboxed: false,
  toolDeny: ["run_shell"],
};

function harness(): StudioHarness {
  return makeHarness({ session: SESSION, env: { CELESTEA_TOOL_GUARD: "0" } });
}

function exec(h: StudioHarness, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, "/api/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("G2 · POST /api/exec", () => {
  it("runs a command and returns the frozen 200 shape with a contract-only sandbox block", async () => {
    const h = harness();
    const res = await exec(h, { command: "echo hello-exec" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, exit_code: 0, signal: null });
    expect(String(res.body["stdout"])).toContain("hello-exec");
    expect(typeof res.body["duration_ms"]).toBe("number");
    const sandbox = res.body["sandbox"] as Record<string, unknown>;
    // Contract fields only (+ optional cpu_sec); no host diagnostics leak through.
    expect(Object.keys(sandbox).sort()).toEqual(["cpu_sec", "net_isolated", "provider", "seccomp", "tmp_private"]);
  });

  it("reports a non-zero exit code", async () => {
    const h = harness();
    const res = await exec(h, { command: "exit 7" });
    expect(res.status).toBe(200);
    expect(res.body["exit_code"]).toBe(7);
    expect(res.body["ok"]).toBe(true);
  });

  it("reports a command that does not exist (nonzero, shell-level stderr)", async () => {
    const h = harness();
    const res = await exec(h, { command: "wg-not-a-real-command-xyz" });
    expect(res.status).toBe(200);
    expect(res.body["exit_code"]).not.toBe(0);
    expect(String(res.body["stderr"]).length).toBeGreaterThan(0);
  });

  it("times out as a structured 400 (the sandbox timeout contract, never a hang)", async () => {
    const h = harness();
    const res = await exec(h, { command: "sleep 5", timeout_ms: 200 });
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("timeout");
    expect(res.body["ok"]).toBe(false);
  });

  it("truncates oversized output (the same cap as run_shell)", async () => {
    const h = harness();
    const res = await exec(h, { command: "head -c 200000 /dev/zero | tr '\\0' 'a'" });
    expect(res.status).toBe(200);
    expect(String(res.body["stdout"]).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("REFUSES when the session's preset denies run_shell (code=shell_denied, never a silent run)", async () => {
    const h = harness();
    writeFileSync(join(h.root, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [SHELL_DENY_PRESET] }));
    writeFileSync(
      join(h.workspace, "s1", "permission.json"),
      JSON.stringify({ version: 1, session: S1, preset: SHELL_DENY_PRESET.id, updated_at: 0 }),
    );
    const marker = join(h.root, "must-not-exist");
    const res = await exec(h, { command: `touch ${marker}`, session: S1 });
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("shell_denied");
    expect(String(res.body["error"])).toContain("run_shell");
    expect(res.body["ok"]).toBe(false);
  });

  it("400s a missing/empty command and an unknown session", async () => {
    const h = harness();
    const missing = await exec(h, {});
    expect(missing.status).toBe(422);
    const empty = await exec(h, { command: "   " });
    expect(empty.status).toBe(422);
    const unknown = await exec(h, { command: "true", session: "sample-ws/ghost" });
    expect(unknown.status).toBe(404);
  });

  /**
   * W9210 (F3): a sandbox that REFUSES AT SELECTION TIME is the contract's
   * structured 400, not a 500.
   *
   * The trigger is deliberately host-independent: an INVALID
   * `CELESTEA_SANDBOX_FALLBACK` value is refused by `fallbackMode` on every
   * platform (a typo must never decide the security posture), so this case
   * cannot degrade into "passes because this host happens to have bwrap".
   *
   * Before the fix `sandboxFor` was called OUTSIDE the try, so the throw
   * escaped the handler and Hono answered `500 Internal Server Error`.
   */
  it("answers a selection-time sandbox refusal as the structured 400, never a 500", async () => {
    const h = makeHarness({ session: SESSION, env: { CELESTEA_TOOL_GUARD: "0", CELESTEA_SANDBOX_FALLBACK: "bogus" } });
    const res = await exec(h, { command: "echo never-runs" });
    expect(res.status).toBe(400);
    expect(res.body["ok"]).toBe(false);
    // The structured vocabulary of the sandbox contract survives to the client.
    expect(String(res.body["error"])).toContain("run_shell-sandbox: code=config");
    expect(String(res.body["error"])).toContain("CELESTEA_SANDBOX_FALLBACK='bogus'");
    h.cleanup();
  });

  /**
   * W9210 (F3), the `fail` branch: when the policy refuses to degrade, the
   * refusal is ALSO a 400. `CELESTEA_SANDBOX_BWRAP` is pinned at a path that
   * cannot exist, so the probe rejects bwrap on every host — deterministic
   * without depending on whether THIS machine has bubblewrap installed.
   */
  it("answers a fail-closed sandbox refusal as a structured 400", async () => {
    const h = makeHarness({
      session: SESSION,
      env: { CELESTEA_TOOL_GUARD: "0", CELESTEA_SANDBOX_FALLBACK: "fail", CELESTEA_SANDBOX_BWRAP: "/nonexistent/w9210/not-bwrap" },
    });
    const res = await exec(h, { command: "echo never-runs" });
    expect(res.status).toBe(400);
    expect(res.body["ok"]).toBe(false);
    expect(String(res.body["error"])).toContain("sandbox_unavailable");
    h.cleanup();
  });

  /**
   * W9210 (W9206-37): an OMITTED `session` must not be a way to skip the
   * focused session's permission baseline.
   *
   * Naming the restricted session was a 403 while omitting it ran, because the
   * detached scope reads the DEPLOYMENT default preset. "Which session does an
   * omitted id mean" already has one answer in this host — `active_session`,
   * the same reading /api/status and /api/tools use — so the omitted case must
   * answer exactly like the named one.
   */
  it("applies the FOCUSED session's baseline when session is omitted (no bypass by omission)", async () => {
    const h = harness();
    writeFileSync(join(h.root, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [SHELL_DENY_PRESET] }));
    writeFileSync(
      join(h.workspace, "s1", "permission.json"),
      JSON.stringify({ version: 1, session: S1, preset: SHELL_DENY_PRESET.id, updated_at: 0 }),
    );
    // Focus the restricted session the way the GUI does (POST .../activate).
    h.studio.services.workspaces.setActiveSession(S1);

    const omitted = await exec(h, { command: "echo bypass?" });
    expect(omitted.status).toBe(403);
    expect(omitted.body["code"]).toBe("shell_denied");

    // ...and the explicit form answers identically, so neither is a loophole.
    const named = await exec(h, { command: "echo bypass?", session: S1 });
    expect(named.status).toBe(403);
    expect(named.body["code"]).toBe("shell_denied");
    h.cleanup();
  });

  /**
   * W9210 (W9206-37), the other direction: a STALE `active_session` (the
   * session it names no longer exists) must NOT turn a legitimate detached run
   * into a 404. It names nothing live, so there is no baseline to apply — the
   * pre-existing detached behaviour is correct there.
   *
   * This is the negative control for "just require a session": requiring one
   * would refuse this case, and the fix must not break it.
   */
  it("falls back to the detached scope for a stale active session, but still 404s a caller-named ghost", async () => {
    const h = harness();
    h.studio.services.workspaces.setActiveSession("sample-ws/ghost");

    const omitted = await exec(h, { command: "echo detached-ok" });
    expect(omitted.status).toBe(200);
    expect(omitted.body["ok"]).toBe(true);

    // A session the CALLER named is the caller's own claim: its 404 stands.
    const named = await exec(h, { command: "echo ghost", session: "sample-ws/ghost" });
    expect(named.status).toBe(404);
    h.cleanup();
  });
});
