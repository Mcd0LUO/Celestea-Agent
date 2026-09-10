import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacesStore } from "./workspaces.js";

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-store-"));
  file = join(root, "workspaces.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plantSession(ws: string, name: string): void {
  mkdirSync(join(ws, name), { recursive: true });
  writeFileSync(join(ws, name, "cli-main.jsonl"), "");
}

describe("workspaces.json v2 registry", () => {
  it("round-trips register -> write -> re-read", () => {
    mkdirSync(join(root, "alpha"));
    const store = new WorkspacesStore(file);
    const res = store.register(join(root, "alpha"));
    expect(res).toEqual({ ok: true, value: "alpha" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ workspaces: [{ path: join(root, "alpha") }], active_session: null });
    const reread = new WorkspacesStore(file);
    expect(reread.view()).toEqual({ workspaces: [{ name: "alpha", path: join(root, "alpha"), sessions: 0 }], active_session: null });
  });

  it("persists active_session and reports it in the view", () => {
    mkdirSync(join(root, "alpha"));
    const store = new WorkspacesStore(file);
    store.register(join(root, "alpha"));
    expect(store.setActiveSession("alpha/s1")).toEqual({ ok: true, value: undefined });
    expect(new WorkspacesStore(file).activeSession()).toBe("alpha/s1");
  });

  it("tolerates a missing file and a v1 row (name is ignored, never written back)", () => {
    expect(new WorkspacesStore(file).view()).toEqual({ workspaces: [], active_session: null });
    mkdirSync(join(root, "legacy"));
    writeFileSync(file, JSON.stringify({ workspaces: [{ name: "legacy", path: join(root, "legacy") }], active_session: null }));
    const store = new WorkspacesStore(file);
    expect(store.view().workspaces.map((w) => w.name)).toEqual(["legacy"]);
    store.setActiveSession(null);
    expect(readFileSync(file, "utf8")).not.toContain("\"name\"");
  });

  it("refuses a malformed registry instead of overwriting it", () => {
    writeFileSync(file, "{not json");
    expect(() => new WorkspacesStore(file)).toThrow(/malformed/);
  });

  it("refuses duplicate folder basenames (ambiguous workspace key)", () => {
    mkdirSync(join(root, "a", "dup"), { recursive: true });
    mkdirSync(join(root, "b", "dup"), { recursive: true });
    writeFileSync(file, JSON.stringify({ workspaces: [{ path: join(root, "a", "dup") }, { path: join(root, "b", "dup") }] }));
    expect(() => new WorkspacesStore(file)).toThrow(/same folder name 'dup'/);
  });

  it("validates the registration path with the frozen error strings", () => {
    mkdirSync(join(root, "alpha"));
    const store = new WorkspacesStore(file);
    expect(store.register("")).toEqual({ ok: false, status: 400, error: "path must not be empty" });
    expect(store.register("relative/path")).toEqual({ ok: false, status: 400, error: "path 'relative/path' must be absolute" });
    expect(store.register("/no/such/dir")).toEqual({ ok: false, status: 400, error: "path '/no/such/dir' is not an existing directory" });
    expect(store.register(join(root, "alpha")).ok).toBe(true);
    expect(store.register(join(root, "alpha"))).toEqual({
      ok: false,
      status: 409,
      error: `path '${join(root, "alpha")}' is already registered as workspace 'alpha'`,
    });
  });

  it("counts only live session dirs and skips dot-dirs", () => {
    const ws = join(root, "alpha");
    mkdirSync(ws);
    plantSession(ws, "one");
    plantSession(ws, "two");
    mkdirSync(join(ws, ".celestea-archived", "old"), { recursive: true });
    writeFileSync(join(ws, ".celestea-archived", "old", "cli-main.jsonl"), "");
    mkdirSync(join(ws, "no-log"));
    const store = new WorkspacesStore(file);
    store.register(ws);
    expect(store.view().workspaces[0]?.sessions).toBe(2);
  });

  it("deregisters without touching the folder and clears its active_session", () => {
    const ws = join(root, "alpha");
    mkdirSync(ws);
    const store = new WorkspacesStore(file);
    store.register(ws);
    store.setActiveSession("alpha/s1");
    expect(store.deregister("nope")).toEqual({ ok: false, status: 404, error: "unknown workspace 'nope'" });
    expect(store.deregister("alpha")).toEqual({ ok: true, value: undefined });
    expect(store.activeSession()).toBeNull();
    expect(new WorkspacesStore(file).view().workspaces).toEqual([]);
  });

  it("renames the folder on disk and follows active_session", () => {
    const ws = join(root, "alpha");
    mkdirSync(ws);
    const store = new WorkspacesStore(file);
    store.register(ws);
    store.setActiveSession("alpha/s1");
    expect(store.renameWorkspace("alpha", "beta")).toEqual({ ok: true, value: undefined });
    expect(store.view().workspaces.map((w) => w.name)).toEqual(["beta"]);
    expect(store.activeSession()).toBe("beta/s1");
    expect(new WorkspacesStore(file).view().workspaces[0]?.name).toBe("beta");
  });

  it("reports per-name failures for batch-delete and keeps going", () => {
    mkdirSync(join(root, "alpha"));
    const store = new WorkspacesStore(file);
    store.register(join(root, "alpha"));
    const out = store.batchDelete(["alpha", "ghost"]);
    expect(out.deleted).toBe(1);
    expect(out.failed).toEqual([{ name: "ghost", error: "unknown workspace 'ghost'" }]);
  });
});
