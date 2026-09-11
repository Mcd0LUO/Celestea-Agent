/**
 * Checkpoint + boot recovery through the PRODUCTION app (iteration E §1.3 P0,
 * assertions A1–A3/A5/A9 at the host boundary).
 *
 * What only this level can prove:
 *   - the studio BOOTS by closing the turn the previous process died inside
 *     (the recovery decision must run before any instance composes);
 *   - a live turn writes the sidecar through the REAL wiring (turn_start /
 *     turn_end / clean shutdown), so "was the last exit clean?" is answerable;
 *   - the session-local turn number comes back from the log, not from 0;
 *   - the second boot changes NOTHING on disk (idempotence), and P0 adds no
 *     endpoint (44 stays 44).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { serializeEventLog } from "@celestea/runtime";
import type { RealRuntimeAdapter } from "./real-runtime-adapter.js";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { createOfflineLlm } from "./offline-llm.js";
import { createRealRuntimeAdapter } from "./real-runtime-adapter.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-abcdef01", pid: 4321 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function turn(n: number, outcome: "completed" | "interrupted" = "completed"): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `问 ${n}` },
    { type: "assistant_message", text: `答 ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome },
  ];
}

/** The log a `kill -9` mid-turn leaves behind: turns 0..3 plus an open turn-4. */
function crashedEvents(): SessionEvent[] {
  return [...turn(0), ...turn(1), ...turn(2), ...turn(3), { type: "turn_start", id: "turn-4" }, { type: "user_message", text: "崩在这里" }];
}

function checkpointBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    session: SESSION,
    pid: 111,
    boot_id: "b-previous",
    updated_at: 100,
    clean_shutdown: false,
    open_turn: { id: "turn-4", started_at: 100 },
    last_outcome: null,
    degraded: { log_write_errors: 0 },
    lanes: { next_turn: [], next_step: [] },
    repaired: [],
    ...patch,
  };
}

interface Host {
  studio: StudioApp;
  app: Hono;
  root: string;
  logPath: string;
  checkpointPath: string;
  env: NodeJS.ProcessEnv;
}

interface HostOptions {
  events?: readonly SessionEvent[];
  /** `null` = plant no sidecar at all. */
  checkpoint?: Record<string, unknown> | null;
  active?: string | null;
}

/** A data root holding ONE crashed session, then the app that boots over it. */
function makeHost(opts: HostOptions = {}): Host {
  const root = mkdtempSync(join(tmpdir(), "resume-"));
  roots.push(root);
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  const staticRoot = join(root, "dist");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>resume</title>\n");
  writeFileSync(join(sessionDir, "cli-main.jsonl"), serializeEventLog(opts.events ?? crashedEvents()));
  if (opts.checkpoint !== null) writeFileSync(join(sessionDir, "checkpoint.json"), `${JSON.stringify(opts.checkpoint ?? checkpointBody(), null, 2)}\n`);
  const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  write(join(root, "workspaces.json"), { workspaces: [{ path: workspace }], active_session: opts.active === undefined ? SESSION : opts.active });
  write(join(root, "prompts.json"), {});
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  env["CELESTEA_API_KEY"] = "test-key";
  env["CELESTEA_TOOL_ROOTS"] = workspace;
  env["CELESTEA_SANDBOX_NET"] = "0";
  writeFileSync(join(sessionDir, "session.json"), JSON.stringify({}));
  // ONE app: `boot` is what runs recovery, and the turn below must run on the
  // SAME adapter that owns the recovered instance.
  const studio = buildApp(root, staticRoot, env);
  return { studio, app: studio.app, root, logPath: join(sessionDir, "cli-main.jsonl"), checkpointPath: join(sessionDir, "checkpoint.json"), env };
}

function buildApp(root: string, staticRoot: string, env: NodeJS.ProcessEnv): StudioApp {
  const config = loadStudioConfig({ cwd: root, env, paths: { staticRoot } });
  return createStudioApp({
    config,
    env,
    runtime: (stores) =>
      createRealRuntimeAdapter({
        profile: {
          model: "offline-model",
          base_url: "http://127.0.0.1:9/v1",
          api_key_env: "CELESTEA_API_KEY",
          reasoning_effort: null,
          max_steps: 4096,
          max_parallel_tool_calls: 4,
          max_output_tokens: null,
          context_window: 1_000_000,
          system_prompt: "engine identity prompt",
        },
        env,
        llm: () => createOfflineLlm(),
        resultsDir: join(root, "worker-results"),
        checkpoint: { identity: IDENTITY, now: () => 7_000 },
        resolveSession: (id) => {
          const resolved = stores.sessions.require(id);
          return resolved.ok ? { sessionId: id, dir: resolved.value.dir } : null;
        },
      }),
  });
}

