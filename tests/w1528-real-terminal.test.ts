/**
 * W1528 — the workbench terminal is a REAL pty.
 *
 * What this suite pins (each assertion has a mutation negative control in the
 * report, not in this file):
 *   1. the permission gate is the SAME one `/api/exec` uses — a preset that
 *      denies `run_shell` gets a structured 403, never a bare run;
 *   2. the pty is REAL — a prompt appears, `echo` answers, and an INTERACTIVE
 *      command (`cat`) proves stdin reaches the child;
 *   3. input is byte-verbatim (no newline is invented by the server);
 *   4. close reaps the whole process tree (no leak);
 *   5. the contract's three-way count is consistent.
 *
 * The pty tests need util-linux `script(1)` AND a bubblewrap-visible workspace,
 * so they are gated on the host probe and SKIP visibly elsewhere (the repo's
 * house rule: a platform gate is never a silent pass).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { loadEndpoints, loadSse, repoRoot, SSE_EVENT_NAMES } from "@celestea/core";
import { whichSync } from "@celestea/tools";
import { API_ENDPOINT_COUNT } from "../apps/studio/src/routes.js";
import { getJson, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const S1 = "sample-ws/s1";
const SESSION = { name: "s1", log: "" };
const SCRIPT = whichSync("script");
const canPty = process.platform !== "win32" && SCRIPT !== null;

/** A custom preset that DENIES run_shell (the permission-gate negative case). */
const SHELL_DENY_PRESET = {
  id: "w1528-no-shell",
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

interface TerminalHandle {
  id: string;
  pid: number | null;
  cols: number;
  rows: number;
  sandbox: Record<string, unknown>;
}

async function open(h: StudioHarness, body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, "/api/terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: S1, ...body }),
  });
}

async function send(h: StudioHarness, id: string, text: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, `/api/terminal/${encodeURIComponent(id)}/input`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: text,
  });
}

async function close(h: StudioHarness, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, `/api/terminal/${encodeURIComponent(id)}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** Poll until `probe` is satisfied; returns the accumulated text either way. */
async function until(probe: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

/** Is `pid` alive? (`kill(pid, 0)` = existence check, no signal delivered.) */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("W1528 · contract consistency (the three-way count)", () => {
  it("keeps API_ENDPOINT_COUNT == endpoints.json count == endpoints[] length", () => {
    const c = loadEndpoints();
    expect(API_ENDPOINT_COUNT).toBe(c.count);
    expect(c.endpoints).toHaveLength(c.count);
    expect(c.count).toBe(69);
  });

  it("declares the three terminal endpoints with self-referencing docRefs", () => {
    const byId = new Map(loadEndpoints().endpoints.map((e) => [e.id, e]));
    for (const [id, path] of [
      ["post_terminal", "/api/terminal"],
      ["post_terminal_input", "/api/terminal/{id}/input"],
      ["post_terminal_close", "/api/terminal/{id}/close"],
    ] as const) {
      const e = byId.get(id);
      expect(e?.path, id).toBe(path);
      expect(e?.method, id).toBe("POST");
      // Every new endpoint points at ITSELF (the W881 docRef convention).
      expect(e?.docRef, id).toBe(`contracts/endpoints.json#${id}`);
    }
  });

  it("freezes the terminal SSE event as the 10th name, in all three places", () => {
    const s = loadSse();
    expect(s.count).toBe(10);
    expect(s.events.map((e) => e.name)).toEqual([...SSE_EVENT_NAMES]);
    expect(s.events.map((e) => e.name)).toContain("terminal");
    // The frontend's listener list must contain it too (check-sse-events.mjs
    // asserts the three-way set equality mechanically; this pins the payload).
    // `repoRoot()` (not `process.cwd()`): the suite must read the SAME file
    // wherever vitest is launched from — a cwd-relative path silently reads a
    // different checkout (or throws) when the runner is started elsewhere.
    const web = readFileSync(join(repoRoot(), "apps", "web", "src", "sse.ts"), "utf8");
    expect(web).toContain("'terminal'");
    const term = s.events.find((e) => e.name === "terminal");
    expect(term?.frontendListens).toBe(true);
    expect(Object.keys(term?.payload ?? {})).toEqual(["id", "session", "data"]);
  });
});

