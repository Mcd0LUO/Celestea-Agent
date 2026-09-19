/**
 * W860 acceptance at the HTTP surface: the session-level TOOL SWITCHES
 * (GET|PUT /api/sessions/{id}/tools) over the REAL adapter.
 *
 * The invariant under test is W791 §10.5 #2 extended to the new deny source:
 * the stored disabled list reaches the COMPOSED instance (the registry the agent
 * loop dispatches through), the reported face of GET /api/tools?session= and the
 * adapter's own sessionTools seam — all three agree, and they only ever SUBTRACT.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "./harness.test-util.js";
import { effectiveGrantsOf } from "./runtime/engine-grants.js";
import type { RealRuntimeAdapter } from "./runtime/real-runtime-adapter.js";
import { engineOf, makeEngineHarness } from "./runtime/test-util.js";
import { FILE_MODES_MEANINGFUL } from "@celestea/tools";

const S1 = "sample-ws/s1";
const S2 = "sample-ws/s2";
const EXEC = "sample-ws/exec";
const S1_URL = "/api/sessions/" + encodeURIComponent(S1) + "/tools";
/**
 * Pin the permission env the ENGINE reads so the developer's shell cannot decide
 * the preset these tests start from (the HTTP handlers read process.env, which
 * the suite never sets).
 */
