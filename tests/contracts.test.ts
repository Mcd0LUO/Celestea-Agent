import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_ENDPOINT_COUNT } from "../apps/studio/src/routes.js";
import {
  loadDataFileSchema,
  loadDataFilesIndex,
  loadEndpoints,
  loadRouteSnapshot,
  loadSessionEventSchema,
  loadSse,
  loadTools,
  SSE_EVENT_NAMES,
  repoRoot,
  SESSION_EVENT_TYPES,
  TURN_OUTCOMES,
} from "@celestea/core";

describe("contracts/endpoints.json", () => {
  const c = loadEndpoints();

  // W791: 50 -> 51 (`POST /api/sessions/{id}/mode`, the P1 session working mode).
  // W9: 51 -> 57 (the six permission endpoints); W860: 57 -> 60 (session tool
  // switches + the host plugin inventory); W870: 60 -> 61 (the session-level
  // model switch `PUT /api/sessions/{id}/model`); G5: 61 -> 62 (`GET /api/fs/list`).
  // W1528: 66 -> 69 (the workbench terminal's real-PTY face: open / input / close).
  it("holds exactly 69 endpoints (W725 context, W767 cookie gate, W783 questions, W785 ledger, W791 mode, W9 permissions, W860 tools/plugins, W870 session model, G5 fs list, W895 display plugins, W1528 terminal)", () => {
    expect(c.count).toBe(69);
    expect(c.endpoints).toHaveLength(69);
  });

  // W767: Studio's own login-cookie gate is served on `/login` + `/auth/*` — the
  // ONE documented exception to "every contract endpoint lives under /api/".
  const NON_API_PATHS = ["/login", "/auth/login", "/auth/check"];

  it("every endpoint is an /api/* route (or one of the W767 auth paths) with a method, a response and a doc ref", () => {
    for (const e of c.endpoints) {
      expect(e.path.startsWith("/api/") || NON_API_PATHS.includes(e.path)).toBe(true);
      expect(["GET", "POST", "DELETE", "PUT"]).toContain(e.method);
      expect(e.id).toMatch(/^[a-z0-9_]+$/);
      expect(e.response.status).toBeGreaterThanOrEqual(200);
      expect(e.docRef.length).toBeGreaterThan(0);
      expect(Array.isArray(e.errors)).toBe(true);
    }
  });

  it("has unique (method, path) pairs", () => {
    const keys = c.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the frozen route table snapshot plus the declared TS-only delta", () => {
    const snap = loadRouteSnapshot();
    expect(snap.routeDeclarations).toBe(38);
    expect(snap.methodPathCombos).toBe(43);
    expect(snap.staticRoutes).toHaveLength(4);
    const api = snap.routes.filter((r) => r.path.startsWith("/api/"));
    expect(api).toHaveLength(39);
    // W516/W725/W767: the frozen extraction stays verbatim; the four grants
    // endpoints, the context snapshot and the three login-cookie endpoints are
    // declared as a TypeScript-only delta instead of being written into it.
    // W783: 8 -> 10 (GET /api/questions + POST /api/questions/{id}/answer).
    // W785: 10 -> 11 (GET /api/usage/ledger).
    // W791: 11 -> 12 (POST /api/sessions/{id}/mode); W9: 12 -> 18 (the six
    // permission endpoints); W860: 18 -> 21 (tool switches + plugin inventory);
    // W870: 21 -> 22 (PUT /api/sessions/{id}/model); G5: 22 -> 23 (GET /api/fs/list).
    // W1528: 23 -> 26 (the terminal's open / input / close).
    expect(snap.tsOnlyRoutes).toHaveLength(30);
    expect(snap.tsApiEndpoints).toBe(69);
    expect(snap.tsMethodPathCombos).toBe(73);
    const fromSnapshot = new Set([...api, ...(snap.tsOnlyRoutes ?? [])].map((r) => `${r.method} ${r.path}`));
    expect(fromSnapshot.size).toBe(69);
    const fromContract = new Set(c.endpoints.map((e) => `${e.method} ${e.path}`));
    expect([...fromContract].sort()).toEqual([...fromSnapshot].sort());
  });

  it("documents the documented error status codes", () => {
    for (const code of ["400", "404", "409", "500", "502"]) {
      expect(c.errorCodes[code]).toBeDefined();
    }
  });

  it("keeps the provider public_view api_key-free", () => {
    const p = c.endpoints.find((e) => e.id === "get_providers");
    expect(p?.response.publicView?.excluded).toContain("api_key");
    const fieldNames = (p?.response.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(["providers", "default_model"]);
    expect(JSON.stringify(fieldNames)).not.toContain("api_key");
  });

  // W887: the version is derived from git (single source = scripts/version.mjs) and
  // exposed as a PURE ADDITION on the existing health endpoint — no new endpoint.
  it("declares the W887 derived health version field", () => {
    const health = c.endpoints.find((e) => e.id === "get_health");
    const field = health?.response.fields.find((f) => f.name === "version");
    expect(field?.type).toBe("string");
    expect(String(field?.note)).toContain("git tag");
    expect(health?.notes?.some((n) => n.includes("W887"))).toBe(true);
    expect(c.count).toBe(69);
  });

  it("freezes the W804 per-model modality bits with the optimistic default", () => {
    const doc = loadDataFileSchema("providers.schema.json");
    const schema = doc["schema"] as {
      properties: { providers: { items: { properties: { models: { items: { properties: Record<string, { default?: unknown; description?: string }> } } } } } };
    };
    const models = schema.properties.providers.items.properties.models.items.properties;
    expect(models["input_modalities"]?.default).toEqual(["text", "image"]);
    expect(models["output_modalities"]?.default).toEqual(["text"]);
    expect(models["input_modalities"]?.description).toContain("OPTIMISTIC");
    const pv = doc["publicView"] as { fields: string[] };
    expect(pv.fields).toContain("models[].input_modalities");
    expect(pv.fields).toContain("models[].output_modalities");
  });
});

describe("contracts/sse-events.json", () => {
  const s = loadSse();

  // W783: 8 -> 9 (`question`); W1528: 9 -> 10 (`terminal`).
  it("holds the 10 SSE event names", () => {
    expect(s.count).toBe(10);
    expect(s.events.map((e) => e.name)).toEqual([...SSE_EVENT_NAMES]);
  });

  it("freezes the envelope and the 512-capacity bus", () => {
    expect(s.transport.envelope).toEqual({ turn: "u64", seq: "u64 (global atomic counter, monotonic across the process)", payload: "object" });
    expect(s.transport.busCapacity).toBe(512);
    expect(s.transport.keepAlive).toBe(true);
  });

  it("freezes the lagged semantics (stream continues, no replay)", () => {
    expect(s.lagged.event).toBe("status");
    expect(s.lagged.payload.phase).toBe("lagged");
    expect(s.lagged.payload.hint).toBe("slow client, skipped events");
    expect(s.lagged.semantics).toContain("does NOT close");
  });

  it("marks compact turn as always 0", () => {
    const compact = s.events.find((e) => e.name === "compact");
    expect(compact?.note).toContain("ALWAYS 0");
  });
});

describe("contracts/tools.json", () => {
  const t = loadTools();

  // W783: 10 -> 11 (`ask_user_question`); W804: 11 -> 12 (`read_image`); W7: 12 -> 13 (`send_message` rename + `stop_worker`);
  // W884: 13 -> 14 (`load_skill`); F4: 14 -> 16 (browser pair); B2: 16 -> 18
  // (`remember` + `forget`, the workspace-memory write pair).
  it("holds the 18 engine tools with parameters", () => {
    expect(t.count).toBe(18);
    expect(t.tools).toHaveLength(18);
    for (const tool of t.tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters["type"]).toBe("object");
      expect(tool.sourceRef.length).toBeGreaterThan(0);
    }
  });

  it("matches the live /api/tools name set", () => {
    expect(t.tools.map((x) => x.name).sort()).toEqual(
      ["ask_user_question", "browser_act", "browser_open", "forget", "http_request", "list_dir", "load_skill", "process_control", "read_file", "read_image", "remember", "run_code", "run_shell", "send_message", "spawn_worker", "stop_worker", "worker_status", "write_file"],
    );
  });
});

