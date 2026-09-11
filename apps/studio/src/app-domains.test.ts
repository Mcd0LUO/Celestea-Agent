import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { busyRuntime, getJson, grant, grantToken, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeHarness>[0] = {}): StudioHarness {
  const h = makeHarness({
    session: { name: "s1", log: `${JSON.stringify({ type: "turn_start", id: "turn-1" })}\n${JSON.stringify({ type: "user_message", text: "hello" })}\n` },
    ...options,
  });
  harnesses.push(h);
  return h;
}

const S1 = "sample-ws%2Fs1";

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("sessions endpoints", () => {
  it("lists sessions and creates a new one", async () => {
    const h = make();
    const list = await getJson(h.app, "/api/sessions");
    expect(list.body["sessions"]).toHaveLength(1);
    expect(list.body["active_session"]).toBeNull();
    expect(list.body["ok"]).toBeUndefined();

    const created = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "chat" }));
    expect(created.status).toBe(200);
    expect(created.body["ok"]).toBe(true);
    expect(String(created.body["id"])).toMatch(/^sample-ws\/chat-1700000000\.0$/);
    const after = await getJson(h.app, "/api/sessions");
    expect(after.body["sessions"]).toHaveLength(2);
  });

  it("404s an unknown workspace on create and 415s a missing body", async () => {
    const h = make();
    const unknown = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "ghost", title: "x" }));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: "unknown workspace 'ghost'" });
    const noBody = await getJson(h.app, "/api/sessions", { method: "POST" });
    expect(noBody.status).toBe(415);
  });

  it("serves the transcript projection and the four id error codes", async () => {
    const h = make();
    const ok = await getJson(h.app, `/api/sessions/${S1}/messages`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, session: "sample-ws/s1", messages: [{ role: "user", content: "hello" }] });
    expect((await getJson(h.app, "/api/sessions/noslash/messages")).status).toBe(400);
    expect((await getJson(h.app, "/api/sessions/ghost%2Fs1/messages")).status).toBe(404);
    expect((await getJson(h.app, "/api/sessions/sample-ws%2F.hidden/messages")).status).toBe(400);
    expect((await getJson(h.app, "/api/sessions/sample-ws%2Fmissing/messages")).status).toBe(404);
  });

  it("activates a session, persists active_session, and rejects an invalid session model", async () => {
    const h = make();
    const res = await getJson(h.app, `/api/sessions/${S1}/activate`, jsonRequest("POST"));
    expect(res.body).toEqual({ ok: true, active_session: "sample-ws/s1", runtime: "created", busy: false, rebuilt: false });
    const status = await getJson(h.app, "/api/status");
    expect(status.body["session"]).toBe("sample-ws/s1");

    const bad = make({ session: { name: "s2", log: "", meta: { model: "bad model" } } });
    const res2 = await getJson(bad.app, "/api/sessions/sample-ws%2Fs2/activate", jsonRequest("POST"));
    expect(res2.status).toBe(400);
    expect(String(res2.body["error"])).toContain("invalid session model:");

    // W513: activate NEVER 409s — a busy session is exactly what it must accept.
    const busy = make({ runtime: busyRuntime() });
    const res3 = await getJson(busy.app, `/api/sessions/${S1}/activate`, jsonRequest("POST"));
    expect(res3.status).toBe(200);
    expect(res3.body).toEqual({ ok: true, active_session: "sample-ws/s1", runtime: "created", busy: true, rebuilt: false });
  });

  it("renames, branches, archives, unarchives and batch-moves sessions", async () => {
    const h = make();
    const renamed = await getJson(h.app, `/api/sessions/${S1}/rename`, jsonRequest("POST", { new_title: "renamed" }));
    expect(renamed.body).toEqual({ ok: true, id: "sample-ws/renamed" });
    expect(existsSync(join(h.workspace, "renamed", "cli-main.jsonl"))).toBe(true);

    const renamedId = "sample-ws%2Frenamed";
    const branch = await getJson(h.app, `/api/sessions/${renamedId}/branch`, jsonRequest("POST", { title: "copy" }));
    expect(String(branch.body["id"])).toBe("sample-ws/copy-1700000000.0");

    const archived = await getJson(h.app, `/api/sessions/${renamedId}/archive`, jsonRequest("POST"));
    expect(archived.body).toEqual({ ok: true });
    const again = await getJson(h.app, `/api/sessions/${renamedId}/archive`, jsonRequest("POST"));
    expect(again.status).toBe(404);
    const unarchived = await getJson(h.app, `/api/sessions/${renamedId}/unarchive`, jsonRequest("POST"));
    expect(unarchived.body).toEqual({ ok: true });

    const batch = await getJson(h.app, "/api/sessions/batch-archive", jsonRequest("POST", { ids: ["sample-ws/copy-1700000000.0", "sample-ws/ghost"] }));
    expect(batch.body).toEqual({ ok: true, archived: 1, failed: [{ id: "sample-ws/ghost", error: "unknown session 'sample-ws/ghost'" }] });
    const trash = await getJson(h.app, "/api/sessions/batch-delete", jsonRequest("POST", { ids: ["sample-ws/renamed"] }));
    expect(trash.body["deleted"]).toBe(1);
  });

  it("refuses to archive the active session with the 400 contract error", async () => {
    const h = make();
    await getJson(h.app, `/api/sessions/${S1}/activate`, jsonRequest("POST"));
    const res = await getJson(h.app, `/api/sessions/${S1}/archive`, jsonRequest("POST"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "active session 'sample-ws/s1' cannot be archived" });
  });

  it("compacts through the runtime adapter and broadcasts the compact frame", async () => {
    const h = make();
    const sub = h.studio.services.bus.subscribe();
    const res = await getJson(h.app, `/api/sessions/${S1}/compact`, jsonRequest("POST"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, compacted: false, note: "历史不足，无需压缩" });
    const frame = await sub.next();
    expect(frame?.event).toBe("compact");
    expect(frame?.envelope.turn).toBe(0);
    expect(frame?.envelope.payload).toMatchObject({ session: "sample-ws/s1", rebound: false });
    sub.close();

    const busy = make({ runtime: busyRuntime() });
    const res2 = await getJson(busy.app, `/api/sessions/${S1}/compact`, jsonRequest("POST"));
    expect(res2.status).toBe(409);
    expect(res2.body).toEqual({ ok: false, error: "turn 进行中，无法压缩" });
  });
});