const ENV: NodeJS.ProcessEnv = { CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" };

/** The frozen standard face of the production registry (W791/W804/W7/W884/F4: 16). */
const STANDARD_FACE: readonly string[] = [
  "ask_user_question",
  "browser_act",
  "browser_open",
  "http_request",
  "list_dir",
  "load_skill",
  "process_control",
  "read_file",
  "read_image",
  "run_code",
  "run_shell",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "worker_status",
  "write_file",
].sort();

/** The execution-mode face (W791 M7; W884 keeps load_skill): the fold, before any deny. */
const EXECUTION_FACE: readonly string[] = [
  "browser_act",
  "browser_open",
  "http_request",
  "load_skill",
  "process_control",
  "run_code",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "worker_status",
].sort();

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function track(h: StudioHarness): StudioHarness {
  harnesses.push(h);
  return h;
}

/** The standard two-session engine harness. */
function engine(): StudioHarness {
  return track(makeEngineHarness({ sessions: { s1: [], s2: [] }, env: ENV }));
}

/** Hand-write <session dir>/permission.json — the shape the W9 writer emits. */
function writePermission(h: StudioHarness, name: string, preset: string): void {
  writeFileSync(join(h.workspace, name, "permission.json"), JSON.stringify({ version: 1, session: "sample-ws/" + name, preset, updated_at: 1_700_000_000 }));
}

/** The adapter seam behind both reported faces. */
function adapterFace(adapter: RealRuntimeAdapter, session: string): string[] {
  const sessionTools = adapter.sessionTools;
  if (sessionTools === undefined) throw new Error("the real adapter must implement sessionTools");
  return sessionTools.call(adapter, session).map((tool) => tool.name).sort();
}

/** GET /api/tools?session=... — the HTTP report face. */
async function httpFace(h: StudioHarness, session: string): Promise<string[]> {
  const res = await getJson(h.app, "/api/tools?session=" + encodeURIComponent(session));
  expect(res.status).toBe(200);
  return (res.body["tools"] as Array<{ name: string }>).map((tool) => tool.name).sort();
}

/** Both report faces plus the composed instance, asserted equal. */
async function agree(h: StudioHarness, session: string): Promise<string[]> {
  const adapter = engineOf(h);
  const composed = adapter.sessionContext(session).tools.map((tool) => tool.name).sort();
  expect(await httpFace(h, session)).toEqual(composed);
  expect(adapterFace(adapter, session)).toEqual(composed);
  return composed;
}

describe("W860 /api/sessions/{id}/tools", () => {
  it("① GET defaults to an empty disabled list and an empty effective deny", async () => {
    const h = engine();
    const res = await getJson(h.app, S1_URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, session: S1, disabled: [], effective: { toolDeny: [] } });
    // An unknown session is the store's own 404, never an empty success.
    const missing = await getJson(h.app, "/api/sessions/" + encodeURIComponent("sample-ws/nope") + "/tools");
    expect(missing.status).toBe(404);
    expect(missing.body["ok"]).toBe(false);
  });

  it("② PUT persists the list, GET reads it back and BOTH report faces lose the tool", async () => {
    const h = engine();

    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, session: S1, disabled: ["write_file"], effective: { toolDeny: ["write_file"] } });

    const get = await getJson(h.app, S1_URL);
    expect(get.body).toEqual(put.body);

    // The frozen file shape + the 0600 mode (same durability as permission.json).
    const path = join(h.workspace, "s1", "tools.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ version: 1, session: S1, disabled: ["write_file"], updated_at: expect.any(Number) });
    if (FILE_MODES_MEANINGFUL) expect(statSync(path).mode & 0o777).toBe(0o600);

    // Composed instance = HTTP report = adapter seam, and all three dropped it.
    const expected = STANDARD_FACE.filter((name) => name !== "write_file");
    expect(await agree(h, S1)).toEqual(expected);
    expect(await httpFace(h, S1)).not.toContain("write_file");

    // Writing the list back to [] restores the tool (the deny is not sticky).
    const cleared = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: [] }));
    expect(cleared.status).toBe(200);
    expect(cleared.body["disabled"]).toEqual([]);
    expect(cleared.body["effective"]).toEqual({ toolDeny: [] });
    expect(await agree(h, S1)).toEqual(STANDARD_FACE);
  });

  it("③ unions the preset deny with the session deny, preset first", async () => {
    const h = engine();
    writePermission(h, "s1", "read-only");

    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["http_request"] }));
    expect(put.status).toBe(200);
    // preset toolDeny first, session disabled second — the frozen union order.
    expect(put.body["effective"]).toEqual({ toolDeny: ["write_file", "http_request"] });

    const get = await getJson(h.app, S1_URL);
    expect(get.body["disabled"]).toEqual(["http_request"]);
    expect(get.body["effective"]).toEqual({ toolDeny: ["write_file", "http_request"] });

    const expected = STANDARD_FACE.filter((name) => name !== "write_file" && name !== "http_request");
    expect(await agree(h, S1)).toEqual(expected);
  });

  it("③b execution mode: a disabled tool that was already folded never comes back", async () => {
    const h = track(makeEngineHarness({ sessions: { exec: [] }, meta: { exec: { mode: "execution" } }, env: ENV }));
    writePermission(h, "exec", "read-only");

    // The execution face first (no tools.json).
    expect(await agree(h, EXEC)).toEqual(EXECUTION_FACE);

    // read_file is folded by the mode AND denied by the preset AND disabled by
    // the session: the intersection stays the execution face.
    const put = await getJson(h.app, "/api/sessions/" + encodeURIComponent(EXEC) + "/tools", jsonRequest("PUT", { disabled: ["read_file"] }));
    expect(put.status).toBe(200);
    expect((put.body["effective"] as { toolDeny: string[] }).toolDeny).toContain("read_file");
    expect((put.body["effective"] as { toolDeny: string[] }).toolDeny).toContain("write_file");
    expect(await agree(h, EXEC)).toEqual(EXECUTION_FACE);
    expect(await httpFace(h, EXEC)).not.toContain("read_file");
    expect(await httpFace(h, EXEC)).not.toContain("write_file");
  });

  it("④ rejects a non-array / non-string / blank entry with a 422 naming the field", async () => {
    const h = engine();
    for (const body of [{}, { disabled: "write_file" }, { disabled: [1] }, { disabled: [null] }, { disabled: [""] }, { disabled: ["  "] }]) {
      const res = await getJson(h.app, S1_URL, jsonRequest("PUT", body));
      expect(res.status).toBe(422);
      expect(res.body["ok"]).toBe(false);
      expect(String(res.body["error"])).toContain("disabled");
    }
    // None of the rejected bodies wrote a file: the session still runs untouched.
    expect(await getJson(h.app, S1_URL)).toMatchObject({ body: { disabled: [] } });
    expect(await agree(h, S1)).toEqual(STANDARD_FACE);
  });

  it("⑤ disables per session: a neighbour is unaffected", async () => {
    const h = engine();
    await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));

    const neighbour = await getJson(h.app, "/api/sessions/" + encodeURIComponent(S2) + "/tools");
    expect(neighbour.body).toEqual({ ok: true, session: S2, disabled: [], effective: { toolDeny: [] } });
    expect(await httpFace(h, S2)).toEqual(STANDARD_FACE);
    expect(await httpFace(h, S1)).toEqual(STANDARD_FACE.filter((name) => name !== "write_file"));
  });

  it("⑥ a void tools.json is fail-closed: 200, one warning, the session runs as if nothing were disabled", async () => {
    const h = engine();
    const path = join(h.workspace, "s1", "tools.json");
    const voidBodies = [
      "{ nope",
      JSON.stringify({ version: 2, session: S1, disabled: ["write_file"] }),
      JSON.stringify({ version: 1, session: "sample-ws/other", disabled: ["write_file"] }),
      JSON.stringify({ version: 1, session: S1, disabled: "write_file" }),
      JSON.stringify({ version: 1, session: S1, disabled: [1] }),
      JSON.stringify(["write_file"]),
    ];
    for (const body of voidBodies) {
      writeFileSync(path, body);
      const res = await getJson(h.app, S1_URL);
      expect(res.status).toBe(200);
      expect(res.body["disabled"]).toEqual([]);
      const warnings = res.body["warnings"] as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("tools_unreadable");
      expect(warnings[0]).toContain("the session runs with no tools disabled");
      expect(await agree(h, S1)).toEqual(STANDARD_FACE);
    }
    // A later PUT repairs the file by overwriting it.
    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));
    expect(put.status).toBe(200);
    expect(await httpFace(h, S1)).toEqual(STANDARD_FACE.filter((name) => name !== "write_file"));
  });
});