describe("contracts/session-event.schema.json", () => {
  const s = loadSessionEventSchema();
  const defs = s["$defs"] as Record<string, { oneOf: unknown[] }>;

  // W783: 7 -> 9 (user_question / user_answer).
  it("declares the 9 SessionEvent variants", () => {
    expect(defs["SessionEvent"]?.oneOf).toHaveLength(SESSION_EVENT_TYPES.length);
    expect(SESSION_EVENT_TYPES).toHaveLength(9);
  });

  it("declares the 5 TurnOutcome states", () => {
    expect(defs["TurnOutcome"]?.oneOf).toHaveLength(TURN_OUTCOMES.length);
    expect(TURN_OUTCOMES).toHaveLength(5);
  });

  it("freezes the turn id pattern and the two projections", () => {
    expect((s["turnId"] as { pattern: string }).pattern).toBe("^turn-\\d+$");
    expect((s["turnId"] as { monotonic: boolean }).monotonic).toBe(true);
    const projections = s["projections"] as Record<string, string>;
    expect(projections["studioMessages"]).toContain("session_event_to_message");
    expect(projections["engineDeriveMessages"]).toContain("SKIPPED");
  });

  it("marks parent_id as optional on both tool variants", () => {
    const variants = defs["SessionEvent"]?.oneOf as Array<{ properties: Record<string, unknown>; required: string[] }>;
    for (const v of variants) {
      if (!("parent_id" in v.properties)) continue;
      expect(v.required).not.toContain("parent_id");
    }
  });
});

