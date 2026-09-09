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
  method: "GET" | "POST";
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
  if (c.count !== 39 || c.endpoints.length !== 39) {
    throw new Error(`endpoints contract must hold 39 endpoints, got ${c.endpoints.length}`);
  }
  return c;
}

export function loadSse(): SseContract {
  const c = readJson<SseContract>("sse-events.json");
  if (c.count !== 8 || c.events.length !== 8) {
    throw new Error(`SSE contract must hold 8 events, got ${c.events.length}`);
  }
  return c;
}

export function loadRouteSnapshot(): RouteSnapshot {
  return readJson<RouteSnapshot>("rust-route-table.snapshot.json");
}

export function loadTools(): ToolsContract {
  const c = readJson<ToolsContract>("tools.json");
  if (c.count !== 10 || c.tools.length !== 10) {
    throw new Error(`tools contract must hold 10 tools, got ${c.tools.length}`);
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
}
export interface DataFilesIndex {
  freezeRule: string;
  files: DataFileEntry[];
  durability: Record<string, string>;
  roundTripRequirement: string;
}

export function loadDataFilesIndex(): DataFilesIndex {
  return readJson<DataFilesIndex>("data-files", "index.json");
}

export function loadDataFileSchema(name: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>("data-files", name);
}
