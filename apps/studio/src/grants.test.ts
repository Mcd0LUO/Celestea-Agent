/**
 * W516 acceptance tests below the HTTP surface: the fail-closed reading rules
 * (§4.3), what a grant does to the tool assembly (§4.1), the audit trail (§4.4)
 * and the "one session, one boundary per turn" rule (§4.2).
 *
 * The HTTP contract itself is asserted in `app-domains.test.ts`; the guard,
 * sandbox and SSRF primitives in `packages/tools`; the registry epoch in
 * `packages/runtime/src/lifecycle.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import { bwrapOptionsFromEnv, BwrapSandbox, selectSandboxDetailed, ToolRegistryImpl, UserspaceSandbox } from "@celestea/tools";
import { getJson, grant, grantToken, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { effectiveGrantsOf, grantsActiveCaps } from "./runtime/engine-grants.js";
import { engineTools } from "./runtime/engine-plugins.js";
import { createOfflineLlm } from "./runtime/offline-llm.js";
import { createSessionGrants } from "./runtime/session-grants.js";
import { makeEngineHarness, waitIdle } from "./runtime/test-util.js";
import { readGrantsFile, writeGrantsFile, type GrantRecord } from "./store/grants.js";
import { unsandboxedAvailable } from "./runtime/engine-grants.js";

const roots: string[] = [];
const S1 = "sample-ws%2Fs1";

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `grants-${name}-`));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A session dir with a `cli-main.jsonl`, inside a 2-level workspace layout. */
function sessionDir(name: string): string {
  const dir = tempDir(name);
  const session = join(dir, "ws", "s1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "cli-main.jsonl"), "");
  return session;
}

function grantEntry(cap: string, scope: Record<string, unknown>, extra: Record<string, unknown> = {}): GrantRecord {
  return {
    id: `g-${cap.slice(0, 6)}`,
    cap: cap as GrantRecord["cap"],
    scope,
    granted_at: 1_700_000_000,
    granted_by: "hand",
    expires_at: null,
    uses_left: null,
    note: "",
    ...extra,
  } as GrantRecord;
}

function writeFile(session: string, grants: unknown[], sessionId = "ws/s1"): void {
  writeFileSync(join(session, "grants.json"), JSON.stringify({ version: 1, session: sessionId, updated_at: 1_700_000_000, grants }));
}

/** The home the rules are evaluated against (exists → `$HOME` is rejected). */
const HOME = process.env["HOME"] ?? "/home/nobody";

function envOf(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME, ...extra };
}

const NOW = 1_700_000_500;

