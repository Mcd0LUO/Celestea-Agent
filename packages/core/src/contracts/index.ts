/**
 * Machine-readable contract loader (P0; hardened in W807).
 *
 * Everything under contracts/ is frozen data; this module only reads and
 * validates it. Counts are asserted here so a drifted contract fails loudly.
 *
 * W807 -- READ ONCE, THEN TRUST THE SNAPSHOT. The loader used to re-read every
 * JSON file on every call while comparing it against counts baked in at module
 * load time. A running process was therefore a contradiction waiting to happen:
 * 2026-09-16 W804 bumped contracts/tools.json from 11 to 12 while production had
 * 11 in memory, so every compose 500'd ("tools contract must hold 11 tools, got
 * 12") until an operator restarted. A store now validates a contract file ONCE
 * and caches it for the process lifetime, so a later disk edit cannot make a
 * running process contradict itself. verifyContractsAtStartup() is the explicit
 * boot gate: it refuses to start on a mismatch (naming file, expected and
 * actual) instead of booting into a later 500.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contractsDir } from "../repo.js";
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
  method: "GET" | "POST" | "DELETE" | "PUT";
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
   * W516: routes that exist ONLY in the TypeScript backend (no legacy
   * counterpart). The legacy extraction above stays intact; a contract endpoint
   * must appear in routes or here.
   */
  tsOnlyRoutes?: RouteSnapshotEntry[];
  tsApiEndpoints?: number;
  tsMethodPathCombos?: number;
}

export interface ToolsContract {
  count: number;
  tools: Array<ToolSpec & { sourceRef: string }>;
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
  /** W804 (multimodal P0): the per-session attachment object store. */
  attachments?: { location: string; kind: string; introduced: string; lifecycle: string; fixtures: string; schema: string };
}

/**
 * The frozen counts. These are the module-load-time constants a drifted
 * contracts file used to contradict (W804). They are deliberately NOT derived
 * from the files, and must never be edited to paper over a contract edit -- the
 * file change is what gets reviewed and the counts only follow a deliberate
 * freeze revision.
 */
export const FROZEN_COUNTS = {
  // W860: 57 -> 60 (GET|PUT /api/sessions/{id}/tools + GET /api/plugins).
  // W870: 60 -> 61 (PUT /api/sessions/{id}/model, the session-scoped model switch).
  endpoints: 61,
  sseEvents: 9,
  tools: 13,
} as const;

/** One frozen-count divergence, with everything an operator needs to act. */
export interface ContractMismatch {
  /** File name relative to the contracts directory (e.g. tools.json). */
  file: string;
  /** Absolute path of the file, so the operator can open it directly. */
  path: string;
  /** Which number diverged: the declared count field, or the array length. */
  field: string;
  expected: number;
  actual: number;
}

/** Raised when a contract file contradicts a frozen count. */
export class ContractValidationError extends Error {
  readonly mismatches: ContractMismatch[];
  readonly dir: string;

  constructor(dir: string, mismatches: ContractMismatch[]) {
    const detail = mismatches
      .map((m) => m.file + " (" + m.field + "): expected " + m.expected + ", got " + m.actual + " [" + m.path + "]")
      .join("; ");
    super("frozen contract violated in " + dir + " -- refusing to start: " + detail);
    this.name = "ContractValidationError";
    this.dir = dir;
    this.mismatches = mismatches;
  }
}

interface FrozenCheck {
  file: string;
  field: string;
  expected: number;
  measure: (doc: unknown) => number;
}

/** Every frozen file is checked twice: its declared count and its array length. */
const FROZEN_CHECKS: readonly FrozenCheck[] = [
  { file: "endpoints.json", field: "count", expected: FROZEN_COUNTS.endpoints, measure: (d) => (d as EndpointsContract).count },
  { file: "endpoints.json", field: "endpoints[]", expected: FROZEN_COUNTS.endpoints, measure: (d) => (d as EndpointsContract).endpoints.length },
  { file: "sse-events.json", field: "count", expected: FROZEN_COUNTS.sseEvents, measure: (d) => (d as SseContract).count },
  { file: "sse-events.json", field: "events[]", expected: FROZEN_COUNTS.sseEvents, measure: (d) => (d as SseContract).events.length },
  { file: "tools.json", field: "count", expected: FROZEN_COUNTS.tools, measure: (d) => (d as ToolsContract).count },
  { file: "tools.json", field: "tools[]", expected: FROZEN_COUNTS.tools, measure: (d) => (d as ToolsContract).tools.length },
];

const FROZEN_FILES: readonly string[] = [...new Set(FROZEN_CHECKS.map((c) => c.file))];

