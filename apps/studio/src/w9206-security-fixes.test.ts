/**
 * W9206 fixes — the four security/correctness items of this worker's brief.
 *
 * Every case here is a REGRESSION for a defect that shipped: each one is
 * written so that reverting the fix makes it fail (the mutation commands are
 * recorded in results/W9206-修复.md).
 *
 *   ① W9206-36  cross-site write (RCE via /api/exec)
 *   ② W9206-35  terminal stdin EPIPE kills the process
 *   ③ W9206-03  grant confirm token bound to an HttpOnly nonce cookie
 *   ④ W9206-32  the answer guard must not be skipped when `session` is absent
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApp } from "./app.js";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { getJson, jsonRequest, makeHarness, mintGrantToken, type StudioHarness } from "./harness.test-util.js";

const roots: string[] = [];
const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const S1 = "sample-ws%2Fs1";

/** An app over a throwaway root, with no token (the DEFAULT deployment). */
function bareApp(): { app: ReturnType<typeof createStudioApp>["app"]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "w9206-fix-"));
  roots.push(root);
  const ws = join(root, "ws");
  mkdirSync(join(ws, "s1"), { recursive: true });
  writeFileSync(join(ws, "s1", "cli-main.jsonl"), "");
  writeFileSync(join(root, "workspaces.json"), JSON.stringify({ workspaces: [{ path: ws }], active_session: null }));
  const env = {
    CELESTEA_WORKSPACES_FILE: join(root, "workspaces.json"),
    CELESTEA_PROVIDERS_FILE: join(root, "providers.json"),
    CELESTEA_PROMPTS_FILE: join(root, "prompts.json"),
    CELESTEA_HOME: root,
    STUDIO_STATIC_ROOT: join(root, "dist"),
  };
  return { app: createStudioApp({ cwd: root, env, runtime: createFakeRuntimeAdapter({ profile: { model: "m" } }) }).app, root };
}

describe("W9206-36 · a cross-site write is refused (the /api/exec RCE)", () => {
  const HOST = "127.0.0.1:3777";
  async function exec(headers: Record<string, string>): Promise<number> {
    const { app } = bareApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1:3777/api/exec", {
        method: "POST",
        headers: { host: HOST, ...headers },
        body: JSON.stringify({ command: "echo pwned" }),
      }),
    );
    return res.status;
  }

  it("refuses the CORS-simple cross-site form that used to run a command", async () => {
    // text/plain = a SIMPLE request (no preflight) + an attacking Origin.
    expect(await exec({ "content-type": "text/plain", origin: "https://evil.example" })).toBe(403);
  });

  it("refuses a cross-site request even when it declares JSON", async () => {
    expect(await exec({ "content-type": "application/json", origin: "https://evil.example" })).toBe(403);
  });

  it("refuses a browser that reports Sec-Fetch-Site: cross-site", async () => {
    expect(await exec({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await exec({ "content-type": "application/json", "sec-fetch-site": "same-site" })).toBe(403);
  });

  it("refuses a non-JSON Content-Type (what made the write a simple request)", async () => {
    // No Origin at all: the Content-Type gate alone must reject this.
    expect(await exec({ "content-type": "text/plain" })).toBe(415);
  });

  it("keeps every legitimate caller working", async () => {
    // The UI's own fetch: same-origin + JSON.
    expect(await exec({ "content-type": "application/json", "sec-fetch-site": "same-origin" })).toBe(200);
    // A top-level navigation / bookmark.
    expect(await exec({ "content-type": "application/json", "sec-fetch-site": "none" })).toBe(200);
    // A non-browser client (curl, the CLI, the tests): no Fetch Metadata at all.
    expect(await exec({ "content-type": "application/json" })).toBe(200);
    // An Origin that matches this very Host (a same-origin XHR that sends one).
    expect(await exec({ "content-type": "application/json", origin: "http://127.0.0.1:3777" })).toBe(200);
  });

  it("leaves cross-site READS alone (only writes are refused)", async () => {
    const { app } = bareApp();
    const res = await app.fetch(new Request("http://127.0.0.1:3777/api/health", { headers: { host: HOST, origin: "https://evil.example" } }));
    expect(res.status).toBe(200);
  });

  it("refuses every write route, not just /api/exec", async () => {
    const { app } = bareApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1:3777/api/config", {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json", origin: "https://evil.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("W9206-35 · a dead stdin must never take the process down", () => {
  /**
   * The root cause, reproduced portably (this host has no pty, so the route
   * itself cannot be driven here). A child that exits while we are still
   * writing to its stdin emits 'error' (EPIPE); with no listener that is an
   * UNCAUGHT exception and the process dies. The fix attaches a listener at
   * spawn, so the same sequence must now survive.
   *
   * This is deliberately a REAL child process: the defect was about Node's
   * emitter semantics, not about our control flow, so a mock would prove
   * nothing.
   */
  async function writeToDeadChild(withListener: boolean): Promise<{ code: number | null; stderr: string }> {
    const { spawn } = await import("node:child_process");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn('sh', ['-c', 'sleep 0.05'], { stdio: ['pipe','pipe','pipe'] });",
      "c.stdout.on('data', () => {});",
      withListener ? "c.stdin.on('error', () => {});" : "",
      "(async () => {",
      "  for (let i = 0; i < 60; i++) {",
      withListener ? "    if (c.stdin.destroyed || !c.stdin.writable) break;" : "    if (c.stdin.destroyed) break;",
      withListener ? "    try { c.stdin.write(Buffer.from('x')); } catch { break; }" : "    c.stdin.write(Buffer.from('x'));",
      "    await new Promise((r) => setTimeout(r, 2));",
      "  }",
      "  process.exit(0);",
      "})();",
    ].filter((line) => line !== "").join("\n");
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      child.on("exit", (code: number | null) => resolve({ code, stderr }));
    });
  }

  it("proves the mechanism: without the listener the process dies, with it it survives", async () => {
    const without = await writeToDeadChild(false);
    // The shipped defect: an unhandled EPIPE ends the process non-zero.
    expect(without.code).not.toBe(0);
    expect(without.stderr).toContain("EPIPE");
    // The fix: the listener turns the same sequence into an ordinary exit.
    const withFix = await writeToDeadChild(true);
    expect(withFix.code).toBe(0);
  }, 30_000);

  /**
   * The regression guard for OUR fix (the mechanism test above proves Node's
   * semantics, not that the product attaches the listener).
   *
   * The route itself cannot be driven on this host: `ptySupport` refuses on
   * win32 (no util-linux `script(1)`), so `/api/terminal` answers 501 and no
   * child ever exists. Rather than skip silently, the two facts that ARE
   * checkable here are asserted: the spawn wires a stdin error listener, and
   * the input route re-checks writability before writing. Both assertions go
   * RED if the fix is reverted, on every platform.
   */
  it("the terminal spawn wires a stdin error listener and re-checks writability", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./handlers/terminal.ts", import.meta.url)), "utf8");
    // (a) the listener that stops the process-killing unhandled emit.
    expect(source).toMatch(/child\.stdin\?\.on\("error"/);
    // (b) the write is guarded, and writability is re-checked after the await.
    expect(source).toMatch(/!stdin\.writable/);
    expect(source).toMatch(/try \{\s*stdin\.write\(/);
  });

  it("the input route answers a structured refusal for a terminal that is gone", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);
    const opened = await getJson(h.app, "/api/terminal", jsonRequest("POST", { session: "sample-ws/s1" }));
    if (opened.status !== 200) return; // no pty on this host (Windows): covered by the mechanism test above
    const id = String(opened.body["id"]);
    await getJson(h.app, `/api/terminal/${encodeURIComponent(id)}/close`, jsonRequest("POST", {}));
    const after = await getJson(h.app, `/api/terminal/${encodeURIComponent(id)}/input`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect([404, 409]).toContain(after.status);
    expect(after.status).not.toBe(500);
  }, 30_000);
});