describe("contracts/data-files", () => {
  const idx = loadDataFilesIndex();

  // W785 (E §4.2.4 P1): 11 -> 12 — `fallbacks.json` (the model-fallback
  // sidecar) joined the frozen set; no existing schema changed.
  // W787 (E §2.2.1/§2.3 P0): 12 -> 13 — the STUDIO's own worker table
  // (`<data dir>/worker-registry.tsv`) is a data file of its own, sharing the
  // `registry-tsv.schema.json` format with the DSH-side `/tmp` one.
  it("freezes 13 data-file schemas and forbids a version field", () => {
    expect(idx.files).toHaveLength(13);
    expect(idx.freezeRule).toContain("NO format changes");
    for (const f of idx.files) expect(f.schema.endsWith(".schema.json")).toBe(true);
  });

  it("marks providers.json as the only secret file", () => {
    const secrets = idx.files.filter((f) => f.secret === true).map((f) => f.file);
    expect(secrets).toEqual(["providers.json"]);
  });

  it("requires a round-trip test for every file", () => {
    expect(idx.roundTripRequirement).toContain("read -> write -> re-read");
  });

  // W804 (multimodal P0 section 5): the attachment object store is a binary,
  // content-addressed store — deliberately NOT a 14th "data file" (there is no
  // JSON schema for a directory), so it is recorded as its own block.
  it("records the W804 attachment object store and its fixtures exclusion", () => {
    expect(idx.attachments?.location).toBe("<session-dir>/attachments/<sha256>.<ext>");
    expect(idx.attachments?.fixtures).toContain("never enter fixtures");
    expect(idx.attachments?.schema).toContain("AttachmentRef");
  });

  // W728 §3 P0: the ledger and its price snapshot are data files; P0 added no
  // endpoint of its own. W785's aggregate endpoint is the ledger's ONLY endpoint;
  // the frozen count was W785's 50 and is W870's 61 (`API_ENDPOINT_COUNT`).
  it("registers the usage ledger and the pricing snapshot (W728), 64 endpoints after the G5 follow-up", () => {
    const names = idx.files.map((f) => f.file);
    expect(names).toContain("usage-ledger.jsonl");
    expect(names).toContain("pricing.json");
    expect(idx.files.find((f) => f.file === "usage-ledger.jsonl")?.mode).toBe("0600");
    expect(idx.durability["usage-ledger.jsonl"]).toContain("append-only");

    const ledger = loadDataFileSchema("usage-ledger.schema.json");
    const defs = (ledger["schema"] as { $defs: Record<string, unknown> }).$defs;
    expect(Object.keys(defs).sort()).toEqual(["cost", "price", "step", "turn_total", "usage"]);
    const kind = (defs["step"] as { properties: Record<string, { enum?: string[] }> }).properties["kind"];
    expect(kind?.enum).toEqual(["ok", "error"]);
    expect(loadDataFileSchema("pricing.schema.json")["title"]).toContain("pricing.json");

    expect(loadEndpoints().count).toBe(69);
  });
});

