/**
 * W880 acceptance — every celestea artifact lands under CELESTEA_HOME, the
 * workspace root stays clean, and both legacy layouts stay readable.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceHome } from "./celestea-home.js";
import { PromptsStore } from "./prompts.js";
import { SessionOps } from "./session-ops.js";
import { SessionsStore } from "./sessions.js";
import { WorkspacesStore } from "./workspaces.js";

let root: string;
let ws: string;
let registry: WorkspacesStore;
let sessions: SessionsStore;
let ops: SessionOps;

const LOG = JSON.stringify({ type: "user_message", text: "hi" }) + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w880-layout-"));
  ws = join(root, "sample-ws");
  mkdirSync(ws);
  registry = new WorkspacesStore(join(root, "workspaces.json"));
  registry.register(ws);
  sessions = new SessionsStore(registry, () => 1_700_000_000_000);
  ops = new SessionOps(registry, sessions, () => 1_700_000_000_000);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plantAt(base: string, name: string, meta?: Record<string, string>): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), LOG);
  if (meta !== undefined) writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
  return dir;
}

describe("W880 · workspace zero pollution", () => {
  it("create() leaves the workspace root untouched (not even .celestea)", () => {
    expect(sessions.create({ workspace: "sample-ws", title: "fresh" })).toEqual({ ok: true, value: "sample-ws/fresh-1700000000.0" });
    expect(existsSync(join(ws, ".celestea"))).toBe(false);
    expect(existsSync(join(ws, "fresh-1700000000.0"))).toBe(false);
    expect(existsSync(join(workspaceHome(ws), "sessions", "fresh-1700000000.0", "cli-main.jsonl"))).toBe(true);
  });

  it("archive / trash move into the canonical container", () => {
    plantAt(ws, "alpha");
    expect(ops.archive("sample-ws/alpha")).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(workspaceHome(ws), "archive", "alpha", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(ws, ".celestea-archived"))).toBe(false);

    plantAt(ws, "beta");
    expect(ops.batchDelete(["sample-ws/beta"])).toEqual({ deleted: 1, failed: [] });
    expect(existsSync(join(workspaceHome(ws), "trash", "beta-1700000000.0", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(ws, ".celestea-trash"))).toBe(false);
  });
});

describe("W880 · archive / trash legacy reads", () => {
  it("lists and unarchives a legacy .celestea-archived session", () => {
    plantAt(join(ws, ".celestea-archived"), "old");
    expect(sessions.listArchived().map((r) => r.id)).toEqual(["sample-ws/old"]);
    expect(ops.unarchive("sample-ws/old")).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(workspaceHome(ws), "sessions", "old", "cli-main.jsonl"))).toBe(true);
  });

  it("trashes a session that only exists in the legacy archive", () => {
    plantAt(join(ws, ".celestea-archived"), "old");
    expect(ops.batchDelete(["sample-ws/old"])).toEqual({ deleted: 1, failed: [] });
    expect(existsSync(join(workspaceHome(ws), "trash", "old-1700000000.0", "cli-main.jsonl"))).toBe(true);
  });

  it("a canonical archive row shadows a same-named legacy one", () => {
    plantAt(join(ws, ".celestea-archived"), "dup", { title: "legacy" });
    plantAt(join(workspaceHome(ws), "archive"), "dup", { title: "canonical" });
    const rows = sessions.listArchived().filter((r) => r.id === "sample-ws/dup");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("canonical");
  });
});

describe("W880 · countSessions across layers", () => {
  it("counts a name once even when it exists in several layers", () => {
    plantAt(ws, "legacy");
    plantAt(join(ws, ".celestea", "sessions"), "slice-a");
    plantAt(join(workspaceHome(ws), "sessions"), "canon");
    plantAt(join(workspaceHome(ws), "sessions"), "legacy");
    expect(registry.countSessions(ws)).toBe(3);
    expect(registry.view().workspaces[0]?.sessions).toBe(3);
  });
});

describe("W880 · prompts triple-read / canonical write", () => {
  it("reads the legacy .celestea-prompts.json and writes the canonical file", () => {
    const store = new PromptsStore(join(root, "global-prompts.json"));
    const legacy = join(ws, ".celestea-prompts.json");
    writeFileSync(
      legacy,
      JSON.stringify({ sections: [], prompts: [{ id: "legacy", name: "L", section_overrides: {}, is_default: true }], default_prompt: "legacy" }),
    );
    const scope = store.scopeWorkspace("sample-ws", ws);
    expect(store.read(scope).prompts.map((p) => p.id)).toEqual(["legacy"]);
    expect(scope.file).toBe(join(workspaceHome(ws), "prompts.json"));

    expect(store.upsert(scope, { id: "new", name: "N" }).ok).toBe(true);
    expect(existsSync(join(workspaceHome(ws), "prompts.json"))).toBe(true);
    expect(store.read(scope).prompts.map((p) => p.id)).toEqual(["legacy", "new"]);
    // The legacy file is a READ fallback, never rewritten.
    expect((JSON.parse(readFileSync(legacy, "utf8")) as { prompts: unknown[] }).prompts).toHaveLength(1);
  });
});