describe("session grants endpoints", () => {
  it("grants with a one-shot token, lists it, revokes it and reports the snapshot", async () => {
    const h = make();
    const out = join(h.root, "granted-out");
    mkdirSync(out, { recursive: true });

    const empty = await getJson(h.app, `/api/sessions/${S1}/grants`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ ok: true, session: "sample-ws/s1", grants: [], unsandboxed_available: false });
    expect(empty.body["effective"]).toEqual({ network: false, read_roots: [], write_roots: [], net_hosts: [], tool_extra: [], unsandboxed: false });
    expect(empty.body["max_ttl_sec"]).toMatchObject({ network: 3600, write_roots: 86400, unsandboxed: 900 });

    const granted = await grant(h, S1, { cap: "write_roots", scope: { roots: [out] }, ttl_sec: 600, note: "batch output", model_says: "please allow" });
    expect(granted.status).toBe(200);
    expect(granted.body["grant"]).toMatchObject({ cap: "write_roots", scope: { roots: [out] }, expires_at: 1_700_000_600, uses_left: null, granted_by: "ui:operator" });
    expect(granted.body["effective"]).toMatchObject({ write_roots: [out] });

    // §5.4 field whitelist + 0600: a model-shaped extra field never lands.
    const stored = JSON.parse(readFileSync(join(h.workspace, "s1", "grants.json"), "utf8")) as { grants: Array<Record<string, unknown>> };
    expect(statSync(join(h.workspace, "s1", "grants.json")).mode & 0o777).toBe(0o600);
    expect(Object.keys(stored.grants[0]!).sort()).toEqual(["cap", "expires_at", "granted_at", "granted_by", "id", "note", "scope", "uses_left"]);

    expect((await getJson(h.app, `/api/status?session=${S1}`)).body["grants_active"]).toEqual(["write_roots"]);
    const revoked = await getJson(h.app, `/api/sessions/${S1}/grants`, jsonRequest("DELETE", { cap: "write_roots" }));
    expect(revoked.body).toMatchObject({ ok: true, effective: { write_roots: [] } });
    expect((revoked.body["revoked"] as string[])[0]).toMatch(/^g-[0-9a-f]{8}$/);
    // idempotent: revoking what is not granted is still ok
    expect((await getJson(h.app, `/api/sessions/${S1}/grants`, jsonRequest("DELETE", { cap: "write_roots" }))).body).toEqual({
      ok: true,
      revoked: [],
      effective: { network: false, read_roots: [], write_roots: [], net_hosts: [], tool_extra: [], unsandboxed: false },
    });
    expect((await getJson(h.app, `/api/status?session=${S1}`)).body["grants_active"]).toEqual([]);
    const audits = readFileSync(join(h.root, "grants-audit.jsonl"), "utf8");
    expect(audits).toContain('"event":"grant"');
    expect(audits).toContain('"event":"revoke"');
  });

  it("answers every frozen error code, and a token is single-use", async () => {
    const h = make();
    const reset = (): void => {
      const base = h.studio.services.grants.now();
      h.studio.services.grants.now = () => base + 6 * 60_000; // step past the cooldown
    };
    expect((await grant(h, S1, { cap: "nope" })).body).toEqual({ ok: false, error: "invalid cap 'nope'" });
    reset();
    expect((await grant(h, S1, { cap: "unsandboxed" })).body).toEqual({ ok: false, error: "invalid cap 'unsandboxed'" });
    reset();
    expect((await grant(h, S1, { cap: "network", ttl_sec: 99999 })).body).toEqual({ ok: false, error: "ttl_sec exceeds the maximum for cap 'network' (3600)" });
    reset();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const leaky = await grant(h, S1, { cap: "network", note: secret });
    expect(leaky.status).toBe(400);
    expect(leaky.body).toEqual({ ok: false, error: "value looks like a credential" });
    expect(JSON.stringify(leaky.body)).not.toContain(secret);
    expect(readFileSync(join(h.root, "grants-audit.jsonl"), "utf8")).not.toContain(secret);
    reset();
    expect((await grant(h, S1, { cap: "net_hosts", scope: { hosts: [secret] } })).body).toEqual({
      ok: false,
      error: "invalid scope for cap 'net_hosts': value looks like a credential",
    });
    reset();
    expect((await grant(h, S1, { cap: "read_roots", scope: { roots: "relative" } })).body).toEqual({
      ok: false,
      error: "invalid scope for cap 'read_roots': scope.roots must be an array of strings",
    });
    reset();

    // §5.5: no token -> 403; a token is one-shot -> 409; an old one -> 403.
    expect((await grant(h, S1, { cap: "network" }, null)).body).toEqual({ ok: false, error: "grant confirmation required" });
    reset();
    const token = await grantToken(h, S1, "network", {});
    expect((await grant(h, S1, { cap: "network" }, token)).status).toBe(200);
    const replay = await grant(h, S1, { cap: "network" }, token);
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ ok: false, error: "confirmation token already used" });
    reset();
    const stale = await grantToken(h, S1, "tool_extra", { tools: ["browser"] });
    const issuedAt = h.studio.services.grants.now();
    h.studio.services.grants.now = () => issuedAt + 61_000;
    expect((await grant(h, S1, { cap: "tool_extra", scope: { tools: ["browser"] } }, stale)).status).toBe(403);

    // §5.5.2: the token endpoint needs browser same-origin evidence.
    const hash = "0".repeat(64);
    const bare = await getJson(h.app, `/api/sessions/${S1}/grants/confirm-token?cap=network&scope_hash=${hash}`);
    expect(bare.status).toBe(403);
    expect(bare.body).toEqual({ ok: false, error: "grant confirmation is not available over this transport" });
    // §6.1-§6.4: unknown session -> 404 on every grant route.
    expect((await getJson(h.app, "/api/sessions/sample-ws%2Fghost/grants")).status).toBe(404);
    expect((await getJson(h.app, `/api/sessions/sample-ws%2Fghost/grants/confirm-token?cap=network&scope_hash=${hash}`)).status).toBe(404);
  });

});