describe("W860 store + reader", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A session dir at <tmp>/ws/s1 with a log; its trusted id is "ws/s1". */
  function sessionDir(name: string): string {
    const root = mkdtempSync(join(tmpdir(), "w860-tools-" + name + "-"));
    roots.push(root);
    const dir = join(root, "ws", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli-main.jsonl"), "");
    return dir;
  }

  function envOf(dir: string): NodeJS.ProcessEnv {
    return { CELESTEA_WORKSPACES_FILE: join(dirname(dir), "workspaces.json"), HOME: process.env["HOME"] ?? "/home/nobody" };
  }

  const NOW = 1_700_000_500;

  it("a session deny joins toolDeny and changes NO other cap; a broken file only warns", () => {
    const dir = sessionDir("cap");
    writeFileSync(
      join(dir, "grants.json"),
      JSON.stringify({
        version: 1,
        session: "ws/s1",
        updated_at: 1,
        grants: [{ id: "g-net", cap: "net_hosts", scope: { hosts: ["10.1.2.3"] }, granted_at: 1_700_000_000, granted_by: "hand", expires_at: null, uses_left: null, note: "" }],
      }),
    );
    const before = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(before.grants.netHosts).toEqual(["10.1.2.3"]);
    expect(before.grants.toolDeny).toEqual([]);
    expect(before.warnings).toEqual([]);

    // Hand-written on purpose: blanks are dropped, duplicates collapse, order holds.
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ version: 1, session: "ws/s1", disabled: ["write_file", " http_request ", "write_file", ""] }));
    const after = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(after.grants.toolDeny).toEqual(["write_file", "http_request"]);
    expect(after.grants.netHosts).toEqual(before.grants.netHosts);
    expect(after.grants.readRoots).toEqual(before.grants.readRoots);
    expect(after.grants.writeRoots).toEqual(before.grants.writeRoots);
    expect(after.grants.toolExtra).toEqual(before.grants.toolExtra);
    expect(after.grants.unsandboxed).toBe(before.grants.unsandboxed);
    expect(after.grants.network).toBe(before.grants.network);
    expect(after.grants.workspaceWritable).toBe(before.grants.workspaceWritable);
    expect(after.warnings).toEqual([]);

    writeFileSync(join(dir, "tools.json"), "{ nope");
    const broken = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(broken.grants.toolDeny).toEqual([]);
    expect(broken.grants.netHosts).toEqual(before.grants.netHosts);
    expect(broken.warnings).toHaveLength(1);
    expect(broken.warnings[0]).toContain("tools_unreadable");
  });

  it("keeps the no-sessionDir path byte-identical (toolDeny stays empty)", () => {
    expect(effectiveGrantsOf(null, null, {}, NOW).grants.toolDeny).toEqual([]);
  });
});
