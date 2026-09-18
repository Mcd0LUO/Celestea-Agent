/**
 * W864: `allPaths` — the full-access baseline opens the whole filesystem.
 *
 * The product decision (operator ask): the default preset is `full-access`, and
 * full access must mean ALL directories, read AND write. The capability is
 * deliberately PATH-ONLY: network, unsandboxed and the W860 session toolDeny
 * union stay exactly where they were.
 *
 * This file asserts the two layers the design touches end to end:
 *   1. the baseline (store/permissions.ts + runtime/engine-permissions.ts);
 *   2. the composed EffectiveGrants (runtime/engine-grants.ts) — `readRoots` and
 *      `writeRoots` both become ["/"], which is what the path guard
 *      (packages/tools) and the bwrap argv (sandbox) consume.
 * The guard/argv side is asserted in packages/tools (guard.test.ts,
 * sandbox/w9-rw-roots.test.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import { bwrapOptionsFromEnv, buildBwrapArgv } from "@celestea/tools";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { effectiveGrantsOf } from "./runtime/engine-grants.js";
import { effectivePermissionOf } from "./runtime/engine-permissions.js";
import { engineTools } from "./runtime/engine-plugins.js";
import { createOfflineLlm } from "./runtime/offline-llm.js";

const roots: string[] = [];
const harnesses: StudioHarness[] = [];
const S1 = "sample-ws%2Fs1";
const NOW = 1_700_000_500;

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The minimal offline profile `engineTools` needs (same shape as grants.test.ts). */
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

/** A session dir with a `cli-main.jsonl`, inside a 2-level workspace layout. */
function sessionDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "allpaths-" + name + "-"));
  roots.push(dir);
  const session = join(dir, "ws", "s1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "cli-main.jsonl"), "");
  return session;
}

function envOf(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME: process.env["HOME"] ?? "/home/nobody", ...extra };
}

function open(): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(h);
  return h;
}

/** The exact custom-preset wire shape (mirrors contracts/endpoints.json). */
function presetBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "wide-path", label: "wide path", network: false, workspaceWritable: false, toolRootsWritable: false, writeRoots: [], allPaths: false, unsandboxed: false, toolDeny: [], ...over };
}

describe("W864 allPaths — the baseline", () => {
  it("the default full-access baseline sets allPaths and BOTH effective root lists to ['/']", () => {
    const dir = sessionDir("default");
    const baseline = effectivePermissionOf(dir, envOf(dir));
    expect(baseline.preset).toBe("full-access");
    expect(baseline.allPaths).toBe(true);
    const grants = effectiveGrantsOf(dir, envOf(dir), NOW).grants;
    expect(grants.readRoots).toEqual(["/"]);
    expect(grants.writeRoots).toEqual(["/"]);
    // Unchanged caps: only the paths moved.
    expect(grants.network).toBe(true);
    expect(grants.workspaceWritable).toBe(true);
    expect(grants.toolExtra).toEqual([]);
  });

  it("CELESTEA_PERMISSION_MAX=write-read clamps allPaths away (no '/' anywhere)", () => {
    const dir = sessionDir("clamp");
    const env = envOf(dir, { CELESTEA_PERMISSION_MAX: "write-read" });
    expect(effectivePermissionOf(dir, env).allPaths).toBe(false);
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    expect(grants.readRoots).toEqual([]);
    expect(grants.writeRoots).toEqual([]);
    expect(grants.workspaceWritable).toBe(true); // write-read keeps the workspace
  });

  it("CELESTEA_PERMISSION_MAX=read-only clamps it away too (and keeps the preset's toolDeny)", () => {
    const dir = sessionDir("ro");
    const env = envOf(dir, { CELESTEA_PERMISSION_MAX: "read-only" });
    expect(effectivePermissionOf(dir, env).allPaths).toBe(false);
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    expect(grants.readRoots).toEqual([]);
    expect(grants.writeRoots).toEqual([]);
    expect(grants.workspaceWritable).toBe(false);
    expect(grants.toolDeny).toContain("write_file");
  });

  it("a custom preset may declare allPaths; it wins for the paths and changes nothing else", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "allpaths-custom-"));
    roots.push(dataDir);
    const dir = sessionDir("custom");
    writeFileSync(join(dataDir, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [presetBody({ id: "wide-path", allPaths: true })] }));
    writeFileSync(join(dir, "permission.json"), JSON.stringify({ version: 1, session: "ws/s1", preset: "wide-path", updated_at: 0 }));
    const env = envOf(dataDir);
    const baseline = effectivePermissionOf(dir, env);
    expect(baseline).toMatchObject({ preset: "wide-path", allPaths: true, network: false, unsandboxed: false });
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    expect(grants.readRoots).toEqual(["/"]);
    expect(grants.writeRoots).toEqual(["/"]); // allPaths opens writes even with workspaceWritable:false
    expect(grants.network).toBe(false); // path-only: network is untouched
    expect(grants.network === false && grants.unsandboxed === false).toBe(true);
  });

  it("keeps the W860 session toolDeny union intact under allPaths", () => {
    const dir = sessionDir("tooldeny");
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ version: 1, session: "ws/s1", disabled: ["write_file", "http_request"] }));
    const grants = effectiveGrantsOf(dir, envOf(dir), NOW).grants;
    expect(grants.readRoots).toEqual(["/"]);
    expect(grants.writeRoots).toEqual(["/"]);
    expect(grants.toolDeny).toEqual(["write_file", "http_request"]);
  });

  it("unknown/corrupt allPaths values read as false (whitelist parse, never truthy-coerced)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "allpaths-parse-"));
    roots.push(dataDir);
    const dir = sessionDir("parse");
    writeFileSync(join(dataDir, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [presetBody({ id: "noisy", allPaths: "true" })] }));
    writeFileSync(join(dir, "permission.json"), JSON.stringify({ version: 1, session: "ws/s1", preset: "noisy", updated_at: 0 }));
    expect(effectivePermissionOf(dir, envOf(dataDir)).allPaths).toBe(false);
    expect(effectiveGrantsOf(dir, envOf(dataDir), NOW).grants.readRoots).toEqual([]);
  });
});