describe("E-P0③ checkpoint + boot recovery (contract delta)", () => {
  const idx = loadDataFilesIndex();

  it("registers checkpoint.json as a data file and keeps the endpoint count frozen", () => {
    const entry = idx.files.find((f) => f.file === "checkpoint.json");
    expect(entry?.schema).toBe("checkpoint.schema.json");
    expect(entry?.mode).toBe("0600");
    expect(idx.durability["checkpoint.json"]).toContain("tmp-<pid> + rename");
    expect(idx.recovery?.implemented).toContain("turn_end: interrupted");
    // P0 adds NO endpoint: /api/status.recovery is P1 and stays out. The count
    // moved for the unrelated reason that the question, ledger, mode, permission,
    // session-tool, plugin and session-model endpoints exist (W870: 61); W1528
    // added the terminal's three.
    expect(loadEndpoints().count).toBe(69);
    expect(loadEndpoints().endpoints).toHaveLength(69);
  });

  it("freezes the sidecar shape (version, open_turn, repaired[])", () => {
    const schema = loadDataFileSchema("checkpoint.schema.json")["schema"] as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    // W787 (E §1.3 P1 ①): `delivered_ids` joined the required set — the bounded
    // ledger of accepted injection ids that makes a receipt's idempotency key
    // survive a restart. The lanes now reference a declared message shape.
    expect(schema.required).toEqual(["version", "session", "pid", "boot_id", "updated_at", "clean_shutdown", "open_turn", "last_outcome", "degraded", "lanes", "delivered_ids", "repaired"]);
    expect(schema.properties["version"]?.["const"]).toBe(1);
    expect(schema.properties["boot_id"]?.["pattern"]).toBe("^b-[0-9a-f]{8}$");
    expect(schema.properties["open_turn"]?.["type"]).toEqual(["object", "null"]);
    const repaired = schema.properties["repaired"] as { items: { properties: Record<string, { const?: string }> } };
    expect(repaired.items.properties["action"]?.["const"]).toBe("synthesize_turn_end");
  });

  it("A8/W787: registers the P1 status field and the worker tables (contract sync §5.3)", () => {
    const byId = new Map(loadEndpoints().endpoints.map((e) => [e.id, e]));
    // capability 1-P1: `recovery` on the EXISTING status endpoint (no new endpoint).
    const recovery = byId.get("get_status")?.response.fields.find((f) => f.name === "recovery");
    expect(String(recovery?.type)).toContain("recovered_turns:array<string>");
    expect(String(recovery?.type)).toContain("dangling_turns:integer");
    // capability 2-P0: `stale[]` / `orphans[]` on the EXISTING worker status.
    const worker = byId.get("get_worker_status")?.response.fields.map((f) => f.name) ?? [];
    expect(worker).toContain("stale");
    expect(worker).toContain("orphans");
    expect(loadEndpoints().count).toBe(69);
    expect(API_ENDPOINT_COUNT).toBe(69);
  });

  it("W1470b: the previous generation is a declared PURE ADDITION on both listings", () => {
    const byId = new Map(loadEndpoints().endpoints.map((e) => [e.id, e]));
    // ① the status endpoint reports it next to stale[]/orphans[] …
    const status = byId.get("get_worker_status");
    const field = status?.response.fields.find((f) => f.name === "inherited");
    expect(String(field?.type)).toContain("inherited");
    expect(String(field?.note)).toContain("NEVER counted in total/by_status/by_state");
    expect((status?.notes ?? []).some((n) => n.includes("SAME fact the tool face reports"))).toBe(true);
    // ② … and the session listing marks the worker rows the same way.
    const sessions = byId.get("get_sessions");
    const rowType = String(sessions?.response.fields[0]?.type);
    expect(rowType).toContain("inherited?:true");
    expect(rowType).toContain("parentSessionId?:string");
    expect((sessions?.notes ?? []).some((n) => n.includes("PLUS the previous one"))).toBe(true);
    // No new endpoint: the count is frozen at the W870 number (+ W1528's three).
    expect(loadEndpoints().count).toBe(69);
    expect(API_ENDPOINT_COUNT).toBe(69);
  });

  it("B7: the studio's own worker table is a declared data file with the new tokens", () => {
    const entry = idx.files.find((f) => f.file === "<data dir>/worker-registry.tsv");
    expect(entry?.schema).toBe("registry-tsv.schema.json");
    expect(String(entry?.note)).toContain("CELESTEA_WORKER_REGISTRY");
    // The registry schema keeps its shape at the TOP level (unlike the sidecar
    // schemas, whose JSON Schema lives under `schema`).
    const schema = loadDataFileSchema("registry-tsv.schema.json") as unknown as {
      extraTokens: { whitelist: string[]; added: Record<string, string>; known: string[] };
      path: Record<string, string>;
      format: Record<string, string>;
      recovery: Record<string, string>;
    };
    // W1470 appended `claimed` (the P2 handover stamp) WITHOUT changing the
    // column count — the same backward-compatible move W787 made for four tokens.
    expect(schema.extraTokens.whitelist).toEqual(["host", "attempt", "lease", "receipt", "claimed"]);
    expect(Object.keys(schema.extraTokens.added).sort()).toEqual(["attempt", "claimed", "host", "lease", "receipt"]);
    expect(schema.path["studio"]).toContain("<data dir>/worker-registry.tsv");
    expect(schema.path["ownershipRule"]).toContain("MUST NEVER write each other");
    // The tokens a row is BUILT from are declared (the round-trip itself is
    // asserted in `packages/workers/src/registry.test.ts`).
    const tokens: string[] = schema.extraTokens.known;
    for (const token of ["host=", "attempt=", "lease=", "receipt=", "claimed="]) expect(tokens.some((t) => t.startsWith(token))).toBe(true);
    // W1470: the schema also freezes the P0/P2 split and the restart rules, so the
    // switch (`CELESTEA_WORKER_RECOVER=1`, default OFF) cannot drift from the code.
    expect(schema.recovery["observation"]).toContain("read-only");
    expect(schema.recovery["action"]).toContain("CELESTEA_WORKER_RECOVER=1 ONLY");
    expect(schema.recovery["addressability"]).toContain("RESERVED");
  });

  it("keeps the session-event contract untouched (interrupted is a legal outcome)", () => {
    const s = loadSessionEventSchema();
    const defs = s["$defs"] as Record<string, { oneOf: Array<{ const?: string }> }>;
    expect(TURN_OUTCOMES).toContain("interrupted");
    expect(defs["TurnOutcome"]?.oneOf).toHaveLength(5);
    // W783 appended the two host-side question variants; interrupted legality is
    // unaffected.
    expect(defs["SessionEvent"]?.oneOf).toHaveLength(9);
  });
});

