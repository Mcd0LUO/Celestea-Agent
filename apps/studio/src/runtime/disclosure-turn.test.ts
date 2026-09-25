/**
 * W806 (P0) — dynamic tool disclosure over the REAL engine, across TURNS.
 *
 * This is the assertion the cache argument rests on (design §3.5/§7.1):
 *
 *   - the sequence of tool arrays the provider is ACTUALLY sent is monotonic,
 *     tail-appending and order-stable — every later request keeps the earlier
 *     array as a byte prefix, and the only growth is the newly disclosed name
 *     at the TAIL;
 *   - a direct call to a withheld tool is refused BEFORE execution
 *     (`tool_unavailable_in_mode` in the session log), and the SAME session
 *     discloses it at the NEXT turn boundary ("被拒后披露", Q1);
 *   - the system prompt and the `{{tools}}` universe NEVER move: system text is
 *     serialized before tools, so following disclosure there would invalidate
 *     the request from token 0 (S3);
 *   - within ONE turn the face is frozen: no per-step churn.
 *
 * Everything runs the production HTTP contract + the real `packages/runtime`
 * engine (offline LLM, real tools); only the model is local.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "@celestea/core";
import { TOOL_UNAVAILABLE_CODE } from "@celestea/tools";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, readSessionLog, waitIdle } from "./test-util.js";
import type { OfflineStep } from "./offline-llm.js";

/** The 19 contract tools of a standard-mode session (W884: load_skill; F4: browser; B2: remember/forget; W1533: update_tasks). */
const STANDARD_FACE = [
  "ask_user_question",
  "browser_act",
  "browser_open",
  "forget",
  "http_request",
  "list_dir",
  "load_skill",
  "process_control",
  "read_file",
  "read_image",
  "remember",
  "run_code",
  "run_shell",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "update_tasks",
  "worker_status",
  "write_file",
];
/** The one name withheld at compose time; everything else is offered. */
const WITHHELD = "read_file";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Tool names of one request, in wire order. */
function names(req: ModelRequest): string[] {
  return req.tools.map((tool) => tool.name);
}

/** The sorted name set `GET /api/tools?session=` answers. */
async function toolsOf(h: StudioHarness, session: string): Promise<string[]> {
  const body = (await getJson(h.app, `/api/tools?session=${encodeURIComponent(session)}`)).body;
  return (body["tools"] as Array<{ name: string }>).map((tool) => tool.name).sort();
}

/** The `{{tools}}` list `GET /api/config` renders for the FOCUSED session. */
async function renderedTools(h: StudioHarness): Promise<string[]> {
  const prompt = String((await getJson(h.app, "/api/config")).body["system_prompt"]);
  const match = /directly \(([^)]*)\)/.exec(prompt);
  expect(match, "the assembled prompt must render the {{tools}} list").not.toBeNull();
  return String(match?.[1]).split(", ").sort();
}

describe("W806 P0 dynamic tool disclosure across turns (real engine)", () => {
  it("append-only across turns, refused direct call, static {{tools}} universe", async () => {
    const requests: ModelRequest[] = [];
    const script: OfflineStep[] = [
      { tool_calls: [{ id: "c1", name: WITHHELD, args: { path: "/tmp/w806-withheld.txt" } }] },
      { text: "done 1" },
      { text: "done 2" },
    ];
    const h = makeEngineHarness({
      sessions: { plain: [] },
      llm: { script, onRequest: (req) => requests.push(req) },
      disclosure: { initial: STANDARD_FACE.filter((name) => name !== WITHHELD) },
    });
    harnesses.push(h);
    await activate(h, "sample-ws/plain");

    // Turn 1: the direct call to the withheld tool is refused, then the model
    // answers; turn 2 is where the SAME session must disclose it.
    expect((await h.app.request("/api/turn", jsonRequest("POST", { input: "t1", session: "sample-ws/plain" }))).status).toBe(202);
    await waitIdle(h);
    expect((await h.app.request("/api/turn", jsonRequest("POST", { input: "t2", session: "sample-ws/plain" }))).status).toBe(202);
    await waitIdle(h);

    // ① The refusal really happened, before execution, on the production path.
    const log = readSessionLog(h, "plain");
    expect(log).toContain(TOOL_UNAVAILABLE_CODE);
    expect(log).toContain(WITHHELD);
    expect(log).toContain("done 1"); // the turn still completed after the refusal

    // ② Turn 1 sent the initial face; turn 2 appended the refused name at the TAIL.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const first = names(requests[0] as ModelRequest);
    expect(first).not.toContain(WITHHELD);
    expect(first).toContain("run_code");
    const second = names(requests[1] as ModelRequest);
    expect(second).toEqual(first); // turn-internal freeze: no per-step churn
    const third = names(requests[2] as ModelRequest);
    expect(third.slice(0, first.length)).toEqual(first); // monotonic + tail append
    expect(third.slice(first.length)).toEqual([WITHHELD]);
    expect(new Set(third).size).toBe(third.length);

    // ③ EVERY request keeps the earlier tools array as a prefix (append-only).
    for (let i = 1; i < requests.length; i += 1) {
      const prev = names(requests[i - 1] as ModelRequest);
      const cur = names(requests[i] as ModelRequest);
      expect(cur.slice(0, prev.length)).toEqual(prev);
    }

    // ④ The system prompt NEVER follows disclosure (S3): identical on every step.
    expect(new Set(requests.map((req) => req.system)).size).toBe(1);

    // ⑤ {{tools}} / GET /api/tools announce the static DISCLOSABLE UNIVERSE, not
    //    the per-turn subset — the prompt must not list a tool it then refuses…
    //    it lists the universe and the refusal prose explains the withholding.
    expect(await toolsOf(h, "sample-ws/plain")).toEqual(STANDARD_FACE);
    expect(await renderedTools(h)).toEqual(STANDARD_FACE);
  });

  it("without activation the face is the byte-identical mode baseline", async () => {
    const requests: ModelRequest[] = [];
    const h = makeEngineHarness({
      sessions: { plain: [] },
      llm: { script: [{ text: "done" }], onRequest: (req) => requests.push(req) },
    });
    harnesses.push(h);
    await activate(h, "sample-ws/plain");
    expect(await toolsOf(h, "sample-ws/plain")).toEqual(STANDARD_FACE);
    expect((await h.app.request("/api/turn", jsonRequest("POST", { input: "t", session: "sample-ws/plain" }))).status).toBe(202);
    await waitIdle(h);
    expect(names(requests[0] as ModelRequest).sort()).toEqual(STANDARD_FACE);
  });
});