function checkFrozen(file: string, doc: unknown, dir: string): ContractMismatch[] {
  return FROZEN_CHECKS.filter((c) => c.file === file)
    .map((c) => ({ file, path: resolve(dir, file), field: c.field, expected: c.expected, actual: c.measure(doc) }))
    .filter((m) => m.actual !== m.expected);
}

/**
 * A contract store bound to one directory. Every value is read from disk at
 * most once: the first (validated) read wins and is reused for the rest of the
 * process lifetime. Tests point a store at a throwaway copy; the process-wide
 * contractStore() points at the real repository.
 */
export interface ContractStore {
  readonly dir: string;
  loadEndpoints(): EndpointsContract;
  loadSse(): SseContract;
  loadRouteSnapshot(): RouteSnapshot;
  loadTools(): ToolsContract;
  loadSessionEventSchema(): Record<string, unknown>;
  loadDataFilesIndex(): DataFilesIndex;
  loadDataFileSchema(name: string): Record<string, unknown>;
  /** Validate the frozen files from disk NOW and prime the cache. Throws on drift. */
  verifyAtStartup(): void;
}

export function createContractStore(dir: string): ContractStore {
  const cache = new Map<string, unknown>();

  function readJson<T>(...parts: string[]): T {
    return JSON.parse(readFileSync(resolve(dir, ...parts), "utf8")) as T;
  }

  function cached<T>(key: string, load: () => T): T {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    const value = load();
    cache.set(key, value);
    return value;
  }

  function loadChecked<T>(file: string): T {
    return cached(file, () => {
      const value = readJson<T>(file);
      const mismatches = checkFrozen(file, value, dir);
      if (mismatches.length > 0) throw new ContractValidationError(dir, mismatches);
      return value;
    });
  }

  function verifyAtStartup(): void {
    const mismatches: ContractMismatch[] = [];
    const snapshot = new Map<string, unknown>();
    for (const file of FROZEN_FILES) {
      const value = readJson<unknown>(file);
      mismatches.push(...checkFrozen(file, value, dir));
      snapshot.set(file, value);
    }
    if (mismatches.length > 0) throw new ContractValidationError(dir, mismatches);
    for (const [file, value] of snapshot) cache.set(file, value);
  }

  return {
    dir,
    loadEndpoints: () => loadChecked<EndpointsContract>("endpoints.json"),
    loadSse: () => loadChecked<SseContract>("sse-events.json"),
    loadTools: () => loadChecked<ToolsContract>("tools.json"),
    loadRouteSnapshot: () => cached("route-table.snapshot.json", () => readJson<RouteSnapshot>("route-table.snapshot.json")),
    loadSessionEventSchema: () => cached("session-event.schema.json", () => readJson<Record<string, unknown>>("session-event.schema.json")),
    loadDataFilesIndex: () => cached("data-files/index.json", () => readJson<DataFilesIndex>("data-files", "index.json")),
    loadDataFileSchema: (name: string) => cached("data-files/" + name, () => readJson<Record<string, unknown>>("data-files", name)),
    verifyAtStartup,
  };
}

let singleton: ContractStore | null = null;

/** The process-wide store: one validated snapshot, reused for the process lifetime. */
export function contractStore(): ContractStore {
  if (singleton === null) singleton = createContractStore(contractsDir());
  return singleton;
}

export function loadEndpoints(): EndpointsContract {
  return contractStore().loadEndpoints();
}

export function loadSse(): SseContract {
  return contractStore().loadSse();
}

export function loadRouteSnapshot(): RouteSnapshot {
  return contractStore().loadRouteSnapshot();
}

export function loadTools(): ToolsContract {
  return contractStore().loadTools();
}

export function loadSessionEventSchema(): Record<string, unknown> {
  return contractStore().loadSessionEventSchema();
}

export function loadDataFilesIndex(): DataFilesIndex {
  return contractStore().loadDataFilesIndex();
}

export function loadDataFileSchema(name: string): Record<string, unknown> {
  return contractStore().loadDataFileSchema(name);
}

/**
 * The explicit startup gate (W807): Studio calls this once at boot, before it
 * binds a port. It reads the frozen contract files from disk, throws a
 * ContractValidationError naming file / expected / actual on any drift, and on
 * success primes the cache with the exact snapshot that was validated -- so the
 * running process stays internally consistent for its whole lifetime even if
 * contracts/*.json changes underneath it.
 *
 * A drifted file is a REFUSAL TO START, not a warning: the previous behaviour
 * was to boot and then 500 on the first request that touched the contract.
 */
export function verifyContractsAtStartup(): void {
  contractStore().verifyAtStartup();
}
