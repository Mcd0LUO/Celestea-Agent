/**
 * W729 (P0) — the mode-dependent prompt over the REAL engine (R3/M5).
 *
 * This is the module that proves the "assembly sinks into the session" change:
 * two sessions in ONE process, one `standard` and one `execution`, each get
 * their OWN system prompt — asserted on the requests the engine actually sent
 * to the model, not on a re-derivation of the same function.
 *
 * The three P0 invariants are asserted here or next to the code they pin:
 *   ① a session without `session.json.mode` behaves exactly as before (no
 *     per-session override at all: it keeps the base prompt; its meta file is
 *     byte-identical — `store/sessions.test.ts`);
 *   ② **superseded by P1 (W791)**: P0 asserted both modes expose the SAME tool
 *     face; P1 folds the SDK tools out of `execution`'s direct face, so the
 *     invariant is now the M7 difference (11 standard / 6 execution) asserted in
 *     `mode-exposure.test.ts` and, over the real engine, below;
 *   ③ `API_ENDPOINT_COUNT` was unchanged by W729 itself (44 on that day; W791's
 *     `POST /api/sessions/{id}/mode` moved it 50 -> 51).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "@celestea/core";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness, waitIdle } from "./test-util.js";
import type { OfflineStep } from "./offline-llm.js";

const EXECUTION_MARK = "Execution mode — prefer one program over many round trips";
const STANDARD_MARK = "stepping through the tools one at a time is the normal path here";

const harnesses: StudioHarness[] = [];

/** One process, two sessions: `std` (standard) and `exec` (execution). */
function twoModes(requested: ModelRequest[] = []): StudioHarness {
  const script: OfflineStep[] = [];
  const h = makeEngineHarness({
    sessions: { std: [], exec: [], plain: [] },
    meta: { std: { mode: "standard" }, exec: { mode: "execution" } },
    llm: { script, onRequest: (req) => requested.push(req) },
  });
  script.push({ text: "答 A" }, { text: "答 B" }, { text: "答 C" });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function systemOf(h: StudioHarness, id: string): string {
  return String((h.runtime as { sessionContext: (s: string) => { system: string } }).sessionContext(id).system);
}

describe("W729 per-session mode prompts (real engine, one process)", () => {
  it("M5/R3: each session's OWN instance carries its own mode prompt", async () => {
    const requested: ModelRequest[] = [];
    const h = twoModes(requested);
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");

    expect(systemOf(h, "sample-ws/std")).toContain(STANDARD_MARK);
    expect(systemOf(h, "sample-ws/std")).not.toContain(EXECUTION_MARK);
    expect(systemOf(h, "sample-ws/exec")).toContain(EXECUTION_MARK);
    expect(systemOf(h, "sample-ws/exec")).toContain("ToolCallError");
    // The base (detached) generation is NOT where the execution session reads
    // from — that is exactly the silent bug R3 warns about.
    expect(engineOf(h).profile().system_prompt).toContain(STANDARD_MARK);

    // Both sessions run a turn in the SAME process; the requests the engine
    // really sent carry the matching prompt.
    await h.app.request("/api/turn", jsonRequest("POST", { input: "标准任务", session: "sample-ws/std" }));
    await waitIdle(h);
    await h.app.request("/api/turn", jsonRequest("POST", { input: "执行任务", session: "sample-ws/exec" }));
    await waitIdle(h);
    const systems = requested.map((r) => `${firstUser(r)}::${r.system ?? ""}`);
    const standard = systems.find((s) => s.startsWith("标准任务::"));
    const execution = systems.find((s) => s.startsWith("执行任务::"));
    expect(standard).toContain(STANDARD_MARK);
    expect(standard).not.toContain(EXECUTION_MARK);
    expect(execution).toContain(EXECUTION_MARK);

    // S1: /api/config answers for the FOCUSED session (activated last = exec).
    const config = await getJson(h.app, "/api/config");
    expect(String(config.body["system_prompt"])).toContain(EXECUTION_MARK);
  });

  it("R3 (reverse): a prompt hot-apply primes the BASE prompt mode-neutrally", async () => {
    const h = twoModes();
    await activate(h, "sample-ws/exec");
    // The focused session IS execution-mode here; a prompt write re-primes the
    // base generation, which must NOT adopt that session's variant — otherwise
    // every session without a mode would silently inherit it.
    const applied = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1", section_overrides: { context: "ctx" } }));
    expect(applied.body["ok"]).toBe(true);
    expect(engineOf(h).profile().system_prompt).toContain(STANDARD_MARK);
    expect(engineOf(h).profile().system_prompt).not.toContain(EXECUTION_MARK);
    // …while the focused-session view still shows the execution variant.
    expect(String((await getJson(h.app, "/api/config")).body["system_prompt"])).toContain(EXECUTION_MARK);
    // And a no-mode session (base prompt) is untouched by the execution mode.
    await activate(h, "sample-ws/plain");
    expect(systemOf(h, "sample-ws/plain")).not.toContain(EXECUTION_MARK);
  });

  it("M5/M9: the {{tools}} variable of each prompt is that session's own tool face", async () => {
    const h = twoModes();
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    for (const id of ["sample-ws/std", "sample-ws/exec"]) {
      const names = h.runtime
        .sessionContext(id)
        .tools.map((t) => t.name)
        .sort();
      // The rendered list is the SAME list the session exposes (S2/M9 shape) —
      // and since W791 the two modes differ, so the list itself is the mode.
      expect(systemOf(h, id)).toContain(`directly (${names.join(", ")})`);
    }
  });

  it("M7 (P1, supersedes P0 invariant ②): execution folds the direct face, standard does not", async () => {
    const h = twoModes();
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    const faceOf = (id: string): string[] => h.runtime.sessionContext(id).tools.map((t) => t.name).sort();
    // W783: 10 -> 11 (ask_user_question); W804: 11 -> 12 (read_image, mounted
    // because the session has an attachment store); W791: execution = the 6 kept
    // names (read_image is folded there, like every non-keep tool).
    expect(faceOf("sample-ws/std")).toEqual(["ask_user_question", "browser_act", "browser_open", "forget", "http_request", "list_dir", "load_skill", "process_control", "read_file", "read_image", "remember", "run_code", "run_shell", "send_message", "spawn_worker", "stop_worker", "update_tasks", "worker_status", "write_file"]);
    expect(faceOf("sample-ws/exec")).toEqual(["browser_act", "browser_open", "forget", "http_request", "load_skill", "process_control", "remember", "run_code", "send_message", "spawn_worker", "stop_worker", "update_tasks", "worker_status"]);
  });

  it("P0 invariant ①: a session WITHOUT session.json.mode keeps the DEFAULT mode prompt", async () => {
    const h = twoModes();
    await activate(h, "sample-ws/plain");
    // W768: "no mode key" still means the default (standard) mode text, but the
    // prompt is assembled for THIS session — its own workspace/session/工具面 —
    // instead of being inherited from whichever session was active at startup
    // (that inheritance is what let a prompt name a workspace the tools do not
    // run in).
    expect(systemOf(h, "sample-ws/plain")).toContain(STANDARD_MARK);
    expect(systemOf(h, "sample-ws/plain")).not.toContain(EXECUTION_MARK);
    expect(systemOf(h, "sample-ws/plain")).toContain("the active session is sample-ws/plain");
    expect(systemOf(h, "sample-ws/plain")).not.toBe(engineOf(h).profile().system_prompt);
    const rows = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r["id"] === "sample-ws/plain")?.["mode"]).toBe("standard");
  });

  it("M11: a spawned worker inherits the parent mode and its report says so", async () => {
    const h = twoModes();
    await activate(h, "sample-ws/exec");
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "do it", title: "T", session: "sample-ws/exec" }));
    expect(spawn.body["ok"]).toBe(true);

    const rows = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r["kind"] === "worker")).toMatchObject({ mode: "execution" });

    // The receipt protocol writes `- mode: execution` into the report header.
    const dir = join(h.root, "worker-results");
    const deadline = Date.now() + 4_000;
    let report = "";
    while (Date.now() < deadline) {
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
      if (files.length > 0) {
        report = readFileSync(join(dir, files[0] as string), "utf8");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(report).toContain("- mode: execution");
  });
});

/** Text of the first user message of a captured request (test bookkeeping). */
function firstUser(req: ModelRequest): string {
  for (const m of req.messages) {
    if (m.role !== "user") continue;
    return m.content.map((c) => (c.type === "text" ? c.content : "")).join("");
  }
  return "";
}
