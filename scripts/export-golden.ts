#!/usr/bin/env tsx
/**
 * Golden fixture exporter (P0).
 *
 * READ-ONLY against the running Rust implementation:
 *   - session logs are read straight from disk (never written)
 *   - REST snapshots use GET only
 *   - the SSE transcript is a passive connect (no POST /api/turn, because that
 *     would append to a production cli-main.jsonl)
 *
 * Every byte written is passed through the redactor, and the export fails
 * loudly if any registered secret or generic token shape survives.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  analyzeReplay,
  deriveMessages,
  deriveSseTranscript,
  parseSessionJsonl,
  projectMessages,
  type ReplayStats,
} from "@celestea/session";
import { collectKnownSecrets, createRedactor, type Redactor } from "@celestea/core";
import { parseRegistryTsv, REGISTRY_TSV_PATH, summarize } from "@celestea/workers";
import { bool, num, parseArgs, str } from "./lib/args.js";
import { probe } from "./lib/http.js";

const STUDIO = str(parseArgs(process.argv.slice(2)), "studio", "http://127.0.0.1:3777");
const args = parseArgs(process.argv.slice(2));
const OUT = resolve(str(args, "out", "fixtures"));
const SSE_WINDOW_MS = num(args, "sse-window-ms", 6000);
/** Above this event count the derived per-session SSE transcript is omitted (it is regenerable from cli-main.jsonl). */
const MAX_DERIVED_SSE_EVENTS = num(args, "max-derived-sse-events", 200);
const STUDIO_REPO = str(args, "studio-repo", "/src/celestea_studio");
const VERBOSE = bool(args, "verbose");

interface SessionFixtureMeta {
  id: string;
  workspace: string;
  sessionDir: string;
  slug: string;
  roles: string[];
  source: { logPath: string; sizeBytes: number; sha256: string; mtime: string; stable: boolean };
  stats: Omit<ReplayStats, "turnIds"> & { turnIds: { ids: string[]; nonMonotonic: number; duplicates: string[]; malformed: string[] } };
  expectedMessages: number;
  derivedMessages: number;
  sseFrames: number;
  files: Record<string, { bytes: number; sha256: string }>;
}