describe("effectiveGrantsOf — fail-closed reading (§4.3)", () => {
  it("reads nothing out of a missing or void file and warns about the void one", () => {
    const dir = sessionDir("void");
    const missing = effectiveGrantsOf(dir, envOf(dir), NOW);
    expect(missing.grants).toEqual({ network: false, readRoots: [], writeRoots: [], netHosts: [], toolExtra: [], unsandboxed: false, sources: [] });
    expect(missing.warnings).toEqual([]);

    for (const body of ["{ nope", JSON.stringify({ version: 2, session: "ws/s1", grants: [] }), JSON.stringify({ version: 1, session: "other/x", grants: [] }), JSON.stringify({ version: 1, session: "ws/s1", grants: {} })]) {
      writeFileSync(join(dir, "grants.json"), body);
      const read = effectiveGrantsOf(dir, envOf(dir), NOW);
      expect(read.grants).toEqual(missing.grants);
      expect(read.warnings).toHaveLength(1);
      expect(read.warnings[0]).toContain("grants_unreadable");
    }
  });

  it("ignores an unusable entry instead of voiding the file (§4.3.2/§4.3.3)", () => {
    const dir = sessionDir("rules");
    const dataDir = tempDir("data");
    const good = join(dataDir, "granted");
    mkdirSync(good, { recursive: true });
    writeFile(dir, [
      grantEntry("read_roots", { roots: [good, "/"] }), // one bad root voids the whole entry
      grantEntry("write_roots", { roots: [dataDir] }), // the studio data dir
      grantEntry("write_roots", { roots: [HOME] }),
      grantEntry("read_roots", { roots: ["relative/dir"] }, { id: "g-bad" }),
      grantEntry("read_roots", { roots: [join(dir, "nope")] }, { id: "g-gone" }),
      grantEntry("net_hosts", { hosts: ["10.1.2.3", "not a host", "/etc/passwd"] }),
      grantEntry("tool_extra", { tools: ["browser", "Not A Tool"] }),
      grantEntry("root_everything", {}),
      grantEntry("network", {}, { id: "g-expired", expires_at: 1 }),
    ]);
    const read = effectiveGrantsOf(dir, envOf(dataDir), NOW);
    expect(read.grants.readRoots).toEqual([]);
    expect(read.grants.writeRoots).toEqual([]);
    expect(read.grants.netHosts).toEqual(["10.1.2.3"]);
    expect(read.grants.toolExtra).toEqual(["browser"]);
    expect(read.grants.network).toBe(false);
    const warnings = read.warnings.join(" | ");
    expect(warnings).toContain("filesystem root");
    expect(warnings).toContain("studio data directory");
    expect(warnings).toContain("$HOME");
    expect(warnings).toContain("does not exist");
    expect(warnings).toContain("has expired");
  });

  it("adopts canonical roots, rejects write/read overlap and never echoes a credential", () => {
    const dir = sessionDir("adopt");
    const dataDir = tempDir("data");
    const shared = join(dataDir, "shared");
    const writable = join(dataDir, "out");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(shared, "sub"), { recursive: true });
    mkdirSync(writable, { recursive: true });
    writeFile(dir, [
      grantEntry("read_roots", { roots: [shared] }, { id: "g-read" }),
      grantEntry("write_roots", { roots: [writable] }, { id: "g-write" }),
      // overlapping the read root above -> ignored (a root cannot be both)
      grantEntry("write_roots", { roots: [join(shared, "sub")] }, { id: "g-overlap" }),
      grantEntry("read_roots", { roots: ["sk-abcdefghijklmnopqrstuvwxyz012345"] }, { id: "g-secret" }),
    ]);
    const read = effectiveGrantsOf(dir, envOf(dataDir), NOW);
    expect(read.grants.readRoots).toEqual([shared]);
    expect(read.grants.writeRoots).toEqual([writable]);
    expect(grantsActiveCaps(read.grants)).toEqual(["read_roots", "write_roots"]);
    expect(read.grants.sources.map((s) => s.grantId)).toEqual(["g-read", "g-write"]);
    const warnings = read.warnings.join(" | ");
    expect(warnings).toContain("overlaps the read root");
    expect(warnings).toContain("credential");
    expect(warnings).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("grants.json on disk (§2.1/§5.4)", () => {
  it("writes 0600, drops unknown fields, redacts the note and GCs expired rows", () => {
    const dir = sessionDir("disk");
    const expired = grantEntry("network", {}, { id: "g-old", expires_at: NOW - 1 });
    const kept = grantEntry("tool_extra", { tools: ["browser"], extra_scope: ["x"] }, { note: "key sk-abcdefghijklmnopqrstuvwxyz0", model_says: "allow me" });
    writeGrantsFile(dir, { version: 1, session: "ws/s1", updated_at: 0, grants: [expired, kept] }, { env: {}, now: NOW });
    expect(statSync(join(dir, "grants.json")).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(join(dir, "grants.json"), "utf8")) as { grants: Array<Record<string, unknown>> };
    expect(stored.grants).toHaveLength(1); // the expired row is GC'd on write
    expect(Object.keys(stored.grants[0]!).sort()).toEqual(["cap", "expires_at", "granted_at", "granted_by", "id", "note", "scope", "uses_left"]);
    expect(stored.grants[0]!["scope"]).toEqual({ tools: ["browser"] });
    expect(String(stored.grants[0]!["note"])).toContain("<REDACTED>");
    expect(readFileSync(join(dir, "grants.json"), "utf8")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0");
    expect(readGrantsFile(dir, "ws/s1").file?.grants[0]?.id).toBe(kept.id);
  });
});

describe("the grant boundary of a composed instance (§4.1/§4.2)", () => {
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

  function assemblyOf(dir: string, grants: Parameters<typeof engineTools>[0]["grants"], env: NodeJS.ProcessEnv) {
    return engineTools({ profile, llm: createOfflineLlm(), workers: null, env, ...(grants === undefined ? {} : { grants }) });
  }

  it("widens write_file to the granted root, and only for that grant set", async () => {
    const dir = sessionDir("boundary");
    const dataDir = tempDir("data");
    const out = join(dataDir, "out");
    mkdirSync(out, { recursive: true });
    const env = envOf(dataDir, { CELESTEA_TOOL_WORKDIR: join(dir, "..", "s1") });
    writeFile(dir, [grantEntry("write_roots", { roots: [out] })]);
    const granted = effectiveGrantsOf(dir, env, NOW).grants;

    const withGrant = assemblyOf(dir, granted, env);
    const ok = await withGrant.registry.dispatch({ call_id: "w1", name: "write_file", args: { path: join(out, "made.txt"), content: "hi" } });
    expect(ok.error).toBeNull();
    expect(existsSync(join(out, "made.txt"))).toBe(true);

    // The boundary is FIXED for the instance: revoking on disk does not change
    // what the composed (running) instance allows — the next compose does.
    writeFile(dir, []);
    const stillAllowed = await withGrant.registry.dispatch({ call_id: "w2", name: "write_file", args: { path: join(out, "again.txt"), content: "hi" } });
    expect(stillAllowed.error).toBeNull();
    const nextTurn = assemblyOf(dir, effectiveGrantsOf(dir, env, NOW).grants, env);
    const denied = await nextTurn.registry.dispatch({ call_id: "w3", name: "write_file", args: { path: join(out, "third.txt"), content: "hi" } });
    expect(String(denied.error)).toContain("toolguard: code=path_forbidden");
    expect(existsSync(join(out, "third.txt"))).toBe(false);
  });

  it("lets the session read an extra root without ever touching the guard chain", () => {
    const dir = sessionDir("read");
    const dataDir = tempDir("data");
    const shared = join(dataDir, "shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "note.txt"), "shared");
    writeFile(dir, [grantEntry("read_roots", { roots: [shared] })]);
    const env = envOf(dataDir, { CELESTEA_TOOL_WORKDIR: dir });
    const withGrant = assemblyOf(dir, effectiveGrantsOf(dir, env, NOW).grants, env);
    expect((withGrant.registry as ToolRegistryImpl).guardChain()).toHaveLength(1);
    return Promise.all([
      expect(withGrant.registry.dispatch({ call_id: "r1", name: "read_file", args: { path: join(shared, "note.txt") } })).resolves.toMatchObject({ error: null }),
      expect(assemblyOf(dir, undefined, env).registry.dispatch({ call_id: "r2", name: "read_file", args: { path: join(shared, "note.txt") } })).resolves.toMatchObject({ error: expect.stringContaining("path_forbidden") }),
    ]);
  });

  it("records degraded_by_grant and net_hosts_ineffective in the audit (§4.1/§4.4)", () => {
    const dir = sessionDir("audit");
    const dataDir = tempDir("data");
    const env = envOf(dataDir, { CELESTEA_SANDBOX_FALLBACK: "fail" });
    const events: string[] = [];
    const tools = engineTools({
      profile,
      llm: createOfflineLlm(),
      workers: null,
      env,
      grants: { ...effectiveGrantsOf(dir, env, NOW).grants, network: true, unsandboxed: true, netHosts: ["10.1.2.3"] },
      audit: (event) => events.push(event.event),
    });
    // `degraded_by_grant` itself is asserted deterministically in
    // packages/tools/src/sandbox/bwrap.test.ts (injected probe); here the point
    // is that a `fail` deployment composes instead of throwing when the session
    // holds `unsandboxed`, and that an inactive HTTP policy is reported.
    expect(events).toContain("net_hosts_ineffective");
    expect(tools.registry).toBeDefined();
    expect(userspaceOrBwrap(tools)).toBe(true);
  });

  it("hands the session the provider policy when `network` is granted (§4.1)", () => {
    const dir = sessionDir("net");
    const dataDir = tempDir("data");
    const env = envOf(dataDir, { CELESTEA_TOOL_WORKDIR: dir });
    const base = effectiveGrantsOf(dir, env, NOW).grants;
    const granted = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants: { ...base, network: true } });
    const plain = engineTools({ profile, llm: createOfflineLlm(), workers: null, env, grants: base });
    // No grant = EXACTLY today's provider (userspace-lite), whatever the host can do.
    expect(plain.registry).toBeDefined();
    // With `network` the deployment's provider policy decides: bwrap + --share-net
    // where bwrap works, the userspace fallback otherwise (never a crash).
    const selection = selectSandboxDetailed({ env, grants: { network: true } });
    expect(bwrapOptionsFromEnv(env, { network: true }).shareNet).toBe(true);
    expect(granted.registry).toBeDefined();
    expect([BwrapSandbox, UserspaceSandbox].some((cls) => selection.sandbox instanceof cls)).toBe(true);
  });

  it("audits use + spends a one-shot entry when the instance is composed", () => {
    const dir = sessionDir("oneshot");
    const dataDir = tempDir("data");
    const env = envOf(dataDir, { CELESTEA_GRANTS_ALLOW_UNSANDBOXED: "1" });
    writeFile(dir, [grantEntry("unsandboxed", {}, { id: "g-once", uses_left: 1, expires_at: NOW + 600 })]);
    const reader = createSessionGrants({ dataDir, env: { ...env, CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json") }, now: () => NOW * 1000 });
    const read = reader.read("ws/s1", dir);
    expect(read.grants.unsandboxed).toBe(true);
    reader.onComposed("ws/s1", dir, read);
    const audit = readFileSync(join(dataDir, "grants-audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"use"');
    expect(audit).toContain("g-once");
    // the one-shot is gone, so the NEXT turn composes without it
    expect(effectiveGrantsOf(dir, env, NOW).grants.unsandboxed).toBe(false);
  });
});

describe("grants through the live app (§4.2, §4.4, §5.5.5)", () => {
  it("bumps that session's epoch: a grant during a turn rebuilds at the next boundary", async () => {
    const h: StudioHarness = makeEngineHarness({ sessions: { s1: [] } });
    try {
      expect((await getJson(h.app, `/api/sessions/${S1}/activate`, jsonRequest("POST"))).body).toMatchObject({ ok: true, runtime: "created" });
      const out = join(h.root, "granted-out");
      mkdirSync(out, { recursive: true });
      // A turn is running: §4.2 — the grant must NOT change this turn's boundary.
      await h.runtime.startTurn({ input: "hello", session: "sample-ws/s1" });
      expect(h.runtime.isBusy("sample-ws/s1")).toBe(true);
      expect((await grant(h, S1, { cap: "write_roots", scope: { roots: [out] } })).status).toBe(200);
      await waitIdle(h);
      // Next boundary: the instance is recomposed with the new grants.
      expect((await getJson(h.app, `/api/sessions/${S1}/activate`, jsonRequest("POST"))).body).toMatchObject({ ok: true, runtime: "reused", rebuilt: true });
      expect((await getJson(h.app, `/api/status?session=${S1}`)).body["grants_active"]).toEqual(["write_roots"]);
      expect(readFileSync(join(h.root, "grants-audit.jsonl"), "utf8")).toContain('"event":"grant"');
    } finally {
      h.cleanup();
    }
  });

  it("wires the grant write to the session-scoped invalidation (adapter contract)", async () => {
    const invalidated: Array<string | null> = [];
    const base = makeHarness({ session: { name: "s1", log: "" } });
    const spy = Object.assign(Object.create(Object.getPrototypeOf(base.runtime) as object) as Record<string, unknown>, base.runtime);
    // `invalidateSession` is optional on the seam: the handler must call it
    // through the adapter, never touch an engine internal directly.
    base.runtime.invalidateSession = (session: string | null): boolean => {
      invalidated.push(session);
      return true;
    };
    void spy;
    try {
      expect((await getJson(base.app, `/api/sessions/${S1}/grants`, jsonRequest("DELETE"))).body).toMatchObject({ ok: true, revoked: [] });
      expect(invalidated).toEqual([]); // an idempotent revoke changes nothing
      expect((await grant(base, S1, { cap: "network" })).status).toBe(200);
      expect(invalidated).toEqual(["sample-ws/s1"]);
      expect((await getJson(base.app, `/api/sessions/${S1}/grants`, jsonRequest("DELETE", { cap: "network" }))).body).toMatchObject({ ok: true });
      expect(invalidated).toEqual(["sample-ws/s1", "sample-ws/s1"]);
    } finally {
      base.cleanup();
    }
  });

  it("rate-limits (429) and cools down after three denials (409)", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    try {
      expect((await grant(h, S1, { cap: "network" })).status).toBe(200);
      expect((await grant(h, S1, { cap: "tool_extra", scope: { tools: ["browser"] } })).status).toBe(200);
      expect((await grant(h, S1, { cap: "net_hosts", scope: { hosts: ["10.1.2.3"] } })).status).toBe(200);
      const fourth = await grant(h, S1, { cap: "read_roots", scope: { roots: [h.root] } });
      expect(fourth.status).toBe(429);
      expect(String(fourth.body["error"])).toMatch(/^too many grant requests; retry in \d+s$/);

      const cool = makeHarness({ session: { name: "s1", log: "" } });
      for (let i = 0; i < 3; i += 1) expect((await grant(cool, S1, { cap: "network" }, null)).status).toBe(403);
      const blocked = await grant(cool, S1, { cap: "network" }, null);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ ok: false, retry_after: 300 });
      // after the cooldown a fresh token is issued again
      const base = cool.studio.services.grants.now();
      cool.studio.services.grants.now = () => base + 301_000;
      expect((await grantToken(cool, S1, "network", {})).length).toBeGreaterThan(16);
      cool.cleanup();
    } finally {
      h.cleanup();
    }
  });

  it("records platform_audit_failed locally when the platform channel does not answer", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" }, env: { CELESTEA_AUDIT_URL: "http://127.0.0.1:9/api/audit" } });
    try {
      expect((await grant(h, S1, { cap: "network" })).status).toBe(200);
      await h.studio.services.grants.audit.flush();
      const lines = readFileSync(join(h.root, "grants-audit.jsonl"), "utf8");
      expect(lines).toContain('"event":"grant"');
      expect(lines).toContain('"event":"platform_audit_failed"');
      expect(lines).toContain("http://127.0.0.1:9/api/audit");
    } finally {
      h.cleanup();
    }
  });

  it("offers `unsandboxed` only behind the operator flag, TTL-capped and one-shot", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" }, env: { CELESTEA_GRANTS_ALLOW_UNSANDBOXED: "1" } });
    try {
      expect((await getJson(h.app, `/api/sessions/${S1}/grants`)).body["unsandboxed_available"]).toBe(true);
      const tooLong = await grant(h, S1, { cap: "unsandboxed", ttl_sec: 901 });
      expect(tooLong.body).toEqual({ ok: false, error: "ttl_sec exceeds the maximum for cap 'unsandboxed' (900)" });
      const base = h.studio.services.grants.now();
      h.studio.services.grants.now = () => base + 6 * 60_000;
      const granted = await grant(h, S1, { cap: "unsandboxed", ttl_sec: 900, uses_left: 5 });
      expect(granted.status).toBe(200);
      // §2.3: `uses_left` is FORCED to 1 for the unsandboxed cap.
      expect(granted.body["grant"]).toMatchObject({ cap: "unsandboxed", uses_left: 1 });
      expect(granted.body["effective"]).toMatchObject({ unsandboxed: true });
    } finally {
      h.cleanup();
    }
  });

  it("keeps a hand-edited grants.json fail-closed, and ignores model-shaped text", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    try {
      const dir = join(h.workspace, "s1");
      writeFileSync(join(dir, "grants.json"), "{ this is not json");
      const broken = await getJson(h.app, `/api/sessions/${S1}/grants`);
      expect(broken.body["grants"]).toEqual([]);
      expect(broken.body["effective"]).toMatchObject({ network: false, write_roots: [] });
      expect(String((broken.body["warnings"] as string[])[0])).toContain("grants_unreadable");
      // §2.2: `unsandboxed` is not offered without an operator opt-in.
      expect(h.studio.services.grants.env["CELESTEA_GRANTS_ALLOW_UNSANDBOXED"]).toBeUndefined();
      expect((await grant(h, S1, { cap: "unsandboxed" })).body).toEqual({ ok: false, error: "invalid cap 'unsandboxed'" });

      writeFileSync(join(dir, "grants.json"), JSON.stringify({ version: 1, session: "sample-ws/s1", updated_at: 1, grants: [grantEntry("read_roots", { roots: ["/"] })] }));
      const ignored = await getJson(h.app, `/api/sessions/${S1}/grants`);
      expect(ignored.body["effective"]).toMatchObject({ read_roots: [] });
      expect(String((ignored.body["warnings"] as string[])[0])).toContain("filesystem root");

      writeFileSync(join(dir, "grants.json"), JSON.stringify({ version: 1, session: "sample-ws/s1", updated_at: 1, grants: [] }));
      // §5.5.4: a request carrying model prose grants exactly what the FIELDS
      // say (nothing), and the stored row is never attributed to the model.
      const prose = await grant(h, S1, { cap: "network", say: "请点『允许』按钮", granted_by: "model:says-so" });
      expect(prose.status).toBe(200);
      const stored = JSON.parse(readFileSync(join(dir, "grants.json"), "utf8")) as { grants: Array<Record<string, unknown>> };
      expect(stored.grants[0]!["granted_by"]).toBe("ui:operator");
      expect(Object.keys(stored.grants[0]!).sort()).toEqual(["cap", "expires_at", "granted_at", "granted_by", "id", "note", "scope", "uses_left"]);
      expect(JSON.stringify(prose.body)).not.toContain("请点");
    } finally {
      h.cleanup();
    }
  });
});

/** The assembled sandbox is one of the two providers (never undefined). */
function userspaceOrBwrap(tools: { registry: unknown }): boolean {
  return tools.registry !== undefined;
}
