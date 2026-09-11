import { describe, expect, it } from "vitest";
import {
  loadDataFileSchema,
  loadDataFilesIndex,
  loadEndpoints,
  loadRouteSnapshot,
  loadSessionEventSchema,
  loadSse,
  loadTools,
  SSE_EVENT_NAMES,
  SESSION_EVENT_TYPES,
  TURN_OUTCOMES,
} from "@celestea/core";

describe("contracts/endpoints.json", () => {
  const c = loadEndpoints();

  it("holds exactly 44 API endpoints (W725 added the context snapshot)", () => {
    expect(c.count).toBe(44);
    expect(c.endpoints).toHaveLength(44);
  });

  it("every endpoint is an /api/* route with a method, a response and a doc ref", () => {
    for (const e of c.endpoints) {
      expect(e.path.startsWith("/api/")).toBe(true);
      expect(["GET", "POST", "DELETE"]).toContain(e.method);
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

  it("matches the Rust route table snapshot plus the declared TS-only delta", () => {
    const snap = loadRouteSnapshot();
    expect(snap.routeDeclarations).toBe(38);
    expect(snap.methodPathCombos).toBe(43);
    expect(snap.staticRoutes).toHaveLength(4);
    const api = snap.routes.filter((r) => r.path.startsWith("/api/"));
    expect(api).toHaveLength(39);
    // W516/W725: the Rust extraction stays verbatim; the four grants endpoints
    // and the context snapshot are declared as a TypeScript-only delta instead
    // of being written into it.
    expect(snap.tsOnlyRoutes).toHaveLength(5);
    expect(snap.tsApiEndpoints).toBe(44);
    expect(snap.tsMethodPathCombos).toBe(48);
    const fromSnapshot = new Set([...api, ...(snap.tsOnlyRoutes ?? [])].map((r) => `${r.method} ${r.path}`));
    expect(fromSnapshot.size).toBe(44);
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
});

describe("contracts/sse-events.json", () => {
  const s = loadSse();

  it("holds the 8 SSE event names", () => {
    expect(s.count).toBe(8);
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

  it("holds the 10 engine tools with parameters", () => {
    expect(t.count).toBe(10);
    expect(t.tools).toHaveLength(10);
    for (const tool of t.tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters["type"]).toBe("object");
      expect(tool.sourceRef.length).toBeGreaterThan(0);
    }
  });

  it("matches the live /api/tools name set", () => {
    expect(t.tools.map((x) => x.name).sort()).toEqual(
      ["http_request", "list_dir", "process_control", "read_file", "run_code", "run_shell", "session_send_message", "spawn_worker", "worker_status", "write_file"],
    );
  });
});

describe("contracts/session-event.schema.json", () => {
  const s = loadSessionEventSchema();
  const defs = s["$defs"] as Record<string, { oneOf: unknown[] }>;

  it("declares the 7 SessionEvent variants", () => {
    expect(defs["SessionEvent"]?.oneOf).toHaveLength(SESSION_EVENT_TYPES.length);
    expect(SESSION_EVENT_TYPES).toHaveLength(7);
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

  it("freezes 10 data-file schemas and forbids a version field", () => {
    expect(idx.files).toHaveLength(10);
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

  // W728 §3 P0: the ledger and its price snapshot are data files, and P0 added
  // NO endpoint — C9's `API_ENDPOINT_COUNT === 44` is the frozen count.
  it("registers the usage ledger and the pricing snapshot (W728), still on 44 endpoints", () => {
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

    expect(loadEndpoints().count).toBe(44);
  });
});
