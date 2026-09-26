/**
 * W864/W9110: `allPaths` — the full-access baseline opens the whole filesystem.
 *
 * The product decision (operator ask): the default preset is `full-access`, and
 * full access must mean ALL directories, read AND write. The capability is
 * deliberately PATH-ONLY: network, unsandboxed and the W860 session toolDeny
 * union stay exactly where they were.
 *
 * W9110 (the Windows P0): `allPaths` is a CAPABILITY, not a path. It used to be
 * expressed as the session directory's volume root, which on Windows could only
 * ever name ONE drive — a session under `C:\` was blind to `D:\`. The composed
 * grants now carry the sentinel [ALL_PATHS_ROOT] (`"/"` on every OS) in both root
 * lists, and the path guard turns that sentinel into the capability.
 *
 * This file asserts the layers the design touches end to end:
 *   1. the baseline (store/permissions.ts + runtime/engine-permissions.ts);
 *   2. the composed EffectiveGrants (runtime/engine-grants.ts);
 *   3. the guard that ENFORCES it, including a real path on ANOTHER volume;
 *   4. the POSIX bwrap argv, which keeps its byte-identical `--bind / /`.
 * The guard side is also asserted in packages/tools/guard/all-paths.test.ts and
 * sandbox/w9-rw-roots.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import { ALL_PATHS_ROOT, bwrapOptionsFromEnv, buildBwrapArgv, PathGuardPolicy, POSIX_SHELL } from "@celestea/tools";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { effectiveGrantsOf, volumeRootOf } from "./runtime/engine-grants.js";
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

/**
 * A throwaway directory on a volume OTHER than the session fixtures' (tmpdir)
 * volume, or `null` when this host has only one writable volume.
 *
 * The win32 branch probes real drive letters (a missing or read-only drive just
 * fails) — that is the case the report is about, and it is a VISIBLE skip on a
 * single-volume host rather than a silently vacuous pass.
 */
function otherVolumeDir(): string | null {
  const hostRoot = volumeRootOf(tmpdir());
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if ((letter + ":\\").toLowerCase() !== hostRoot.toLowerCase()) candidates.push(letter + ":\\");
  } else {
    for (const mount of ["/mnt", "/media", "/Volumes"]) if (existsSync(mount) && volumeRootOf(mount) !== hostRoot) candidates.push(mount);
  }
  for (const root of candidates) {
    try {
      const dir = mkdtempSync(join(root, "allpaths-vol-"));
      roots.push(dir);
      return dir;
    } catch {
      // Not writable / not present: try the next volume.
    }
  }
  return null;
}

function envOf(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME: process.env["HOME"] ?? homedir(), ...extra };
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