describe("W729 session modes (P0 contract delta)", () => {
  const c = loadEndpoints();
  const tools = loadTools();

  it("adds the mode fields to EXISTING endpoints only (47 unchanged by W729)", () => {
    const byId = new Map(c.endpoints.map((e) => [e.id, e]));
    expect(byId.get("post_sessions")?.request.fields.map((f) => f.name)).toContain("mode");
    expect(byId.get("post_sessions")?.errors).toContainEqual({ status: 400, error: "invalid mode: {v}" });
    expect(String(byId.get("get_sessions")?.response.fields[0]?.type)).toContain("mode:");
    expect(byId.get("get_status")?.response.fields.map((f) => f.name)).toContain("mode");
    expect(String(byId.get("get_health")?.response.fields.find((f) => f.name === "capabilities")?.type)).toContain("session_mode");
    // W729 added no endpoint; W791's mode switch is the P1 addition (50 -> 51),
    // W9's six permission endpoints took it to 57, W860's three to 60, W870's
    // session-level model switch to 61 and W1528's terminal face to 69.
    expect(c.count).toBe(69);
    expect(c.endpoints).toHaveLength(69);
  });

  it("declares spawn_worker.mode without changing the tool count", () => {
    const spawn = tools.tools.find((t) => t.name === "spawn_worker");
    const properties = spawn?.parameters["properties"] as Record<string, { enum?: string[] }>;
    expect(properties["mode"]?.enum).toEqual(["standard", "execution"]);
    // `additionalProperties: false` means an undeclared argument is a schema error.
    expect(spawn?.parameters["additionalProperties"]).toBe(false);
    // W729 changed no tool count; W783 took it to 11; W804 added read_image (12); W7 renamed + added stop_worker (13);
    // W884 added load_skill (14); F4 added browser_open + browser_act (16).
    expect(tools.count).toBe(18);
    // B2 added remember + forget (18).
    expect(tools.tools).toHaveLength(18);
  });

  it("freezes the session.json mode enum and the W779 title, unknown keys tolerated", () => {
    const schema = loadDataFileSchema("session.schema.json")["schema"] as {
      properties: Record<string, { enum?: string[]; type?: string }>;
      additionalProperties?: boolean;
    };
    expect(schema.properties["mode"]?.enum).toEqual(["standard", "execution"]);
    // W779 T2: the display name the GUI shows, next to the sanitized dir name.
    expect(schema.properties["title"]?.type).toBe("string");
    expect(schema.additionalProperties).toBe(true);
    // W785: 11 -> 12 (`fallbacks.json`, the model-fallback sidecar);
    // W787: 12 -> 13 (the studio's own worker table, §2.2.1).
    expect(loadDataFilesIndex().files).toHaveLength(13);
  });

  it("M14: one mode semantics — no host preset token in the Studio tree", () => {
    const forbidden = /agent_?[Pp]reset/;
    const roots = [join(repoRoot(), "apps", "studio", "src"), join(repoRoot(), "contracts")];
    for (const pkg of readdirSync(join(repoRoot(), "packages"))) roots.push(join(repoRoot(), "packages", pkg, "src"));
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(ts|json)$/.test(file)) continue;
        if (forbidden.test(readFileSync(file, "utf8"))) hits.push(file.slice(repoRoot().length + 1));
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("W791 P1 session mode + archived list (contract delta)", () => {
  const c = loadEndpoints();
  const byId = new Map(c.endpoints.map((e) => [e.id, e]));

  it("adds exactly ONE endpoint — the mode switch — with the frozen error texts", () => {
    const mode = byId.get("post_session_mode");
    expect(mode?.path).toBe("/api/sessions/{id}/mode");
    expect(mode?.method).toBe("POST");
    expect(mode?.request.fields.map((f) => f.name)).toEqual(["mode"]);
    expect(mode?.response.fields.map((f) => f.name)).toEqual(["ok", "session", "mode", "effective"]);
    // The 409 guard is /compact's sentence with this action's verb (U8).
    expect(mode?.errors).toContainEqual({ status: 409, error: "turn 进行中，无法切换模式" });
    expect(mode?.errors).toContainEqual({ status: 400, error: "invalid mode: {v}" });
    // Declared as TypeScript-only (the retired backend has no counterpart).
    const tsOnly = loadRouteSnapshot().tsOnlyRoutes ?? [];
    expect(tsOnly.map((r) => `${r.method} ${r.path}`)).toContain("POST /api/sessions/{id}/mode");
    expect(c.count).toBe(69);
    expect(API_ENDPOINT_COUNT).toBe(69);
  });

  it("documents the ?session= query of GET /api/tools (absent = the focused session)", () => {
    const tools = byId.get("get_tools");
    expect(tools?.request.kind).toBe("query");
    expect(tools?.request.fields.map((f) => f.name)).toEqual(["session"]);
    expect(String(tools?.response.fields[0]?.note)).toContain("14 tools");
  });

  it("documents the ?archived= query of GET /api/sessions without adding an endpoint", () => {
    const sessions = byId.get("get_sessions");
    expect(sessions?.request.kind).toBe("query");
    expect(sessions?.request.fields.map((f) => f.name)).toEqual(["archived"]);
    // The parameter's OWN note is pinned, so "documented but wrong" fails here.
    expect(String(sessions?.request.fields[0]?.note)).toContain("`1` or `true` lists ONLY the archived sessions");
    expect(String(sessions?.request.kind === "query" ? sessions?.request.note : "")).toContain("workspaces/<ws>/archive/");
    // The row type carries the OPTIONAL flag; the default body stays as it was.
    expect(String(sessions?.response.fields[0]?.type)).toContain("archived?:true");
    expect(String(sessions?.response.fields[0]?.note)).toContain("ONLY on the `?archived=1` listing");
    expect(sessions?.notes?.some((n) => n.includes("?archived=1"))).toBe(true);
    // B adds NO endpoint: W791's 51 is the mode switch alone (W860's 60 comes
    // from the session-tool switches and the plugin inventory; W870's 61 is the
    // session-level model switch; W1528's 69 adds the terminal's three).
    expect(c.count).toBe(69);
    expect(c.endpoints).toHaveLength(69);
  });
});

describe("W870 session-scoped model switch (contract delta)", () => {
  const c = loadEndpoints();
  const byId = new Map(c.endpoints.map((e) => [e.id, e]));
  const model = byId.get("put_session_model");

  it("adds exactly ONE endpoint — PUT /api/sessions/{id}/model — with the frozen texts", () => {
    expect(model?.path).toBe("/api/sessions/{id}/model");
    expect(model?.method).toBe("PUT");
    expect(model?.request.fields.map((f) => f.name)).toEqual(["model"]);
    expect(model?.response.fields.map((f) => f.name)).toEqual(["ok", "session", "model", "covered", "effective"]);
    // The 409 guard is /compact's and the mode switch's sentence with this verb.
    expect(model?.errors).toContainEqual({ status: 409, error: "turn 进行中，无法切换模型" });
    expect(model?.errors).toContainEqual({ status: 422, error: "field 'model' must be a string" });
    // Declared as TypeScript-only (the retired backend has no counterpart).
    const tsOnly = loadRouteSnapshot().tsOnlyRoutes ?? [];
    expect(tsOnly.map((r) => r.method + " " + r.path)).toContain("PUT /api/sessions/{id}/model");
    // The product semantic is frozen in the contract text itself: the picker's
    // target is THIS endpoint, while POST /api/config stays the global default.
    expect(model?.notes?.some((n) => n.includes("POST /api/config"))).toBe(true);
    expect(model?.notes?.some((n) => n.includes("profileFor"))).toBe(true);
    expect(c.count).toBe(69);
    expect(c.endpoints).toHaveLength(69);
    expect(API_ENDPOINT_COUNT).toBe(69);
  });

  it("keeps POST /api/config meaning the GLOBAL default (no semantic drift)", () => {
    const post = byId.get("post_config");
    expect(post?.path).toBe("/api/config");
    expect(post?.request.fields.map((f) => f.name)).toContain("model");
    // The config endpoint never mentions a session-scoped model: that is the new
    // endpoint's job, and the two must not converge back into one.
    expect(JSON.stringify(post)).not.toContain("put_session_model");
  });
});

/** Every file under `dir` (the repo is small; the gate reads only ts/json). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