describe("workspaces endpoints", () => {
  it("registers a folder, rejects duplicates, renames and deregisters", async () => {
    const h = make();
    const other = join(h.root, "other-ws");
    mkdirSync(other);
    const created = await getJson(h.app, "/api/workspaces", jsonRequest("POST", { path: other }));
    expect(created.body).toEqual({ ok: true, name: "other-ws" });
    const dup = await getJson(h.app, "/api/workspaces", jsonRequest("POST", { path: other }));
    expect(dup.status).toBe(409);
    const relative = await getJson(h.app, "/api/workspaces", jsonRequest("POST", { path: "relative" }));
    expect(relative.body).toEqual({ ok: false, error: "path 'relative' must be absolute" });

    const view = await getJson(h.app, "/api/workspaces");
    expect((view.body["workspaces"] as unknown[]).length).toBe(2);

    const renamed = await getJson(h.app, "/api/workspaces/other-ws/rename", jsonRequest("POST", { new_name: "renamed-ws" }));
    expect(renamed.status).toBe(200);
    expect((renamed.body["workspaces"] as Array<{ name: string }>).map((w) => w.name)).toEqual(["sample-ws", "renamed-ws"]);
    expect(existsSync(join(h.root, "renamed-ws"))).toBe(true);

    expect((await getJson(h.app, "/api/workspaces/renamed-ws/delete", jsonRequest("POST"))).body).toEqual({ ok: true });
    const batch = await getJson(h.app, "/api/workspaces/batch-delete", jsonRequest("POST", { names: ["sample-ws", "ghost"] }));
    expect(batch.body).toEqual({ ok: true, deleted: 1, failed: [{ name: "ghost", error: "unknown workspace 'ghost'" }] });
  });
});

