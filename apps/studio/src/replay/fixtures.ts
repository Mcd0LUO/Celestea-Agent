/**
 * Golden-fixture access for the P5 double-run comparison.
 *
 * The fixtures are the P0 export of the running Rust implementation
 * (`fixtures/index.json` + `fixtures/sessions/<slug>/…`): an unmodified session
 * log, the Studio `messages` projection captured over HTTP, and (for small
 * sessions) the derived SSE transcript. Nothing here writes into `fixtures/`:
 * every replay works on a COPY under a temp root.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One fixture session entry of the manifest. */
export interface FixtureSession {
  id: string;
  slug: string;
  roles: string[];
  events: number;
  turns: number;
  danglingToolCalls: number;
  subCalls: number;
  expectedMessages: number;
  sseFrames: number;
}

export interface FixtureManifest {
  generatedAt: string;
  studio: string;
  sessions: FixtureSession[];
  counts: Record<string, unknown>;
}

/** The four golden artifacts of one session fixture. */
export interface FixtureFiles {
  dir: string;
  log: string;
  messages: string;
  derivedMessages: string;
  sse: string | null;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Load `fixtures/index.json` (throws with the export hint when missing). */
export function loadManifest(fixturesDir: string): FixtureManifest {
  const path = join(resolve(fixturesDir), "index.json");
  if (!existsSync(path)) throw new Error(`fixtures manifest not found: ${path} (run \`pnpm golden:export\` first)`);
  return readJson<FixtureManifest>(path);
}

/** Absolute paths of one session's golden files. */
export function fixtureFiles(fixturesDir: string, slug: string): FixtureFiles {
  const dir = join(resolve(fixturesDir), "sessions", slug);
  const sse = join(dir, "sse-transcript-derived.jsonl");
  return {
    dir,
    log: join(dir, "cli-main.jsonl"),
    messages: join(dir, "messages-expected.json"),
    derivedMessages: join(dir, "derive-messages-expected.json"),
    sse: existsSync(sse) ? sse : null,
  };
}

/** Split an id into its workspace and session-directory halves. */
export function splitSessionId(id: string): { workspace: string; session: string } {
  const slash = id.indexOf("/");
  return { workspace: id.slice(0, slash), session: id.slice(slash + 1) };
}

/** Copy a session fixture into `<root>/<workspace>/<session>/cli-main.jsonl`. */
export function plantFixture(root: string, files: FixtureFiles, id: string): { dir: string; logBytes: string } {
  const { workspace, session } = splitSessionId(id);
  const dir = join(root, workspace, session);
  mkdirSync(dir, { recursive: true });
  copyFileSync(files.log, join(dir, "cli-main.jsonl"));
  return { dir, logBytes: readFileSync(files.log, "utf8") };
}

/** Parse one JSONL fixture file (one JSON value per non-empty line). */
export function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}