describe("W864 allPaths — the HTTP face", () => {
  it("GET /api/permissions/presets: only the full-access built-in carries allPaths", async () => {
    const h = open();
    const res = await getJson(h.app, "/api/permissions/presets");
    expect(res.status).toBe(200);
    const builtin = res.body["builtin"] as Array<{ id: string; allPaths: boolean }>;
    expect(builtin.map((p) => [p.id, p.allPaths])).toEqual([
      ["read-only", false],
      ["write-read", false],
      ["full-access", true],
    ]);
  });

  it("GET/PUT /api/sessions/{id}/permission: effective.allPaths follows the chosen preset", async () => {
    const h = open();
    const def = await getJson(h.app, "/api/sessions/" + S1 + "/permission");
    expect(def.body["preset"]).toBe("full-access");
    expect((def.body["effective"] as { allPaths: boolean }).allPaths).toBe(true);

    const set = await getJson(h.app, "/api/sessions/" + S1 + "/permission", jsonRequest("PUT", { preset: "read-only" }));
    expect(set.status).toBe(200);
    expect((set.body["effective"] as { allPaths: boolean }).allPaths).toBe(false);
    const ro = await getJson(h.app, "/api/sessions/" + S1 + "/permission");
    expect((ro.body["effective"] as { allPaths: boolean }).allPaths).toBe(false);
    expect((ro.body["effective"] as { writeRoots: string[] }).writeRoots).toEqual([]); // the preset's own extra roots, not the allPaths expansion
  });

  it("POST /api/permissions/presets round-trips allPaths and defaults a missing one to false", async () => {
    const h = open();
    const wide = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: presetBody({ id: "wide-path", allPaths: true }) }));
    expect(wide.status).toBe(200);
    expect((wide.body["preset"] as { allPaths: boolean }).allPaths).toBe(true);
    const listed = await getJson(h.app, "/api/permissions/presets");
    expect((listed.body["custom"] as Array<{ id: string; allPaths: boolean }>)[0]).toMatchObject({ id: "wide-path", allPaths: true });

    const withoutField = presetBody({ id: "plain" });
    delete withoutField["allPaths"];
    const plain = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: withoutField }));
    expect(plain.status).toBe(200);
    expect((plain.body["preset"] as { allPaths: boolean }).allPaths).toBe(false);
  });
});


describe("W864 allPaths — the composed tool face", () => {
  it("read_file/list_dir outside the workspace pass, and a write lands outside it", async () => {
    const dir = sessionDir("face");
    const outside = mkdtempSync(join(tmpdir(), "allpaths-out-"));
    roots.push(outside);
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir });
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    expect(grants.readRoots).toEqual(["/"]);
    const tools = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants });

    const read = await tools.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: "/etc/hostname" } });
    expect(read.error).toBeNull();
    expect(String(read.value).length).toBeGreaterThan(0);
    const ls = await tools.registry.dispatch({ call_id: "l1", name: "list_dir", args: { path: "/etc" } });
    expect(ls.error).toBeNull();

    const write = await tools.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(outside, "made.txt"), content: "w864" } });
    expect(write.error).toBeNull();
    expect(readFileSync(join(outside, "made.txt"), "utf8")).toBe("w864");
  });

  it("the engine's grant view reaches the OS sandbox as --bind / / (the whole chain)", () => {
    const dir = sessionDir("argv");
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir });
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    // Exactly the view engine-plugins.ts hands the provider policy.
    const opts = bwrapOptionsFromEnv(env, {
      network: grants.network,
      unsandboxed: grants.unsandboxed,
      workspaceWritable: grants.workspaceWritable,
      writeRoots: grants.writeRoots,
    });
    expect(opts.writeRoots).toEqual(["/"]);
    const argv = buildBwrapArgv(dir, opts);
    expect(argv.join(" ")).toContain("--bind / /");
    expect(argv).not.toContain("--ro-bind");
  });

  it("the same calls are denied on a path-limited baseline (the guard is still mounted)", async () => {
    const dir = sessionDir("face-ro");
    const outside = mkdtempSync(join(tmpdir(), "allpaths-out-ro-"));
    roots.push(outside);
    // write-read, not read-only: read-only's PRESET toolDeny removes write_file
    // from the face entirely (W9), which would mask the guard denial under test.
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir, CELESTEA_PERMISSION_MAX: "write-read" });
    const grants = effectiveGrantsOf(dir, env, NOW).grants;
    const tools = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants });
    const read = await tools.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: "/etc/hostname" } });
    expect(String(read.error)).toContain("toolguard: code=path_forbidden");
    const write = await tools.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(outside, "made.txt"), content: "w864" } });
    expect(String(write.error)).toContain("toolguard: code=path_forbidden");
  });
});