describe("fs browse", () => {
  it("lists directory names only, hides dot-dirs and never follows the roots list", async () => {
    const h = make();
    mkdirSync(join(h.root, "zdir"));
    mkdirSync(join(h.root, ".hidden"));
    const res = await getJson(h.app, `/api/fs/browse?path=${encodeURIComponent(h.root)}`);
    expect(res.status).toBe(200);
    expect(res.body["path"]).toBe(h.root);
    expect(res.body["dirs"]).toEqual(["dist", "sample-ws", "zdir"]);
    expect(res.body["roots"]).toEqual(["/src", "/tmp", "/srv", "/home"]);
    expect(res.body["parent"]).toBe(h.root.split("/").slice(0, -1).join("/"));
  });

  it("400s with the frozen body shape for a bad path", async () => {
    const h = make();
    const res = await getJson(h.app, "/api/fs/browse?path=relative");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ path: "relative", parent: null, dirs: [], roots: ["/src", "/tmp", "/srv", "/home"], error: "path 'relative' must be absolute" });
    const missing = await getJson(h.app, `/api/fs/browse?path=${encodeURIComponent(join(h.root, "nope"))}`);
    expect(missing.status).toBe(400);
    expect(String(missing.body["error"])).toContain("is not an existing directory");
  });
});