function rows(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function sidecar(host: Host): Record<string, unknown> {
  return JSON.parse(readFileSync(host.checkpointPath, "utf8")) as Record<string, unknown>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitIdle(studio: StudioApp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (studio.services.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("turn did not settle");
    await sleep(2);
  }
  await sleep(2);
}

describe("boot recovery through the production app", () => {
  it("A1/A2: closes the interrupted turn once, and the second boot is a no-op", () => {
    const host = makeHost();
    // Boot happened inside `makeHost`: the crash recovery must already be on disk.
    const lines = rows(host.logPath);
    expect(lines).toHaveLength(19); // 18 rows of the crash + the one repair
    expect(JSON.parse(lines[lines.length - 1] as string)).toEqual({ type: "turn_end", id: "turn-4", outcome: "interrupted" });
    const cp = sidecar(host);
    expect(cp["open_turn"]).toBeNull();
    expect(cp["last_outcome"]).toBe("interrupted");
    expect(cp["repaired"]).toMatchObject([{ action: "synthesize_turn_end", turn_id: "turn-4" }]);
    expect(typeof (cp["repaired"] as Array<{ at: unknown }>)[0]?.at).toBe("number");
    // Boot recovery writes the identity of THIS process (the one that repaired).
    expect(String(cp["boot_id"])).toMatch(/^b-[0-9a-f]{8}$/);
    expect(cp["pid"]).toBe(process.pid);

    // A SECOND boot over the same root must not touch either file.
    const logBytes = sha256(host.logPath);
    const cpBytes = sha256(host.checkpointPath);
    buildApp(host.root, join(host.root, "dist"), host.env);
    expect(sha256(host.logPath)).toBe(logBytes);
    expect(sha256(host.checkpointPath)).toBe(cpBytes);
    expect(rows(host.logPath)).toHaveLength(19);
  });

  it("A3: no sidecar means no repair (the dangling turn is left as history)", () => {
    const host = makeHost({ checkpoint: null });
    const lines = rows(host.logPath);
    expect(lines).toHaveLength(18);
    expect(JSON.parse(lines[lines.length - 1] as string)).toMatchObject({ type: "user_message", text: "崩在这里" });
  });

  it("A9: clean_shutdown: true means the exit was graceful — the log is not repaired", () => {
    const host = makeHost({ checkpoint: checkpointBody({ clean_shutdown: true }) });
    expect(rows(host.logPath)).toHaveLength(18);
  });

  it("does nothing when no session is active", () => {
    const host = makeHost({ active: null });
    expect(rows(host.logPath)).toHaveLength(18);
  });

  it("A5: the next turn continues the log's numbering and the sidecar sees the boundary", async () => {
    const host = makeHost();
    const res = await host.app.request("/api/turn", jsonRequest("POST", { input: "继续" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    // 5 turns are in the log (0..3 completed + the recovered 4): the new one is
    // the 6th, and its id is the log's own next id — never a reused "turn-0".
    expect(body["turn"]).toBe(6);
    await waitIdle(host.studio);

    const events = rows(host.logPath).map((line) => JSON.parse(line) as SessionEvent);
    const starts = events.filter((ev) => ev.type === "turn_start");
    expect(starts.map((ev) => ev.id)).toEqual(["turn-0", "turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    // A normal ending leaves NOTHING dangling: every started turn has its end.
    expect(events.filter((ev) => ev.type === "turn_end").map((ev) => ev.id)).toEqual(starts.map((ev) => ev.id));
    const cp = sidecar(host);
    expect(cp["open_turn"]).toBeNull();
    expect(cp["last_outcome"]).toBe("completed");

    // A graceful shutdown is what makes the NEXT boot skip the repair.
    await (host.studio.services.runtime as RealRuntimeAdapter).shutdown();
    const after = sidecar(host);
    expect(after["clean_shutdown"]).toBe(true);
    expect(after["open_turn"]).toBeNull();

    // P0 adds no endpoint: the diagnostic surface stays P1.
    expect((await host.app.request("/api/status")).status).toBe(200);
    expect((await host.app.request("/api/recovery")).status).toBe(404);
  });
});