describe("W9206-03 · the confirm token is bound to an HttpOnly nonce cookie", () => {
  it("sets an HttpOnly nonce cookie on the mint and requires it on the POST", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);
    const minted = await mintGrantToken(h, S1, "network", {});
    expect(minted.token).not.toBe("");
    expect(minted.cookie).toMatch(/^celestea_grant_nonce=[0-9a-f]{64}$/);
    // With the cookie the grant succeeds...
    const ok = await getJson(h.app, `/api/sessions/${S1}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-celestea-grant-confirm": minted.token, cookie: minted.cookie as string },
      body: JSON.stringify({ cap: "network" }),
    });
    expect(ok.status).toBe(200);
  });

  it("refuses a token whose nonce cookie was never presented (the tool's case)", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);
    const minted = await mintGrantToken(h, S1, "network", {});
    // Forged request headers, no nonce: exactly what http_request can do.
    const forged = await getJson(h.app, `/api/sessions/${S1}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-celestea-grant-confirm": minted.token, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ cap: "network" }),
    });
    expect(forged.status).toBe(403);
    expect(forged.body).toEqual({ ok: false, error: "grant confirmation required" });
  });

  it("refuses a guessed nonce", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);
    const minted = await mintGrantToken(h, S1, "network", {});
    const guessed = await getJson(h.app, `/api/sessions/${S1}/grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-celestea-grant-confirm": minted.token,
        cookie: "celestea_grant_nonce=" + "0".repeat(64),
      },
      body: JSON.stringify({ cap: "network" }),
    });
    expect(guessed.status).toBe(403);
  });
});

describe("W9206-32 · the answer guard is not skipped when `session` is absent", () => {
  it("refuses an answer that omits the session for another session's question", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);
    // The unit-level guard is what this pins: an absent session must NOT match a
    // question that belongs to a named session. The question is registered
    // directly, so the test does not depend on a live turn.
    const { QuestionView } = await import("./runtime/question-view.js");
    const { PendingQuestion, QuestionRegistry } = await import("./question-registry.js");
    const registry = new QuestionRegistry();
    const view = new QuestionView(registry, { emit: () => {}, turnOf: () => 0 });
    registry.add(
      new PendingQuestion({
        requestId: "q-1",
        sessionId: "ws/other",
        questions: [{ id: "mode", question: "?", options: [{ label: "a" }] }] as never,
        expiresAt: Date.now() + 60_000,
        timeoutMs: 60_000,
      }),
    );
    expect(view.answer("q-1", [{ id: "mode", selected: ["a"] }])).toEqual({ ok: false, reason: "mismatch" });
    expect(view.answer("q-1", [{ id: "mode", selected: ["a"] }], "ws/other")).toEqual({ ok: true, session: "ws/other" });
  });
});
