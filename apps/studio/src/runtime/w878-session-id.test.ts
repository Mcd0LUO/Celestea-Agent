/**
 * W878 acceptance: the session id is an explicit INPUT, never re-derived from
 * the directory path.
 *
 * sessionIdOfDir() assumes the session directory is a direct child of the
 * workspace root. Once a session sinks to <ws>/.celestea/sessions/<dir>, it
 * answers "sessions/<dir>" instead of "<ws>/<dir>" - and every self-describing
 * sidecar (grants.json / permission.json / tools.json / checkpoint.json) is
 * silently VOIDED when its session field does not match. These tests plant the
 * four sidecars in BOTH layouts with the correct <ws>/<dir> id and assert all
 * four are honored; the legacy layout proves no regression.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serializeEventLog } from "@celestea/runtime";
import type { GrantRecord } from "../store/grants.js";
import { recoverActiveSessionOnBoot } from "./boot-recovery.js";
import { effectiveGrantsOf } from "./engine-grants.js";
import { effectivePermissionOf } from "./engine-permissions.js";
import { bindingFor, closeLog } from "./engine-session.js";
import { createSessionGrants } from "./session-grants.js";

const HOME = process.env["HOME"] ?? "/home/nobody";
const NOW = 1_700_000_500;
const roots: string[] = [];

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Layout {
  /** Workspace root (<tmp>/ws). */
  ws: string;
  /** Session directory - nested below the workspace in the W878 layout. */
  dir: string;
  /** The trusted <workspace>/<session> id resolve() returns. */
  id: string;
}

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "w878-" + name + "-"));
  roots.push(dir);
  return dir;
}

/** The two layouts the fix must serve: the W878 nested one and the legacy one. */
function layout(kind: "nested" | "legacy"): Layout {
  const ws = join(tempDir(kind), "ws");
  const dir = kind === "nested" ? join(ws, ".celestea", "sessions", "s1") : join(ws, "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), "");
  return { ws, dir, id: "ws/s1" };
}

function envOf(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME, ...extra };
}

function grantEntry(cap: string, scope: Record<string, unknown>, extra: Record<string, unknown> = {}): GrantRecord {
  return {
    id: "g-" + cap.slice(0, 6),
    cap: cap as GrantRecord["cap"],
    scope,
    granted_at: 1_700_000_000,
    granted_by: "hand",
    expires_at: null,
    uses_left: null,
    note: "",
    ...extra,
  } as GrantRecord;
}

/** Plant the four self-describing sidecars, each declaring session. */
function writeSidecars(l: Layout, session: string): void {
  writeFileSync(join(l.dir, "grants.json"), JSON.stringify({ version: 1, session, updated_at: 1_700_000_000, grants: [grantEntry("net_hosts", { hosts: ["10.1.2.3"] })] }));
  writeFileSync(join(l.dir, "permission.json"), JSON.stringify({ version: 1, session, preset: "read-only", updated_at: 0 }));
  writeFileSync(join(l.dir, "tools.json"), JSON.stringify({ version: 1, session, disabled: ["write_file"], updated_at: 0 }));
  writeFileSync(join(l.dir, "checkpoint.json"), JSON.stringify({ version: 1, session, clean_shutdown: false, open_turn: { id: "turn-4", started_at: 100 } }, null, 2) + "\n");
  writeFileSync(join(l.dir, "cli-main.jsonl"), serializeEventLog([{ type: "turn_start", id: "turn-4" }, { type: "user_message", text: "crash here" }]));
}

interface Resolved {
  workspace: string;
  session: string;
  id: string;
  wsPath: string;
  dir: string;
}

/** Boot recovery through the REAL fixed path, over a fake resolve(). */
function recoverOnBoot(l: Layout) {
  return recoverActiveSessionOnBoot({
    workspaces: { activeSession: () => l.id },
    sessions: { resolve: (): { ok: true; value: Resolved } => ({ ok: true, value: { workspace: "ws", session: "s1", id: l.id, wsPath: l.ws, dir: l.dir } }) },
    warn: () => {},
  });
}

/** All four sidecars must be honored, in either layout. */
function expectAllSidecarsHonored(l: Layout): void {
  const env = envOf(tempDir("data"));
  const grants = effectiveGrantsOf(l.dir, l.id, env, NOW);
  expect(grants.warnings.filter((w) => w.includes("unreadable"))).toEqual([]);
  expect(grants.grants.netHosts).toEqual(["10.1.2.3"]);
  expect(grants.grants.toolDeny).toContain("write_file");

  const permission = effectivePermissionOf(l.dir, l.id, env);
  expect(permission.preset).toBe("read-only");
  expect(permission.allPaths).toBe(false);

  const report = recoverOnBoot(l);
  expect(report?.checkpoint).toBe("ok");
  expect(report?.appended).toBe(true);
  expect(report?.action).toBe("closed_turn");
}

describe("W878 - the trusted session id drives every self-describing sidecar", () => {
  it("nested <ws>/.celestea/sessions/<dir>: all four sidecars are honored", () => {
    const l = layout("nested");
    writeSidecars(l, l.id);
    expectAllSidecarsHonored(l);
  });

  it("legacy <ws>/<dir>: the same sidecars stay honored (no regression)", () => {
    const l = layout("legacy");
    writeSidecars(l, l.id);
    expectAllSidecarsHonored(l);
  });

  it("a one-shot spend rewrites grants.json with the trusted self-description", () => {
    const l = layout("nested");
    const dataDir = tempDir("data");
    const env = envOf(dataDir, { CELESTEA_GRANTS_ALLOW_UNSANDBOXED: "1", CELESTEA_PERMISSION_MAX: "write-read" });
    writeFileSync(join(l.dir, "grants.json"), JSON.stringify({ version: 1, session: l.id, updated_at: 1, grants: [grantEntry("unsandboxed", {}, { id: "g-once", uses_left: 1, expires_at: NOW + 600 })] }));
    const reader = createSessionGrants({ dataDir, env, now: () => NOW * 1000 });
    const read = reader.read(l.id, l.dir);
    expect(read.grants.unsandboxed).toBe(true);
    reader.onComposed(l.id, l.dir, read);
    const stored = JSON.parse(readFileSync(join(l.dir, "grants.json"), "utf8")) as { session: string; grants: unknown[] };
    expect(stored.session).toBe(l.id);
    expect(stored.grants).toEqual([]);
  });

  it("bindingFor writes the checkpoint self-description with the threaded id", () => {
    const l = layout("nested");
    const binding = bindingFor(l.id, { sessionId: l.id, dir: l.dir }, new Map(), { identity: { boot_id: "b-w878", pid: 1 }, now: () => 5 });
    const log = binding.open();
    log.append({ type: "turn_start", id: "turn-1" });
    const cp = JSON.parse(readFileSync(join(l.dir, "checkpoint.json"), "utf8")) as { session: string; open_turn: { id: string } | null };
    expect(cp.session).toBe(l.id);
    expect(cp.open_turn?.id).toBe("turn-1");
    closeLog(log);
  });
});
