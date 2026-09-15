/**
 * Machine-readable contract loader (P0).
 *
 * Everything under contracts/ is frozen data; this module only reads and
 * validates it. Counts are asserted here so a drifted contract fails loudly.
 */

import { readFileSync } from "node:fs";
import { contractPath } from "../repo.js";
import type { ToolSpec } from "../types.js";

export interface EndpointField {
  name: string;
  type: string;
  required?: boolean;
  /** Present only in some response variants (e.g. kept_turns when compacted). */
  optional?: boolean;
  note?: string;
}
export interface EndpointRequest {
  kind: "none" | "json" | "query";
  fields: EndpointField[];
  note?: string;
}
export interface EndpointResponse {
  status: number;
  shape: string;
  fields: EndpointField[];
  contentType?: string;
  publicView?: { excluded: string[]; note: string };
}
export interface EndpointError {
  status: number;
  error: string;
  note?: string;
}
export interface EndpointProbe {
  checked: boolean;
  mode?: string;
  server?: string;
  reason?: string;
  [k: string]: unknown;
}
export interface EndpointContract {
  id: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  group: string;
  rustHandler: string;
  docRef: string;
  request: EndpointRequest;
  response: EndpointResponse;
  errors: EndpointError[];
  notes?: string[];
  probe?: EndpointProbe;
}

export interface EndpointsContract {
  title: string;
  generatedAt: string;
  source: Record<string, string>;
  conventions: Record<string, string>;
  errorCodes: Record<string, string>;
  count: number;
  endpoints: EndpointContract[];
}

export interface SseEventContract {
  name: string;
  payload: Record<string, string>;
  source: string;
  codeRef: string;
  frontendListens: boolean;
  note?: string;
}
export interface SseContract {
  transport: {
    contentType: string;
    keepAlive: boolean;
    busCapacity: number;
    envelope: Record<string, string>;
    frameFormat: string;
  };
  lagged: { trigger: string; event: string; payload: Record<string, string>; semantics: string; codeRef: string };
  count: number;
  events: SseEventContract[];
}

export interface RouteSnapshotEntry {
  method: string;
  path: string;
  rustHandler: string;
}
export interface RouteSnapshot {
  routeDeclarations: number;
  methodPathCombos: number;
  apiEndpoints: number;
  staticRoutes: RouteSnapshotEntry[];
  routes: RouteSnapshotEntry[];
  /**
   * W516: routes that exist ONLY in the TypeScript backend (no Rust
   * counterpart). The Rust extraction above stays intact; a contract endpoint
   * must appear in `routes` or here.
   */
  tsOnlyRoutes?: RouteSnapshotEntry[];
  tsApiEndpoints?: number;
  tsMethodPathCombos?: number;
}

export interface ToolsContract {
  count: number;
  tools: Array<ToolSpec & { sourceRef: string }>;
}

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(contractPath(...parts), "utf8")) as T;
}

export function loadEndpoints(): EndpointsContract {
  const c = readJson<EndpointsContract>("endpoints.json");
  // W725: 43 -> 44 (GET /api/sessions/{id}/context).
  // W767: 44 -> 47 (GET /login, POST /auth/login, GET /auth/check — Studio's own
  // login-cookie gate; the two non-/api paths are declared in the contract too).
  // W783 (2): 47 -> 49 — GET|POST /api/questions (+ the pending list on GET).
  // W785 (1): 49 -> 50 — GET /api/usage/ledger (E-P1, capability 3).
  // W791 (2): 50 -> 51 — POST /api/sessions/{id}/mode (P1 session working mode,
  // TS-only; docs/modes-standard-vs-execution.md §3.1).
  if (c.count !== 51 || c.endpoints.length !== 51) {
    throw new Error(`endpoints contract must hold 51 endpoints, got ${c.endpoints.length}`);
  }
  return c;
}

export function loadSse(): SseContract {
  const c = readJson<SseContract>("sse-events.json");
  // W783: 8 -> 9 (the host-emitted `question` frame, while a turn is parked).
  if (c.count !== 9 || c.events.length !== 9) {
    throw new Error(`SSE contract must hold 9 events, got ${c.events.length}`);
  }
  return c;
}

export function loadRouteSnapshot(): RouteSnapshot {
  return readJson<RouteSnapshot>("rust-route-table.snapshot.json");
}

export function loadTools(): ToolsContract {
  const c = readJson<ToolsContract>("tools.json");
  // W783: 10 -> 11 (`ask_user_question`).
  if (c.count !== 11 || c.tools.length !== 11) {
    throw new Error(`tools contract must hold 11 tools, got ${c.tools.length}`);
  }
  return c;
}

export function loadSessionEventSchema(): Record<string, unknown> {
  return readJson<Record<string, unknown>>("session-event.schema.json");
}

export interface DataFileEntry {
  file: string;
  schema: string;
  version: string;
  mode: string;
  secret?: boolean;
  /** W787: free-form ownership / path note (optional, purely documentary). */
  note?: string;
}
export interface DataFilesIndex {
  freezeRule: string;
  files: DataFileEntry[];
  durability: Record<string, string>;
  roundTripRequirement: string;
  /**
   * Per-capability implementation notes (iteration E): which part of a design
   * section is implemented and which is explicitly deferred. Optional, because
   * a capability that added no data file has nothing to report here.
   */
  recovery?: { implemented: string; notImplemented: string };
  /** W787 (capability 2): the worker table's own implementation split. */
  workerRegistry?: { implemented: string; notImplemented: string };
}

export function loadDataFilesIndex(): DataFilesIndex {
  return readJson<DataFilesIndex>("data-files", "index.json");
}

export function loadDataFileSchema(name: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>("data-files", name);
}