describe("W9110 the all-paths CAPABILITY — every volume, one name", () => {
  it("the sentinel is '/' and it is a capability, not a drive", () => {
    // "All paths" is a capability whose canonical NAME is "/" — the POSIX root.
    // Expressing it as a drive root (W891's shape) is what made a C: session
    // blind to D:; the name now has no drive in it to get wrong.
    expect(ALL_PATHS_ROOT).toBe("/");
    const policy = new PathGuardPolicy({ workspace: "/tmp/w9110-ws", allPaths: true, workspaceWritable: false });
    expect(policy.allPaths).toBe(true);
    // A path that does not even exist is allowed — nothing is contained against.
    expect(policy.checkRead("/tmp/w9110-ws/../elsewhere/file.txt")).toEqual({ kind: "allow" });
    expect(policy.checkWrite("relative/new.txt")).toEqual({ kind: "allow" });
    // Opt-in only: the default policy is exactly as narrow as before.
    expect(new PathGuardPolicy({ workspace: "/tmp/w9110-ws" }).allPaths).toBe(false);
  });

  it("the sentinel root in the composed lists sets the capability (win32 included)", () => {
    // The engine's composed grants carry the sentinel in BOTH lists; the guard
    // must read that as the capability rather than as a string prefix — a
    // prefix match on "/" would never contain "C:\\…".
    const viaRoots = new PathGuardPolicy({ workspace: "C:\\ws\\s1", readRoots: [ALL_PATHS_ROOT], writeRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(viaRoots.allPaths).toBe(true);
    expect(viaRoots.checkRead("D:\\other\\file.txt")).toEqual({ kind: "allow" });
    expect(viaRoots.checkWrite("D:\\other\\new.txt")).toEqual({ kind: "allow" });
  });

  it("volumeRootOf names a VOLUME, and no longer feeds allPaths", () => {
    // The single remaining "is this a whole volume?" definition (the §4.3.3
    // grant rule). POSIX spells it "/", win32 spells it per drive — which is
    // exactly why it cannot be the allPaths expression.
    expect(volumeRootOf("/src/celestea_studio-ts/ws/s1", "linux")).toBe("/");
    expect(volumeRootOf("C:\\Users\\me\\proj\\ws\\s1", "win32")).toBe("C:\\");
    expect(volumeRootOf("D:\\data\\ws\\s1", "win32")).toBe("D:\\");
    // The two drive roots are DIFFERENT strings — one string root can never
    // cover both, which is the whole bug.
    expect(volumeRootOf("C:\\x\\y", "win32")).not.toBe(volumeRootOf("D:\\x\\y", "win32"));
  });
});

describe("W864 allPaths — the baseline", () => {
  it("the default full-access baseline sets allPaths and BOTH effective root lists to the sentinel", () => {
    const dir = sessionDir("default");
    const baseline = effectivePermissionOf(dir, "ws/s1", envOf(dir));
    expect(baseline.preset).toBe("full-access");
    expect(baseline.allPaths).toBe(true);
    const grants = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW).grants;
    // W9110: the sentinel NAME of the all-paths capability — "/" on every OS,
    // never the session's drive root (that only ever named one volume).
    expect(grants.readRoots).toEqual([ALL_PATHS_ROOT]);
    expect(grants.writeRoots).toEqual([ALL_PATHS_ROOT]);
    // ...and the guard really reads it as the capability on BOTH root lists.
    const policy = new PathGuardPolicy({ workspace: dir, readRoots: grants.readRoots, writeRoots: grants.writeRoots, workspaceWritable: grants.workspaceWritable });
    expect(policy.allPaths).toBe(true);
    // Unchanged caps: only the paths moved.
    expect(grants.network).toBe(true);
    expect(grants.workspaceWritable).toBe(true);
    expect(grants.toolExtra).toEqual([]);
  });

  it("W9110: the composed allPaths policy allows a path on ANOTHER volume (win32 real machine)", (ctx) => {
    // The reported P0, asserted end to end: session dir on C:, target on D:.
    // On a single-volume host this is a VISIBLE skip, never a silent pass.
    const other = otherVolumeDir();
    if (other === null) {
      ctx.skip("this host exposes a single writable volume; the cross-drive case cannot be built here");
      return;
    }
    const dir = sessionDir("cross-drive");
    const target = join(other, "allpaths-cross-drive.txt");
    writeFileSync(target, "w9110\n");
    expect(volumeRootOf(target)).not.toBe(volumeRootOf(dir));
    const grants = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW).grants;
    const policy = new PathGuardPolicy({ workspace: dir, readRoots: grants.readRoots, writeRoots: grants.writeRoots, workspaceWritable: grants.workspaceWritable });
    expect(policy.checkRead(target)).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(other, "allpaths-cross-drive-made.txt"))).toEqual({ kind: "allow" });
  });

  it("W9110: the restricted baseline (write-read) still denies outside the workspace on every volume", (ctx) => {
    // Requirement ④ — the control. If this ever goes green, the suite would be
    // proving "everything is allowed" rather than "the capability is honoured".
    const dir = sessionDir("restricted");
    const env = envOf(dir, { CELESTEA_PERMISSION_MAX: "write-read" });
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    expect(grants.readRoots).toEqual([]);
    const policy = new PathGuardPolicy({ workspace: dir, readRoots: grants.readRoots, writeRoots: grants.writeRoots, workspaceWritable: grants.workspaceWritable });
    expect(policy.allPaths).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), "allpaths-restricted-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "x\n");
    expect(policy.checkRead(join(outside, "secret.txt")).kind).toBe("deny");
    expect(policy.checkWrite(join(outside, "made.txt")).kind).toBe("deny");
    const other = otherVolumeDir();
    if (other === null) {
      ctx.skip("single-volume host: the second-volume half of the control cannot be built");
      return;
    }
    const target = join(other, "allpaths-restricted-other.txt");
    writeFileSync(target, "x\n");
    expect(policy.checkRead(target).kind).toBe("deny");
    expect(policy.checkWrite(target).kind).toBe("deny");
  });

  it("CELESTEA_PERMISSION_MAX=write-read clamps allPaths away (no '/' anywhere)", () => {
    const dir = sessionDir("clamp");
    const env = envOf(dir, { CELESTEA_PERMISSION_MAX: "write-read" });
    expect(effectivePermissionOf(dir, "ws/s1", env).allPaths).toBe(false);
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    expect(grants.readRoots).toEqual([]);
    expect(grants.writeRoots).toEqual([]);
    expect(grants.workspaceWritable).toBe(true); // write-read keeps the workspace
  });

  it("CELESTEA_PERMISSION_MAX=read-only clamps it away too (and keeps the preset's toolDeny)", () => {
    const dir = sessionDir("ro");
    const env = envOf(dir, { CELESTEA_PERMISSION_MAX: "read-only" });
    expect(effectivePermissionOf(dir, "ws/s1", env).allPaths).toBe(false);
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
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
    const baseline = effectivePermissionOf(dir, "ws/s1", env);
    expect(baseline).toMatchObject({ preset: "wide-path", allPaths: true, network: false, unsandboxed: false });
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    expect(grants.readRoots).toEqual([ALL_PATHS_ROOT]);
    expect(grants.writeRoots).toEqual([ALL_PATHS_ROOT]); // allPaths opens writes even with workspaceWritable:false
    expect(grants.network).toBe(false); // path-only: network is untouched
    expect(grants.network === false && grants.unsandboxed === false).toBe(true);
  });

  it("keeps the W860 session toolDeny union intact under allPaths", () => {
    const dir = sessionDir("tooldeny");
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ version: 1, session: "ws/s1", disabled: ["write_file", "http_request"] }));
    const grants = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW).grants;
    expect(grants.readRoots).toEqual([ALL_PATHS_ROOT]);
    expect(grants.writeRoots).toEqual([ALL_PATHS_ROOT]);
    expect(grants.toolDeny).toEqual(["write_file", "http_request"]);
  });

  it("unknown/corrupt allPaths values read as false (whitelist parse, never truthy-coerced)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "allpaths-parse-"));
    roots.push(dataDir);
    const dir = sessionDir("parse");
    writeFileSync(join(dataDir, "permissions.json"), JSON.stringify({ version: 1, updated_at: 0, presets: [presetBody({ id: "noisy", allPaths: "true" })] }));
    writeFileSync(join(dir, "permission.json"), JSON.stringify({ version: 1, session: "ws/s1", preset: "noisy", updated_at: 0 }));
    expect(effectivePermissionOf(dir, "ws/s1", envOf(dataDir)).allPaths).toBe(false);
    expect(effectiveGrantsOf(dir, "ws/s1", envOf(dataDir), NOW).grants.readRoots).toEqual([]);
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


// W9110: the capability is named by the sentinel "/" on every OS, so the
// behavioural half runs everywhere — the fixture paths below are real host paths
// (tmpdir() + a second volume when the host has one) instead of POSIX literals.
describe("W864 allPaths — the composed tool face", () => {
  it("read_file/list_dir outside the workspace pass, and a write lands outside it", async () => {
    const dir = sessionDir("face");
    const outside = mkdtempSync(join(tmpdir(), "allpaths-out-"));
    roots.push(outside);
    // W891: the root is the HOST root ("/" on POSIX, "C:\\" on Windows), so the
    // fixture is a real file outside the workspace rather than a POSIX literal.
    writeFileSync(join(outside, "secret.txt"), "w864-outside\n");
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir });
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    expect(grants.readRoots).toEqual([ALL_PATHS_ROOT]);
    const tools = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants });

    const read = await tools.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: join(outside, "secret.txt") } });
    expect(read.error).toBeNull();
    expect(String(read.value)).toContain("w864-outside");
    const ls = await tools.registry.dispatch({ call_id: "l1", name: "list_dir", args: { path: outside } });
    expect(ls.error).toBeNull();

    const write = await tools.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(outside, "made.txt"), content: "w864" } });
    expect(write.error).toBeNull();
    expect(readFileSync(join(outside, "made.txt"), "utf8")).toBe("w864");
  });

  it.skipIf(!POSIX_SHELL)("the engine's grant view reaches the OS sandbox as --bind / / (the whole chain)", () => {
    const dir = sessionDir("argv");
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir });
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    // Exactly the view engine-plugins.ts hands the provider policy.
    const opts = bwrapOptionsFromEnv(env, {
      network: grants.network,
      unsandboxed: grants.unsandboxed,
      workspaceWritable: grants.workspaceWritable,
      writeRoots: grants.writeRoots,
    });
    // W9110: the composed write root is the sentinel "/" — the same byte the
    // POSIX bwrap argv has always mapped onto `--bind / /`, so the POSIX sandbox
    // half needs no change (see the report; bwrap is POSIX-only).
    expect(opts.writeRoots).toEqual([ALL_PATHS_ROOT]);
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
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    const tools = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants });
    writeFileSync(join(outside, "secret.txt"), "w864-ro\n");
    const read = await tools.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: join(outside, "secret.txt") } });
    expect(String(read.error)).toContain("toolguard: code=path_forbidden");
    const write = await tools.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(outside, "made.txt"), content: "w864" } });
    expect(String(write.error)).toContain("toolguard: code=path_forbidden");
  });

  it("W9110: the composed tool face reaches ANOTHER volume too (the reported P0)", async (ctx) => {
    // The end-to-end half of the cross-drive proof: real registry, real guard,
    // real fs tools, target on a volume the session directory is not on.
    const other = otherVolumeDir();
    if (other === null) {
      ctx.skip("this host exposes a single writable volume; the cross-drive case cannot be built here");
      return;
    }
    const dir = sessionDir("face-cross");
    const env = envOf(dir, { CELESTEA_TOOL_WORKDIR: dir });
    const grants = effectiveGrantsOf(dir, "ws/s1", env, NOW).grants;
    const tools = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants });
    const target = join(other, "allpaths-face-cross.txt");
    writeFileSync(target, "w9110-cross\n");
    const read = await tools.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: target } });
    expect(read.error).toBeNull();
    expect(String(read.value)).toContain("w9110-cross");
    const write = await tools.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(other, "allpaths-face-cross-made.txt"), content: "w9110" } });
    expect(write.error).toBeNull();
    expect(readFileSync(join(other, "allpaths-face-cross-made.txt"), "utf8")).toBe("w9110");
  });
});