describe("providers endpoints", () => {
  it("upserts, defaults and deletes providers with a redacted public view", async () => {
    const h = make();
    const upsert = await getJson(
      h.app,
      "/api/providers",
      jsonRequest("POST", { id: "celestea", name: "Gateway", base_url: "http://127.0.0.1:3001/v1", api_key: "sk-SECRET", models: [{ id: "m-1", name: "M1", reasoning_efforts: ["low"] }] }),
    );
    expect(upsert.status).toBe(200);
    const text = JSON.stringify(upsert.body);
    expect(text).not.toContain("sk-SECRET");
    expect(text).not.toContain("api_key");
    expect(upsert.body).toMatchObject({ id: "celestea", has_key: true, is_default: false });
    expect(statSync(join(h.root, "providers.json")).mode & 0o777).toBe(0o600);

    const def = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "m-1" }));
    expect(def.status).toBe(200);
    expect(def.body["default_model"]).toBe("m-1");
    expect((def.body["providers"] as Array<{ is_default: boolean }>)[0]?.is_default).toBe(true);
    expect((await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: " " }))).body).toEqual({ ok: false, error: "model must not be empty" });

    expect((await getJson(h.app, "/api/providers/celestea/delete", jsonRequest("POST"))).body).toEqual({ ok: true });
    expect((await getJson(h.app, "/api/providers/celestea/delete", jsonRequest("POST"))).status).toBe(404);
    expect((await getJson(h.app, "/api/providers")).body).toEqual({ providers: [], default_model: null });
  });

  it("409s provider default while a turn runs", async () => {
    const h = make({ runtime: busyRuntime() });
    const res = await getJson(h.app, "/api/providers/default", jsonRequest("POST", { model: "m" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "a turn is running; provider default applies between turns" });
  });

  it("reports the probe error branches without a network call", async () => {
    const h = make();
    await getJson(h.app, "/api/providers", jsonRequest("POST", { id: "anth", base_url: "http://127.0.0.1:9999/v1", request_format: "anthropic_messages", api_key: "k" }));
    const unsupported = await getJson(h.app, "/api/providers/anth/models/fetch", jsonRequest("POST"));
    expect(unsupported.status).toBe(200);
    expect(unsupported.body).toEqual({ ok: false, error: "该请求格式暂不支持自动测试" });

    await getJson(h.app, "/api/providers", jsonRequest("POST", { id: "keyless", base_url: "http://127.0.0.1:9999/v1", models: [] }));
    const noKey = await getJson(h.app, "/api/providers/keyless/models/fetch", jsonRequest("POST"));
    expect(noKey.body).toEqual({ ok: false, error: "该提供商未配置 api_key" });
    expect((await getJson(h.app, "/api/providers/ghost/models/fetch", jsonRequest("POST"))).status).toBe(404);

    const test = await getJson(h.app, "/api/providers/test", jsonRequest("POST", { id: "anth" }));
    expect(test.status).toBe(200);
    expect(test.body).toEqual({ ok: false, error: "该请求格式暂不支持自动测试" });
    const testBad = await getJson(h.app, "/api/providers/test", jsonRequest("POST", { id: "inline" }));
    expect(testBad.status).toBe(400);
    expect(testBad.body).toEqual({ ok: false, error: "base_url is required" });
  });
});

