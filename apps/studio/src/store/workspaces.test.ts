import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacesStore } from "./workspaces.js";
import { joinPath, parentDir } from "./session-id.js";

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

  it("W877: counts sessions in BOTH the new .celestea/sessions layout and the legacy root", () => {
    const ws = join(root, "alpha");
    mkdirSync(ws);
    plantSession(ws, "legacy"); // <ws>/legacy
    const newRoot = join(ws, ".celestea", "sessions");
    mkdirSync(join(newRoot, "fresh"), { recursive: true });
    writeFileSync(join(newRoot, "fresh", "cli-main.jsonl"), "");
    // A hidden dir inside the new root, and a dir without a log, are not sessions.
    mkdirSync(join(newRoot, ".hidden"), { recursive: true });
    writeFileSync(join(newRoot, ".hidden", "cli-main.jsonl"), "");
    mkdirSync(join(newRoot, "no-log"), { recursive: true });
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

  // W815-9 (source: W828-R3 修复计划 B2): a registered trailing slash used to
  // make rename build '/root/foo/bar' — a CHILD of the source (renameSync EINVAL).
  it("W815-9: a trailing-slash registration normalizes so rename makes a SIBLING", () => {
    const foo = join(root, "foo");
    mkdirSync(foo);
    const store = new WorkspacesStore(file);
    expect(store.register(foo + "/")).toEqual({ ok: true, value: "foo" });
    expect(store.renameWorkspace("foo", "bar")).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(root, "bar"))).toBe(true);
    expect(existsSync(foo)).toBe(false);
    expect(store.view().workspaces.map((w) => w.path)).toEqual([join(root, "bar")]);
  });

  // W815-10 (source: W828-R3 修复计划 B2): a persist failure used to leave the
  // folder moved while memory/disk still named the old path (a fork).
  it("W815-10: a persist failure rolls the folder and the row back (no fork)", () => {
    const ws = join(root, "alpha");
    mkdirSync(ws);
    const store = new WorkspacesStore(file);
    store.register(ws);
    store.setActiveSession("alpha/s1");
    // Force the atomic write to fail: its temp path is an existing directory.
    mkdirSync(file + ".tmp");
    const res = store.renameWorkspace("alpha", "beta");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(root, "beta"))).toBe(false);
    expect(store.view().workspaces.map((w) => w.name)).toEqual(["alpha"]);
    expect(store.view().workspaces[0]?.path).toBe(ws);
    expect(store.activeSession()).toBe("alpha/s1");
  });
});

/**
 * W885 follow-up — Windows.
 *
 * `register()` tested `startsWith("/")`, so EVERY Windows absolute path
 * (`C:\...`) was rejected as "not absolute": no workspace could ever be
 * registered on Windows, the registry stayed empty, and every "new session" then
 * failed with `404 unknown workspace ''`. Same class: `renameWorkspace` derived
 * the sibling target with `lastIndexOf("/")`, which finds no separator in a win32
 * path and moved the folder beside a NONEXISTENT directory.
 *
 * The platform is injectable (the W885 seam), so the win32 rules run on this host.
 */
describe("win32 paths (W885 seam)", () => {
  it("register 不再把 C:\\... 当成「非绝对路径」拒绝", () => {
    const store = new WorkspacesStore(file, "win32");
    const res = store.register("C:\\Users\\me\\proj");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // The absolute gate must PASS now — the only reason left is that no such
      // directory exists on this host. Before the fix this said "must be absolute".
      expect(res.error).not.toMatch(/must be absolute/);
      expect(res.error).toMatch(/is not an existing directory/);
    }
  });

  it("仍然拒绝真正非绝对的 win32 路径", () => {
    const store = new WorkspacesStore(file, "win32");
    expect(store.register("Users\\me\\proj")).toEqual({
      ok: false,
      status: 400,
      error: "path 'Users\\me\\proj' must be absolute",
    });
  });

  it("读 Windows 注册表：名字 -> 路径 的解析走 win32 规则", () => {
    writeFileSync(file, JSON.stringify({ workspaces: [{ path: "C:\\Users\\me\\proj" }], active_session: null }));
    const store = new WorkspacesStore(file, "win32");
    expect(store.workspacePath("proj")).toBe("C:\\Users\\me\\proj");
    expect(store.view().workspaces.map((w) => w.name)).toEqual(["proj"]);
  });

  it("重命名派生的兄弟目录在 win32 下正确（旧实现取错父目录）", () => {
    expect(parentDir("C:\\Users\\me\\proj", "win32")).toBe("C:\\Users\\me");
    expect(joinPath("win32", parentDir("C:\\Users\\me\\proj", "win32"), "next")).toBe("C:\\Users\\me\\next");
    // POSIX 行为逐字不变
    expect(parentDir("/tmp/foo", "posix")).toBe("/tmp");
    expect(joinPath("posix", "/tmp", "next")).toBe("/tmp/next");
  });
});

