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
});