describe("prompts endpoints", () => {
  it("returns the registry view for the global and the workspace scope", async () => {
    const h = make();
    const global = await getJson(h.app, "/api/prompts");
    expect(global.status).toBe(200);
    expect(global.body).toMatchObject({ ok: true, scope: "global", workspace: null, active_prompt: null });
    expect((global.body["sections"] as unknown[]).length).toBe(10);
    expect(global.body["global_file"]).toBe(join(h.root, "prompts.json"));

    const ws = await getJson(h.app, "/api/prompts?workspace=sample-ws");
    expect(ws.body["scope"]).toBe("workspace");
    expect(ws.body["workspace"]).toBe("sample-ws");
    const unknown = await getJson(h.app, "/api/prompts?workspace=ghost");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: "unknown workspace 'ghost'" });
  });

  it("upserts, defaults and deletes a prompt with hot apply", async () => {
    const h = make();
    const upsert = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-1", name: "P1", section_overrides: { identity: "custom {{model}}" }, is_default: true }));
    expect(upsert.body).toEqual({ ok: true, id: "p-1", scope: "global", hot_applied: true });
    expect(readFileSync(join(h.root, "prompts.json"), "utf8")).toContain("custom {{model}}");

    const badId = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "bad id", name: "x" }));
    expect(badId.status).toBe(400);
    expect(badId.body["error"]).toBe("prompt id must be 1-128 chars of [A-Za-z0-9._-]");
    const badVar = await getJson(h.app, "/api/prompts", jsonRequest("POST", { id: "p-2", name: "x", section_overrides: { identity: "{{nope}}" } }));
    expect(badVar.body).toEqual({ ok: false, error: "section 'identity': undefined prompt variable '{{nope}}'" });

    const def = await getJson(h.app, "/api/prompts/p-1/default", jsonRequest("POST", {}));
    expect(def.body).toEqual({ ok: true, default_prompt: "p-1", scope: "global", hot_applied: true });
    const del = await getJson(h.app, "/api/prompts/p-1/delete", jsonRequest("POST", {}));
    expect(del.body).toEqual({ ok: true, scope: "global", hot_applied: true });
    expect((await getJson(h.app, "/api/prompts/p-1/delete", jsonRequest("POST", {}))).status).toBe(404);
  });

  it("writes a workspace-scoped registry file and 409s while a turn runs", async () => {
    const h = make();
    const ws = await getJson(h.app, "/api/prompts", jsonRequest("POST", { workspace: "sample-ws", id: "ws-p", name: "WS" }));
    expect(ws.body).toEqual({ ok: true, id: "ws-p", scope: "workspace", hot_applied: true });
    expect(existsSync(join(h.workspace, ".celestea-prompts.json"))).toBe(true);

    const busy = make({ runtime: busyRuntime() });
    const res = await getJson(busy.app, "/api/prompts", jsonRequest("POST", { id: "p", name: "P" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "turn in progress; prompt applies between turns" });
    expect(existsSync(join(busy.root, "prompts.json"))).toBe(false);
  });
});

describe("worker endpoints", () => {
  it("spawns, sends to and reports workers through the runtime adapter", async () => {
    const h = make();
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "do the thing", title: "T" }));
    expect(spawn.status).toBe(200);
    expect(spawn.body).toEqual({ ok: true, sessionId: "session-1", title: "T", wid: "W1" });

    const sessions = await getJson(h.app, "/api/sessions");
    const worker = (sessions.body["sessions"] as Array<Record<string, unknown>>).find((s) => s["kind"] === "worker");
    expect(worker).toMatchObject({ id: "worker:session-1", workspace: "engine" });

    const messages = await getJson(h.app, "/api/sessions/worker%3Asession-1/messages");
    expect(messages.body).toMatchObject({ ok: true, session: "worker:session-1" });
    expect((await getJson(h.app, "/api/sessions/worker%3Aghost/messages")).status).toBe(404);

    const send = await getJson(h.app, "/api/worker/send", jsonRequest("POST", { target: "session-1", content: "hi" }));
    expect(send.body).toMatchObject({ ok: true, delivered: true });
    const missed = await getJson(h.app, "/api/worker/send", jsonRequest("POST", { target: "nope", content: "hi" }));
    expect(missed.body).toMatchObject({ ok: false, delivered: false });

    const status = await getJson(h.app, "/api/worker/status");
    expect(status.body).toMatchObject({ ok: true, total: 1 });
    const filtered = await getJson(h.app, "/api/worker/status?wid=W1");
    expect(filtered.body).toMatchObject({ ok: true, wid: "W1", total: 1 });
    const missing = await getJson(h.app, "/api/worker/status?wid=W9");
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ ok: false, wid: "W9", error: "no worker W9 in registry" });

    const noBody = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W2" }));
    expect(noBody.status).toBe(422);
  });
});

