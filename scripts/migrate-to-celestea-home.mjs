#!/usr/bin/env node
/**
 * W880 migration — move every celestea artifact out of the workspaces and into
 * `$CELESTEA_HOME/workspaces/<ws>/` (see packages/core/src/celestea-home.ts).
 *
 *   <ws>/<session-dir>                -> <home>/workspaces/<ws>/sessions/<dir>
 *   <ws>/.celestea/sessions/<dir>     -> <home>/workspaces/<ws>/sessions/<dir>   (W877 interim)
 *   <ws>/.celestea-archived/<dir>     -> <home>/workspaces/<ws>/archive/<dir>
 *   <ws>/.celestea-trash/<dir>        -> <home>/workspaces/<ws>/trash/<dir>
 *   <ws>/.celestea-prompts.json       -> <home>/workspaces/<ws>/prompts.json
 *
 * Contract:
 *   - DRY RUN by default; pass --apply to move anything.
 *   - IDEMPOTENT: a target that already exists is reported and skipped, never
 *     overwritten (a second run is a no-op).
 *   - ATOMIC when possible (rename); falls back to copy-then-delete across
 *     filesystems (EXDEV), and only deletes the source AFTER a successful copy.
 *   - Never deletes a non-empty directory it did not fully migrate.
 *   - Session ids do NOT change (they are <ws>/<dir>), so workspaces.json's
 *     active_session needs no rewrite.
 *
 * STOP THE SERVICE FIRST (--apply): a live instance holds the session directory
 * and would keep writing to the old path.
 *
 *   sudo systemctl stop celestea-studio-ts
 *   node scripts/migrate-to-celestea-home.mjs            # dry run
 *   node scripts/migrate-to-celestea-home.mjs --apply
 *   sudo systemctl start celestea-studio-ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const HOME = flag("--home", process.env.CELESTEA_HOME ?? "");
const WS_FILE = flag("--workspaces-file", process.env.CELESTEA_WORKSPACES_FILE ?? join(HOME, "workspaces.json"));
if (HOME === "") {
  console.error("migrate: CELESTEA_HOME is not set (pass --home or export CELESTEA_HOME)");
  process.exit(2);
}

function workspacePaths() {
  const raw = JSON.parse(readFileSync(WS_FILE, "utf8"));
  const rows = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  return rows.map((r) => r && typeof r.path === "string" ? r.path : null).filter((p) => p !== null);
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const entries = (p) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const looksLikeSession = (dir) => isFile(join(dir, "cli-main.jsonl")) || isFile(join(dir, "session.json"));

/** rename, falling back to copy+delete across filesystems. */
function moveDir(from, to) {
  mkdirSync(join(to, ".."), { recursive: true });
  try {
    renameSync(from, to);
    return "renamed";
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
    return "copied";
  }
}

const report = [];
function migrate(label, from, to, kind) {
  const exists = kind === "dir" ? isDir(from) : isFile(from);
  if (!exists) return;
  if (kind === "dir" ? existsSync(to) : existsSync(to)) {
    report.push({ label, action: "skipped (target exists)", from, to });
    return;
  }
  if (!APPLY) {
    report.push({ label, action: "WOULD MOVE", from, to });
    return;
  }
  try {
    if (kind === "dir") moveDir(from, to);
    else { mkdirSync(join(to, ".."), { recursive: true }); renameSync(from, to); }
    report.push({ label, action: "moved", from, to });
  } catch (e) {
    report.push({ label, action: "FAILED: " + e.message, from, to });
  }
}

for (const ws of workspacePaths()) {
  const name = basename(ws);
  const base = join(HOME, "workspaces", name);

  // 1) live sessions directly under the workspace root
  for (const e of entries(ws)) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const from = join(ws, e.name);
    if (!looksLikeSession(from)) continue;
    migrate(`session ${name}/${e.name}`, from, join(base, "sessions", e.name), "dir");
  }
  // 2) W877 interim layout
  const interim = join(ws, ".celestea", "sessions");
  for (const e of entries(interim)) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    migrate(`session(interim) ${name}/${e.name}`, join(interim, e.name), join(base, "sessions", e.name), "dir");
  }
  // 3) archive / trash
  for (const e of entries(join(ws, ".celestea-archived"))) {
    if (!e.isDirectory()) continue;
    migrate(`archive ${name}/${e.name}`, join(ws, ".celestea-archived", e.name), join(base, "archive", e.name), "dir");
  }
  for (const e of entries(join(ws, ".celestea-trash"))) {
    if (!e.isDirectory()) continue;
    migrate(`trash ${name}/${e.name}`, join(ws, ".celestea-trash", e.name), join(base, "trash", e.name), "dir");
  }
  // 4) prompts registry
  migrate(`prompts ${name}`, join(ws, ".celestea-prompts.json"), join(base, "prompts.json"), "file");
}

const moved = report.filter((r) => r.action === "moved").length;
const would = report.filter((r) => r.action === "WOULD MOVE").length;
const skipped = report.filter((r) => r.action.startsWith("skipped")).length;
const failed = report.filter((r) => r.action.startsWith("FAILED")).length;

for (const r of report) console.log(`  [${r.action}] ${r.label}`);
console.log(`\nmigrate-to-celestea-home: ${APPLY ? "APPLIED" : "DRY RUN"} — moved=${moved} would-move=${would} skipped=${skipped} failed=${failed}`);
console.log(`home=${HOME}`);
if (!APPLY) console.log("re-run with --apply to perform the moves (stop the service first)");
process.exit(failed > 0 ? 1 : 0);