const written: Array<{ path: string; bytes: number; sha256: string }> = [];

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function slugify(s: string): string {
  // Keep unicode letters (session dirs are often CJK) but drop separators.
  return s.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function writeText(redactor: Redactor, relPath: string, text: string): { bytes: number; sha256: string } {
  const redacted = redactor.redact(text);
  redactor.assertClean(redacted, relPath);
  const abs = join(OUT, relPath);
  ensureDir(dirname(abs));
  writeFileSync(abs, redacted, "utf8");
  const rec = { path: relPath, bytes: Buffer.byteLength(redacted), sha256: sha256(redacted) };
  written.push(rec);
  if (VERBOSE) console.log(`  wrote ${relPath} (${rec.bytes} B)`);
  return { bytes: rec.bytes, sha256: rec.sha256 };
}

function writeJson(redactor: Redactor, relPath: string, value: unknown): { bytes: number; sha256: string } {
  const text = JSON.stringify(value, null, 2) + "\n";
  const rec = writeText(redactor, relPath, text);
  // A redacted JSON file must still be valid JSON.
  JSON.parse(readFileSync(join(OUT, relPath), "utf8"));
  return rec;
}

function loadSecrets(): { secrets: string[]; sources: string[] } {
  const sources: string[] = [];
  let providersJson: unknown = undefined;
  const providersPath = join(STUDIO_REPO, "providers.json");
  if (existsSync(providersPath)) {
    try {
      providersJson = JSON.parse(readFileSync(providersPath, "utf8")) as unknown;
      sources.push(`${providersPath} (read-only)`);
    } catch {
      /* a malformed providers.json must never break the export */
    }
  }
  let npmrc: string | undefined;
  const npmrcPath = join(homedir(), ".npmrc");
  if (existsSync(npmrcPath)) {
    npmrc = readFileSync(npmrcPath, "utf8");
    sources.push(`${npmrcPath} (_authToken)`);
  }
  const secrets = collectKnownSecrets({ providersJson, npmrc, env: process.env });
  if (process.env["CELESTEA_API_KEY"]) sources.push("env CELESTEA_API_KEY");
  return { secrets, sources };
}

function classify(stats: ReplayStats, outcomes: Record<string, number>): string[] {
  const roles: string[] = ["session-log"];
  if (stats.danglingToolCalls.length > 0) roles.push("dangling-tool-call");
  if (stats.subCalls > 0) roles.push("run_code-parent-id");
  if (stats.tornTail !== null) roles.push("torn-tail");
  if (stats.turnStarts >= 2 && stats.danglingTurns === 0 && stats.danglingToolCalls.length === 0) roles.push("normal-multi-turn");
  for (const o of ["cancelled", "error", "step_limit", "interrupted"]) {
    if ((outcomes[o] ?? 0) > 0) roles.push(`${o}-outcome`);
  }
  return roles;
}

async function main(): Promise<void> {
  console.log(`[export-golden] studio=${STUDIO} out=${OUT}`);
  ensureDir(OUT);

  const { secrets, sources } = loadSecrets();
  const redactor = createRedactor(secrets);
  console.log(`[export-golden] registered ${secrets.length} secret(s) from ${sources.length} source(s)`);

  // ---- 1. live read-only snapshots -----------------------------------------
  const health = await probe(STUDIO, "/api/health");
  const status = await probe(STUDIO, "/api/status");
  const tools = await probe(STUDIO, "/api/tools");
  const config = await probe(STUDIO, "/api/config");
  const sessions = await probe(STUDIO, "/api/sessions");
  const workspaces = await probe(STUDIO, "/api/workspaces");
  const providers = await probe(STUDIO, "/api/providers");
  const prompts = await probe(STUDIO, "/api/prompts");
  const workers = await probe(STUDIO, "/api/worker/status");
  const fsBrowse = await probe(STUDIO, "/api/fs/browse");
  if (!health.ok || !sessions.ok || !workspaces.ok) {
    throw new Error(`studio not reachable at ${STUDIO} (health=${health.status} sessions=${sessions.status} workspaces=${workspaces.status})`);
  }

  const workspaceList = (workspaces.json as { workspaces: Array<{ name: string; path: string }> }).workspaces;
  const pathByName = new Map(workspaceList.map((w) => [w.name, w.path]));
  const sessionList = (sessions.json as { sessions: Array<{ id: string; workspace: string; kind?: string }> }).sessions;

  // ---- 2. session fixtures -------------------------------------------------
  const metas: SessionFixtureMeta[] = [];
  for (const s of sessionList) {
    if (s.kind === "worker") continue;
    const slash = s.id.indexOf("/");
    if (slash <= 0) continue;
    const ws = s.id.slice(0, slash);
    const dir = s.id.slice(slash + 1);
    const wsPath = pathByName.get(ws);
    if (wsPath === undefined) {
      console.warn(`[export-golden] skip ${s.id}: workspace '${ws}' not in registry`);
      continue;
    }
    const logPath = join(wsPath, dir, "cli-main.jsonl");
    if (!existsSync(logPath)) continue;

    const rawA = readFileSync(logPath);
    const parsed = parseSessionJsonl(rawA.toString("utf8"));
    const stats = analyzeReplay(parsed);
    const rawB = readFileSync(logPath);
    const stable = rawA.equals(rawB);
    const slug = slugify(dir);
    const roles = classify(stats, stats.outcomes);

    const messagesRes = await probe(STUDIO, `/api/sessions/${encodeURIComponent(s.id)}/messages`);
    if (messagesRes.status !== 200) {
      console.warn(`[export-golden] skip ${s.id}: messages status ${messagesRes.status}`);
      continue;
    }
    const liveMessages = messagesRes.json as { session: string; messages: unknown[] };

    const base = `sessions/${slug}`;
    const files: Record<string, { bytes: number; sha256: string }> = {};
    files["cli-main.jsonl"] = writeText(redactor, `${base}/cli-main.jsonl`, rawA.toString("utf8"));
    files["messages-expected.json"] = writeJson(redactor, `${base}/messages-expected.json`, {
      source: { endpoint: `GET /api/sessions/${s.id}/messages`, session: s.id, fetchedFrom: STUDIO },
      messages: liveMessages.messages,
    });
    files["derive-messages-expected.json"] = writeJson(redactor, `${base}/derive-messages-expected.json`, {
      note: "DERIVED by the TS reference implementation (engine derive_messages has no HTTP surface; P1 validates it against the Rust unit tests)",
      messages: deriveMessages(parsed.events),
    });
    const derivedFrames = deriveSseTranscript(parsed.events);
    if (parsed.events.length <= MAX_DERIVED_SSE_EVENTS) {
      files["sse-transcript-derived.jsonl"] = writeText(
        redactor,
        `${base}/sse-transcript-derived.jsonl`,
        derivedFrames.map((f) => JSON.stringify(f)).join("\n") + "\n",
      );
    }
    const meta: SessionFixtureMeta = {
      id: s.id,
      workspace: ws,
      sessionDir: dir,
      slug,
      roles,
      source: {
        logPath,
        sizeBytes: rawA.byteLength,
        sha256: sha256(rawA),
        mtime: statSync(logPath).mtime.toISOString(),
        stable,
      },
      stats: {
        ...stats,
        turnIds: {
          ids: stats.turnIds.ids,
          nonMonotonic: stats.turnIds.nonMonotonic.length,
          duplicates: stats.turnIds.duplicates,
          malformed: stats.turnIds.malformed,
        },
      },
      expectedMessages: liveMessages.messages.length,
      derivedMessages: deriveMessages(parsed.events).length,
      sseFrames: derivedFrames.length,
      files,
    };
    files["meta.json"] = writeJson(redactor, `${base}/meta.json`, meta);
    metas.push(meta);
    console.log(`[export-golden] ${s.id}: ${stats.parsedEvents} events, roles=[${roles.join(", ")}]`);
  }

  const rolesSeen = new Set(metas.flatMap((m) => m.roles));
  for (const required of ["dangling-tool-call", "run_code-parent-id", "normal-multi-turn"]) {
    if (!rolesSeen.has(required)) {
      throw new Error(`golden coverage gap: no session fixture with role '${required}' (found: ${[...rolesSeen].join(", ")})`);
    }
  }

  // ---- 3. SSE live capture (passive) --------------------------------------
  const sseCapture = await captureSse(STUDIO, SSE_WINDOW_MS);
  const sseFiles: Record<string, { bytes: number; sha256: string }> = {};
  sseFiles["raw.txt"] = writeText(redactor, "sse/live-capture.raw.txt", sseCapture.raw);
  sseFiles["meta.json"] = writeJson(redactor, "sse/live-capture.json", {
    source: { endpoint: `GET ${STUDIO}/api/events`, mode: "read-only passive connect" },
    windowMs: SSE_WINDOW_MS,
    headers: sseCapture.headers,
    framesObserved: sseCapture.frames,
    keepalives: sseCapture.keepalives,
    note:
      sseCapture.frames === 0
        ? "No turn was running and P0 forbids POST /api/turn (it appends to the production cli-main.jsonl). The event NAMES are frozen in contracts/sse-events.json from the Rust source; per-session transcripts are derived from the session log (fixtures/sessions/*/sse-transcript-derived.jsonl)."
        : "Captured live SSE frames while a turn was running.",
  });

  // ---- 4. registry.tsv ----------------------------------------------------
  const registryFiles: Record<string, { bytes: number; sha256: string }> = {};
  if (existsSync(REGISTRY_TSV_PATH)) {
    const raw = readFileSync(REGISTRY_TSV_PATH, "utf8");
    const parsedRegistry = parseRegistryTsv(raw);
    registryFiles["registry.tsv"] = writeText(redactor, "workers/registry.tsv", raw);
    registryFiles["registry-parsed.json"] = writeJson(redactor, "workers/registry-parsed.json", {
      source: REGISTRY_TSV_PATH,
      lines: parsedRegistry.lines,
      entries: parsedRegistry.entries,
      skipped: parsedRegistry.skipped,
      summary: summarize(parsedRegistry.entries),
    });
    console.log(`[export-golden] registry.tsv: ${parsedRegistry.entries.length} rows, ${parsedRegistry.skipped.length} skipped`);
  } else {
    console.warn(`[export-golden] ${REGISTRY_TSV_PATH} not found; skipping worker registry fixture`);
  }

  // ---- 5. public views ----------------------------------------------------
  const viewFiles: Record<string, { bytes: number; sha256: string }> = {};
  const providersText = providers.text;
  if (providersText.includes('"api_key"')) {
    throw new Error("refusing to export: /api/providers response contains the string \"api_key\"");
  }
  viewFiles["providers/public-view.json"] = writeJson(redactor, "providers/public-view.json", {
    source: { endpoint: `GET ${STUDIO}/api/providers`, note: "api_key is ABSENT from public_view (contract)" },
    body: providers.json,
  });
  viewFiles["workspaces/registry-view.json"] = writeJson(redactor, "workspaces/registry-view.json", {
    source: { endpoint: `GET ${STUDIO}/api/workspaces` },
    body: workspaces.json,
  });
  const wsFile = join(STUDIO_REPO, "workspaces.json");
  if (existsSync(wsFile)) {
    viewFiles["workspaces/workspaces-file.json"] = writeJson(redactor, "workspaces/workspaces-file.json", {
      source: { path: wsFile, note: "raw data file (read-only); no secrets by schema" },
      body: JSON.parse(readFileSync(wsFile, "utf8")) as unknown,
    });
  }
  const liveFiles: Record<string, { bytes: number; sha256: string }> = {};
  liveFiles["live/health.json"] = writeJson(redactor, "live/health.json", { endpoint: `GET ${STUDIO}/api/health`, status: health.status, body: health.json });
  liveFiles["live/status.json"] = writeJson(redactor, "live/status.json", { endpoint: `GET ${STUDIO}/api/status`, status: status.status, body: status.json });
  liveFiles["live/tools.json"] = writeJson(redactor, "live/tools.json", { endpoint: `GET ${STUDIO}/api/tools`, status: tools.status, body: tools.json });
  liveFiles["live/config.json"] = writeJson(redactor, "live/config.json", { endpoint: `GET ${STUDIO}/api/config`, status: config.status, body: config.json });
  liveFiles["live/sessions.json"] = writeJson(redactor, "live/sessions.json", { endpoint: `GET ${STUDIO}/api/sessions`, status: sessions.status, body: sessions.json });
  liveFiles["live/workspaces.json"] = writeJson(redactor, "live/workspaces.json", { endpoint: `GET ${STUDIO}/api/workspaces`, status: workspaces.status, body: workspaces.json });
  liveFiles["live/providers.json"] = writeJson(redactor, "live/providers.json", { endpoint: `GET ${STUDIO}/api/providers`, status: providers.status, body: providers.json });
  liveFiles["live/prompts.json"] = writeJson(redactor, "live/prompts.json", { endpoint: `GET ${STUDIO}/api/prompts`, status: prompts.status, body: prompts.json });
  liveFiles["live/worker-status.json"] = writeJson(redactor, "live/worker-status.json", { endpoint: `GET ${STUDIO}/api/worker/status`, status: workers.status, body: workers.json });
  liveFiles["live/fs-browse.json"] = writeJson(redactor, "live/fs-browse.json", { endpoint: `GET ${STUDIO}/api/fs/browse`, status: fsBrowse.status, body: fsBrowse.json });

  // ---- 6. manifest + leak verification ------------------------------------
  const report = redactor.report();
  const manifest = {
    generatedAt: new Date().toISOString(),
    studio: STUDIO,
    studioRepo: STUDIO_REPO,
    mode: "read-only (GET + passive SSE + direct file reads)",
    redaction: {
      secretsRegistered: report.secretsRegistered,
      secretsDiscovered: report.secretsDiscovered ?? 0,
      sources,
      replacements: report.replacements,
      byRule: report.byRule,
      policy: "registered provider keys + generic token shapes (sk-*, npm_*, ghp_*, Bearer, Authorization/api_key JSON values, *_API_KEY=..., AKIA*); every written file is re-scanned and the export aborts on a leak",
    },
    sessions: metas.map((m) => ({
      id: m.id,
      slug: m.slug,
      roles: m.roles,
      events: m.stats.parsedEvents,
      turns: m.stats.turnStarts,
      danglingToolCalls: m.stats.danglingToolCalls.length,
      subCalls: m.stats.subCalls,
      expectedMessages: m.expectedMessages,
      sseFrames: m.sseFrames,
    })),
    counts: {
      sessions: metas.length,
      sseLiveFrames: sseCapture.frames,
      registryRows: registryFiles["registry.tsv"] === undefined ? 0 : (JSON.parse(readFileSync(join(OUT, "workers/registry-parsed.json"), "utf8")) as { entries: unknown[] }).entries.length,
      files: written.length,
    },
    files: written.map((w) => ({ path: w.path, bytes: w.bytes, sha256: w.sha256 })),
  };
  writeJson(redactor, "index.json", manifest);

  // Final independent scan of every file on disk.
  const leaks: string[] = [];
  const discovered = redactor.dynamicSecrets();
  for (const w of written) {
    const text = readFileSync(join(OUT, w.path), "utf8");
    try {
      redactor.assertClean(text, w.path);
    } catch (e) {
      leaks.push(`${w.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const secret of discovered) {
      if (text.includes(secret)) leaks.push(`${w.path}: discovered credential survives`);
    }
  }
  if (leaks.length > 0) throw new Error(`SECRET LEAK:\n${leaks.join("\n")}`);

  // Independent, pattern-based audit (does not rely on the redactor itself).
  const SUSPICIOUS: Array<{ id: string; re: RegExp }> = [
    { id: "sk-token", re: /sk-[A-Za-z0-9_-]{12,}/ },
    { id: "npm-token", re: /npm_[A-Za-z0-9]{20,}/ },
    { id: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
    { id: "auth-token", re: /_authToken\s*=\s*[A-Za-z0-9_-]{16,}/ },
    { id: "bearer-token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
    { id: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
    { id: "cookie-value", re: /(?:set-)?cookie\s*:\s*(?!<REDACTED>)[^\r\n"'\\]{8,}/i },
    { id: "token-assignment", re: /\b[A-Za-z0-9_]*token\s*[=:]\s*[A-Za-z0-9_\-.]{12,}/i },
    { id: "service-auth-token", re: /-auth-[A-Za-z0-9_-]{12,}/ },
  ];
  const audit: Array<{ file: string; pattern: string }> = [];
  for (const w of written) {
    const text = readFileSync(join(OUT, w.path), "utf8").split("<REDACTED>").join(" ");
    for (const pat of SUSPICIOUS) if (pat.re.test(text)) audit.push({ file: w.path, pattern: pat.id });
  }
  if (audit.length > 0) {
    throw new Error(`SECRET AUDIT FAILED:\n${audit.map((a) => `  ${a.file}: ${a.pattern}`).join("\n")}`);
  }
  writeJson(redactor, "redaction-audit.json", {
    generatedAt: new Date().toISOString(),
    policy: "registered secrets + generic token shapes; every written file re-scanned",
    secretsRegistered: report.secretsRegistered,
    secretsDiscovered: report.secretsDiscovered ?? 0,
    replacements: report.replacements,
    byRule: report.byRule,
    suspiciousPatterns: SUSPICIOUS.map((p) => p.id),
    findings: audit,
    verdict: audit.length === 0 ? "clean" : "LEAK",
  });

  console.log(
    `[export-golden] OK: ${metas.length} sessions, ${written.length} files, ${report.replacements} redaction(s), 0 leaks`,
  );
  console.log(`[export-golden] roles covered: ${[...rolesSeen].sort().join(", ")}`);
}

async function captureSse(base: string, windowMs: number): Promise<{ raw: string; headers: Record<string, string>; frames: number; keepalives: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), windowMs);
  const chunks: string[] = [];
  let frames = 0;
  let keepalives = 0;
  let headers: Record<string, string> = {};
  try {
    const res = await fetch(base.replace(/\/$/, "") + "/api/events", { headers: { accept: "text/event-stream" }, signal: ac.signal });
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        chunks.push(text);
        for (const block of text.split("\n\n")) {
          if (block.trim() === "") continue;
          if (block.includes("event: keepalive") || block.trim() === "data:") keepalives += 1;
          else frames += 1;
        }
      }
    }
  } catch {
    /* abort = window elapsed, expected */
  } finally {
    clearTimeout(timer);
  }
  return { raw: chunks.join(""), headers, frames, keepalives };
}

main().catch((e: unknown) => {
  console.error(`[export-golden] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