describe.skipIf(!canPty)("W1528 · POST /api/terminal (real pty, live)", () => {
  it("opens a pty, answers a typed command, and re-prompts (stdin + stdout both live)", async () => {
    const h = harness();
    const opened = await open(h, { cols: 100, rows: 30 });
    expect(opened.status).toBe(200);
    const t = opened.body as unknown as TerminalHandle;
    expect(t.id).toMatch(/^term-/);
    expect(typeof t.pid).toBe("number");
    // The contract fields only — no host diagnostics leak through.
    expect(Object.keys(t.sandbox).sort()).toEqual(["cpu_sec", "net_isolated", "provider", "seccomp", "tmp_private"]);
    expect(t.cols).toBe(100);
    expect(t.rows).toBe(30);

    // The bus is the output channel: collect the frames this terminal produced.
    let out = "";
    h.studio.services.bus.subscribe();
    const unsubscribe = hookTerminal(h, (frame) => {
      if (frame["id"] === t.id) out += String(frame["data"]);
    });

    await until(() => out.includes("#") || out.includes("$"));
    expect(out.length, "a real pty prints a prompt on open").toBeGreaterThan(0);

    // TYPE the command character by character (this is what the UI does), then
    // press Enter as the byte \r — the server must not invent a newline.
    for (const ch of "echo PTY-TEST") {
      await send(h, t.id, ch);
    }
    await send(h, t.id, "\r");
    await until(() => out.includes("PTY-TEST\r\n") || /PTY-TEST\s*\r?\n/.test(out));
    expect(out, "the typed command ECHOES (the pty is in cooked mode)").toContain("echo PTY-TEST");
    expect(out, "the command RAN and printed").toContain("PTY-TEST");
    // A prompt appears AGAIN after the command — that is what makes it a terminal
    // rather than one-shot execution.
    const afterCmd = out.slice(out.lastIndexOf("PTY-TEST") + "PTY-TEST".length);
    expect(afterCmd, "the prompt comes back").toMatch(/[#$]\s*$/);

    unsubscribe();
    await close(h, t.id);
    h.cleanup();
  });

  it("proves stdin is INTERACTIVE: cat echoes a line fed without a trailing newline in the body", async () => {
    const h = harness();
    const t = (await open(h)).body as unknown as TerminalHandle;
    let out = "";
    const unsubscribe = hookTerminal(h, (frame) => {
      if (frame["id"] === t.id) out += String(frame["data"]);
    });
    await until(() => out.includes("#") || out.includes("$"));

    await send(h, t.id, "cat\r");
    await until(() => out.includes("cat"));
    out = "";
    // Feed a line as separate keystrokes. `cat` only answers if the pty really
    // delivers stdin to the child — a one-shot endpoint cannot do this at all.
    await send(h, t.id, "INTERACTIVE-LINE");
    await until(() => out.includes("INTERACTIVE-LINE"));
    // ★ The discriminating assertion: BEFORE Enter the text appears EXACTLY
    // ONCE — that occurrence is the tty's own echo of the keystrokes. If the
    // server appended a newline to the input body (the mutation), the line
    // would already be complete here, `cat` would have answered, and the count
    // would be 2. This is what pins "verbatim bytes, no invented newline".
    expect(out.split("INTERACTIVE-LINE").length - 1, "typed, not yet submitted: only the tty echo").toBe(1);
    await send(h, t.id, "\r");
    await until(() => out.split("INTERACTIVE-LINE").length - 1 >= 2);
    // After Enter, `cat` echoes TWICE: the tty echo plus cat's own stdout.
    const hits = out.split("INTERACTIVE-LINE").length - 1;
    expect(hits, "cat answered only AFTER the Enter byte arrived").toBeGreaterThanOrEqual(2);

    unsubscribe();
    await close(h, t.id);
    h.cleanup();
  });

  it("REFUSES with 403 code=shell_denied when the preset denies run_shell (never a bare run)", async () => {
    const h = harness();
    // Plant the SAME permission files the /api/exec suite uses.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(h.root, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [SHELL_DENY_PRESET] }));
    writeFileSync(
      join(h.workspace, "s1", "permission.json"),
      JSON.stringify({ version: 1, session: S1, preset: SHELL_DENY_PRESET.id, updated_at: 0 }),
    );
    const res = await open(h);
    expect(res.status).toBe(403);
    expect(res.body["code"]).toBe("shell_denied");
    expect(res.body["ok"]).toBe(false);
    // And no process was created: the ceiling is untouched.
    const list = await getJson(h.app, "/api/terminal/does-not-exist/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(list.status).toBe(200);
    expect(list.body["closed"]).toBe(false);
    h.cleanup();
  });

  it("close reaps the WHOLE tree: the pty leader is gone and the id no longer routes", async () => {
    const h = harness();
    const t = (await open(h)).body as unknown as TerminalHandle;
    const pid = t.pid as number;
    expect(alive(pid), "the pty leader is alive while the terminal is open").toBe(true);

    const closed = await close(h, t.id);
    expect(closed.status).toBe(200);
    expect(closed.body["closed"]).toBe(true);
    await until(() => !alive(pid), 5_000);
    expect(alive(pid), "the pty leader is reaped by close").toBe(false);

    // Idempotent: a second close answers closed:false (never a 404), and an
    // input to a dead terminal is a structured 404 code=terminal_gone.
    expect((await close(h, t.id)).body["closed"]).toBe(false);
    const dead = await send(h, t.id, "x");
    expect(dead.status).toBe(404);
    expect(dead.body["code"]).toBe("terminal_gone");
    h.cleanup();
  });

  it("bounds the per-process terminal ceiling instead of leaking processes", async () => {
    const h = harness();
    const opened: string[] = [];
    // The ceiling is 8; the 9th must be refused, not silently accepted.
    for (let i = 0; i < 9; i += 1) {
      const res = await open(h);
      if (res.status === 200) opened.push(String(res.body["id"]));
      else {
        expect(res.status).toBe(429);
        expect(res.body["code"]).toBe("terminal_limit");
      }
    }
    expect(opened.length).toBe(8);
    for (const id of opened) await close(h, id);
    // The table is empty again ⇒ the ceiling is not permanently consumed.
    const after = await open(h);
    expect(after.status).toBe(200);
    // ★ 这一条也必须关掉。留着它 = 测试自己在宿主机上留一个孤儿 bash：
    // 用例结束、vitest worker 退出后它被 init 收养，谁也不会再回收
    // （实测抓到过：/tmp/studio-*/sample-ws 的 pty 挂在 ppid=1 下）。
    // 产品侧的泄漏由「关面板 / 导航」两条路径的用例负责，测试自己不许漏。
    await close(h, String(after.body["id"]));
    h.cleanup();
  });

  it("404s an unknown session before any process exists", async () => {
    const h = harness();
    const res = await getJson(h.app, "/api/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "sample-ws/ghost" }),
    });
    expect(res.status).toBe(404);
    h.cleanup();
  });
});

/**
 * Subscribe to the bus's `terminal` frames. The handler type lives in the web
 * package (which the root tsconfig does not load), so the frame is read as a
 * plain record here — the CONTRACT is what is being asserted, not a TS type.
 */
function hookTerminal(h: StudioHarness, onFrame: (frame: Record<string, unknown>) => void): () => void {
  const sub = h.studio.services.bus.subscribe();
  void (async () => {
    for (;;) {
      const frame = await sub.next();
      if (frame === null) return;
      if (frame.event === "terminal") onFrame(frame.envelope.payload as Record<string, unknown>);
    }
  })();
  return () => sub.close();
}

describe.skipIf(canPty)("W1528 · platform gate (visible skip, never a silent pass)", () => {
  it("skips the live pty cases: this host has no util-linux script(1)", () => {
    expect(SCRIPT).toBeNull();
    expect(existsSync("/usr/bin/script")).toBe(false);
  });
});
