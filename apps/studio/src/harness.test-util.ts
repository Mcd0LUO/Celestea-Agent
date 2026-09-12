/**
 * Shared test harness for the Studio HTTP layer.
 *
 * Every test gets a THROWAWAY data directory (workspaces/providers/prompts +
 * one registered workspace holding one session) and a throwaway static root, so
 * no test can read or write a production data file, and the fake runtime adapter
 * keeps the engine seam deterministic.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalScopeHash } from "./store/grants.js";
import type { Hono } from "hono";
import { createStudioApp, type StudioApp, type StudioAppOptions } from "./app.js";
import { createFakeRuntimeAdapter, type FakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { loadStudioConfig, type StudioPaths } from "./config.js";
import type { EngineFactory } from "./plugins.js";
import type { InjectOutcome, RuntimeAdapter } from "./runtime-adapter.js";

/**
 * A fake adapter that always reports ITS BUSY SLOT as taken: every session is
 * busy, so the process-wide guards (config / prompts / providers) 409 while
 * `/api/turn` takes the interjection path and activate reports `busy:true`.
 * A `Proxy` is used because spreading a class instance would drop its methods.
 */
export function busyRuntime(base: FakeRuntimeAdapter = createFakeRuntimeAdapter()): FakeRuntimeAdapter {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "isBusy") return (): boolean => true;
      if (prop === "ensureSession") return (): { runtime: "created"; busy: boolean; rebuilt: boolean } => ({ runtime: "created", busy: true, rebuilt: false });
      if (prop === "inject") return (): InjectOutcome => ({ turn: 0, injected: true, pending: 1, placement: "steering", duplicate: false });
      if (prop === "busySessions") return (): string[] => target.liveSessions();
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as FakeRuntimeAdapter;
}

export const FIXED_NOW = 1_700_000_000_000;
export const FIXED_TS = "1700000000.0";

export interface StudioHarness {
  app: Hono;
  studio: StudioApp;
  runtime: RuntimeAdapter;
  /** Throwaway root of all data files + the static build. */
  root: string;
  /** Registered workspace folder (empty by default). */
  workspace: string;
  staticRoot: string;
  cleanup(): void;
}

export interface HarnessOptions extends Omit<StudioAppOptions, "runtime"> {
  /** Tests inject a concrete adapter (the fake by default). */
  runtime?: RuntimeAdapter;
  /**
   * Real-engine path: a factory over the composed stores (the adapter it builds
   * is `studio.services.runtime`, which is what [StudioHarness.runtime] exposes).
   */
  engineFactory?: EngineFactory;
  /** Files planted before the app composes (e.g. a providers.json secret). */
  files?: Record<string, unknown>;
  /**
   * Path overrides merged over the throwaway root (W767: the auth password file
   * and secret file, which must point at a test-controlled location).
   */
  paths?: Partial<StudioPaths>;
  /** Create a session dir in the workspace holding `log` lines. */
  session?: { name: string; log?: string; meta?: Record<string, string> };
}

function plantFiles(root: string, files: Record<string, unknown>): void {
  for (const [rel, value] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, typeof value === "string" ? {} : { mode: 0o644 });
  }
}

function plantSession(workspace: string, session: HarnessOptions["session"]): void {
  if (session === undefined) return;
  const dir = join(workspace, session.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), session.log ?? "");
  if (session.meta !== undefined) writeFileSync(join(dir, "session.json"), JSON.stringify(session.meta));
}

export function makeHarness(opts: HarnessOptions = {}): StudioHarness {
  const root = mkdtempSync(join(tmpdir(), "studio-"));
  const workspace = join(root, "sample-ws");
  const staticRoot = join(root, "dist");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>studio</title>\n");
  writeFileSync(join(staticRoot, "assets", "app.js"), "export const x = 1;\n");
  writeFileSync(join(staticRoot, "secret.txt"), "TOP-SECRET-STATIC\n");
  writeFileSync(join(root, "workspaces.json"), JSON.stringify({ workspaces: [{ path: workspace }], active_session: null }, null, 2));
  plantFiles(root, opts.files ?? {});
  plantSession(workspace, opts.session);
  const config = loadStudioConfig({
    cwd: root,
    env: {},
    paths: { staticRoot, ...(opts.paths ?? {}), ...(opts.config?.paths ?? {}) },
  });
  const runtime = opts.runtime ?? createFakeRuntimeAdapter({ profile: { model: "test-model" } });
  const studio = createStudioApp({
    config,
    runtime: opts.engineFactory ?? runtime,
    now: () => FIXED_NOW,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  return {
    app: studio.app,
    studio,
    runtime: studio.services.runtime,
    root,
    workspace,
    staticRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function jsonRequest(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * W516 grant helpers: a grant needs a one-shot token from the same-origin
 * token endpoint, so every test drives the same two-step handshake the UI does.
 */
export async function grantToken(h: StudioHarness, id: string, cap: string, scope: Record<string, unknown>): Promise<string> {
  const hash = canonicalScopeHash(cap, scope as never);
  const res = await getJson(h.app, `/api/sessions/${id}/grants/confirm-token?cap=${cap}&scope_hash=${hash}`, {
    headers: { "sec-fetch-site": "same-origin" },
  });
  // An unsupported cap has no token to issue; the POST's own 400 still wins
  // because the body is validated before the token is looked at.
  return res.status === 200 ? String(res.body["token"]) : "";
}

/** POST a grant (token minted automatically unless one is passed / `null`). */
export async function grant(
  h: StudioHarness,
  id: string,
  body: Record<string, unknown>,
  token?: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const scope = (body["scope"] ?? {}) as Record<string, unknown>;
  const used = token === null ? null : (token ?? (await grantToken(h, id, String(body["cap"]), scope)));
  if (used !== null) headers["x-celestea-grant-confirm"] = used;
  return getJson(h.app, `/api/sessions/${id}/grants`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** The local (authoritative) grants audit channel of a harness data dir. */
export function auditLines(h: StudioHarness): Array<Record<string, unknown>> {
  const path = join(h.root, "grants-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function getJson(app: Hono, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}
