import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionOps } from "./session-ops.js";
import { SessionsStore } from "./sessions.js";
import { workspaceHome } from "./celestea-home.js";
import { WorkspacesStore } from "./workspaces.js";

let root: string;
let ws: string;
let registry: WorkspacesStore;
let sessions: SessionsStore;
let ops: SessionOps;

const LOG = [
  JSON.stringify({ type: "turn_start", id: "turn-1" }),
  JSON.stringify({ type: "user_message", text: "hello" }),
  JSON.stringify({ type: "assistant_message", text: "hi" }),
].join("\n") + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-"));
  ws = join(root, "sample-ws");
  mkdirSync(ws);
  registry = new WorkspacesStore(join(root, "workspaces.json"));
  registry.register(ws);
  sessions = new SessionsStore(registry, () => 1_700_000_000_000);
  ops = new SessionOps(registry, sessions, () => 1_700_000_000_000);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plant(name: string, log = LOG, meta?: Record<string, string>): string {
  return plantAt(ws, name, log, meta);
}

/** W877 slice A: plant a session in the NEW layout `<ws>/.celestea/sessions/<name>`. */
function plantNew(name: string, log = LOG, meta?: Record<string, string>): string {
  return plantAt(join(ws, ".celestea", "sessions"), name, log, meta);
}

/** W880: plant a session in the canonical `<CELESTEA_HOME>/.../sessions` root. */
function plantCanon(name: string, log = LOG, meta?: Record<string, string>): string {
  return plantAt(join(workspaceHome(ws), "sessions"), name, log, meta);
}

function plantAt(root: string, name: string, log = LOG, meta?: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), log);
  if (meta !== undefined) writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
  return dir;
}

describe("session scanner + transcript", () => {
  it("lists sessions with the frozen row shape and sorts by id", () => {
    plant("beta");
    plant("alpha", LOG, { model: "m-1" });
    plant(".hidden");
    const rows = sessions.list();
    expect(rows.map((r) => r.id)).toEqual(["sample-ws/alpha", "sample-ws/beta"]);
    expect(rows[0]).toMatchObject({ workspace: "sample-ws", title: "alpha", model: "m-1", active: false });
    expect(rows[0]?.size).toBe(Buffer.byteLength(LOG));
    expect(rows[0]?.modified).toBeGreaterThan(0);
  });

  it("merges engine worker rows and marks the active session", () => {
    plant("alpha");
    registry.setActiveSession("sample-ws/alpha");
    const rows = sessions.list([{ id: "worker:session-1", workspace: "engine", kind: "worker", title: "w", model: null, mode: "standard", size: 2, modified: 0, active: false }]);
    expect(rows.map((r) => r.id)).toEqual(["sample-ws/alpha", "worker:session-1"]);
    expect(rows[0]?.active).toBe(true);
  });

  it("projects the transcript and drops a torn tail", () => {
    plant("alpha", `${LOG}{"type":"user_mess`);
    const resolved = sessions.require("sample-ws/alpha");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(sessions.messages(resolved.value)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("distinguishes the four resolve/session_dir_for error codes", () => {
    expect(sessions.resolve("noslash")).toEqual({ ok: false, status: 400, error: "invalid session id 'noslash': expected '<workspace>/<session>'" });
    expect(sessions.resolve("ghost/s1")).toEqual({ ok: false, status: 404, error: "unknown workspace 'ghost'" });
    expect(sessions.resolve("sample-ws/..")).toEqual({ ok: false, status: 400, error: "invalid session id 'sample-ws/..'" });
    expect(sessions.resolve("sample-ws/.hidden")).toEqual({ ok: false, status: 400, error: "invalid session id 'sample-ws/.hidden'" });
    expect(sessions.require("sample-ws/missing")).toEqual({ ok: false, status: 404, error: "unknown session 'sample-ws/missing'" });
  });

  it("creates a session dir with the <title>-<secs>.<nanos> suffix and the meta file", () => {
    const res = sessions.create({ workspace: "sample-ws", title: "我的 会话", model: "m-1", prompt: "p-1" });
    expect(res).toEqual({ ok: true, value: "sample-ws/我的_会话-1700000000.0" });
    const dir = join(workspaceHome(ws), "sessions", "我的_会话-1700000000.0");
    expect(existsSync(join(dir, "cli-main.jsonl"))).toBe(true);
    // W779 T2: the ORIGINAL title is persisted next to model/prompt, so the row
    // shows `我的 会话` rather than the directory `我的_会话-1700000000.0`.
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))).toEqual({ title: "我的 会话", model: "m-1", prompt: "p-1" });
    expect(sessions.list()[0]?.model).toBe("m-1");
    expect(sessions.list()[0]?.title).toBe("我的 会话");
  });

  it("rejects a hidden title and an invalid model/prompt before creating anything", () => {
    expect(sessions.create({ workspace: "sample-ws", title: "   " })).toEqual({ ok: false, status: 400, error: "title must not be empty" });
    expect(sessions.create({ workspace: "sample-ws", title: ".hidden" })).toEqual({
      ok: false,
      status: 400,
      error: "title '.hidden' sanitizes to the hidden name '.hidden'",
    });
    expect(sessions.create({ workspace: "sample-ws", title: "ok", model: "bad model" }).ok).toBe(false);
    expect(sessions.create({ workspace: "sample-ws", title: "ok", prompt: "bad/id" }).ok).toBe(false);
    expect(sessions.create({ workspace: "ghost", title: "ok" })).toEqual({ ok: false, status: 404, error: "unknown workspace 'ghost'" });
    expect(existsSync(join(workspaceHome(ws), "sessions", "ok-1700000000.0"))).toBe(false);
  });

  it("M3/K8: the default mode is never WRITTEN as a key (W779 added `title`)", () => {
    // The frozen writer output, spelled out literally. W779 T2 put `title` first
    // and made it mandatory at creation, so the FILE now always exists — K8's
    // guarantee is per-key: the default mode still never appears.
    expect(sessions.create({ workspace: "sample-ws", title: "plain", model: "m-1", prompt: "p-1" })).toEqual({
      ok: true,
      value: "sample-ws/plain-1700000000.0",
    });
    expect(readFileSync(join(workspaceHome(ws), "sessions", "plain-1700000000.0", "session.json"), "utf8")).toBe(
      '{\n  "title": "plain",\n  "model": "m-1",\n  "prompt": "p-1"\n}\n',
    );
    expect(sessions.create({ workspace: "sample-ws", title: "bare" })).toEqual({ ok: true, value: "sample-ws/bare-1700000000.0" });
    // A title-only session DOES have a meta file: the display name must survive
    // the directory being renamed away from the title.
    expect(readFileSync(join(workspaceHome(ws), "sessions", "bare-1700000000.0", "session.json"), "utf8")).toBe('{\n  "title": "bare"\n}\n');
    for (const id of ["sample-ws/plain-1700000000.0", "sample-ws/bare-1700000000.0"]) {
      const row = sessions.list().find((r) => r.id === id);
      expect(row?.mode, id).toBe("standard");
      expect(row ? Object.keys(JSON.parse(readFileSync(join(workspaceHome(ws), "sessions", id.slice(id.indexOf("/") + 1), "session.json"), "utf8")) as object) : [], id).not.toContain("mode");
    }
  });

  it("M1/M2: writes an explicit mode, and rejects an unknown one before touching the disk", () => {
    expect(sessions.create({ workspace: "sample-ws", title: "exec", mode: "execution" })).toEqual({ ok: true, value: "sample-ws/exec-1700000000.0" });
    expect(readFileSync(join(workspaceHome(ws), "sessions", "exec-1700000000.0", "session.json"), "utf8")).toBe('{\n  "title": "exec",\n  "mode": "execution"\n}\n');
    expect(sessions.list()[0]).toMatchObject({ id: "sample-ws/exec-1700000000.0", mode: "execution" });

    expect(sessions.create({ workspace: "sample-ws", title: "fast", mode: "fast" })).toEqual({ ok: false, status: 400, error: "invalid mode: fast" });
    expect(existsSync(join(workspaceHome(ws), "sessions", "fast-1700000000.0"))).toBe(false);
  });

  it("reads an unknown hand-written mode as the default and keeps explicit standard", () => {
    plant("junk", LOG, { mode: "fast" });
    plant("std", LOG, { mode: "standard" });
    expect(sessions.list().map((r) => [r.id, r.mode])).toEqual([
      ["sample-ws/junk", "standard"],
      ["sample-ws/std", "standard"],
    ]);
  });

  it("truncates the log on clear", () => {
    plant("alpha");
    const resolved = sessions.require("sample-ws/alpha");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(sessions.truncate(resolved.value)).toEqual({ ok: true, value: undefined });
    expect(readFileSync(join(ws, "alpha", "cli-main.jsonl"), "utf8")).toBe("");
  });
});

describe("W779 T2 · session display names", () => {
  it("shows a legacy session dir without its creation suffix", () => {
    plant("main-1789192174.492000000");
    plant("v2-1-1700000000.0-2");
    plant("plain");
    plant("报告-2024");
    // Sorted by id; the two production shapes from the bug report are covered,
    // together with the two names that must NOT be touched.
    expect(sessions.list().map((r) => [r.id, r.title])).toEqual([
      ["sample-ws/main-1789192174.492000000", "main"],
      ["sample-ws/plain", "plain"],
      ["sample-ws/v2-1-1700000000.0-2", "v2-1"],
      ["sample-ws/报告-2024", "报告-2024"],
    ]);
  });

  it("prefers session.json.title over the directory name", () => {
    plant("我的_会话-1700000000.0", LOG, { title: "我的 会话" });
    expect(sessions.list()[0]?.title).toBe("我的 会话");
  });

  it("tolerates an absent, torn, non-string or empty title", () => {
    plant("no-meta-1700000000.0");
    plant("torn-1700000000.0", LOG);
    writeFileSync(join(ws, "torn-1700000000.0", "session.json"), "{oops");
    plant("wrong-1700000000.0", LOG);
    writeFileSync(join(ws, "wrong-1700000000.0", "session.json"), JSON.stringify({ title: 42 }));
    plant("empty-1700000000.0", LOG);
    writeFileSync(join(ws, "empty-1700000000.0", "session.json"), JSON.stringify({ title: "" }));
    expect(sessions.list().map((r) => r.title)).toEqual(["empty", "no-meta", "torn", "wrong"]);
  });

  it("rename rewrites the title, keeping the other keys (and creates a missing meta)", () => {
    plant("alpha", LOG, { model: "m-1" });
    expect(ops.rename("sample-ws/alpha", "我的 会话")).toEqual({ ok: true, value: "sample-ws/我的_会话" });
    expect(JSON.parse(readFileSync(join(ws, "我的_会话", "session.json"), "utf8"))).toEqual({ title: "我的 会话", model: "m-1" });
    expect(sessions.list().find((r) => r.id === "sample-ws/我的_会话")?.title).toBe("我的 会话");

    plant("no-meta");
    expect(ops.rename("sample-ws/no-meta", "renamed")).toEqual({ ok: true, value: "sample-ws/renamed" });
    expect(readFileSync(join(ws, "renamed", "session.json"), "utf8")).toBe('{\n  "title": "renamed"\n}\n');
  });

  it("branch takes the parent's DISPLAY name for its default title", () => {
    plant("main-1789192174.492000000");
    expect(ops.branch("sample-ws/main-1789192174.492000000")).toEqual({ ok: true, value: "sample-ws/main-分支-1700000000.0" });
    const dir = join(ws, "main-分支-1700000000.0");
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))).toEqual({ title: "main-分支" });
    expect(sessions.list().find((r) => r.id === "sample-ws/main-分支-1700000000.0")?.title).toBe("main-分支");
  });

  it("an explicit branch title wins and inherits model/prompt/mode", () => {
    plant("alpha", LOG, { title: "Alpha", model: "m-1", prompt: "p-1", mode: "execution" });
    expect(ops.branch("sample-ws/alpha", "copy")).toEqual({ ok: true, value: "sample-ws/copy-1700000000.0" });
    expect(JSON.parse(readFileSync(join(ws, "copy-1700000000.0", "session.json"), "utf8"))).toEqual({
      title: "copy",
      model: "m-1",
      prompt: "p-1",
      mode: "execution",
    });
  });
});

describe("session moves", () => {
  it("renames a session dir with a collision suffix", () => {
    plant("alpha");
    plant("renamed");
    expect(ops.rename("sample-ws/alpha", "renamed")).toEqual({ ok: true, value: "sample-ws/renamed-1" });
    expect(existsSync(join(ws, "renamed-1", "cli-main.jsonl"))).toBe(true);
    expect(ops.rename("sample-ws/renamed-1", "renamed-1")).toEqual({ ok: true, value: "sample-ws/renamed-1" });
  });

  it("branches a session into a timestamped sibling and copies the meta (mode included)", () => {
    plant("alpha", LOG, { model: "m-1", mode: "execution" });
    expect(ops.branch("sample-ws/alpha", undefined)).toEqual({ ok: true, value: "sample-ws/alpha-分支-1700000000.0" });
    const dir = join(ws, "alpha-分支-1700000000.0");
    expect(readFileSync(join(dir, "cli-main.jsonl"), "utf8")).toBe(LOG);
    // W729 §2.3 + W779 T2: the branch INHERITS model/prompt/mode and gets its
    // OWN title (the default `<parent display name>-分支`).
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))).toEqual({ title: "alpha-分支", model: "m-1", mode: "execution" });
  });

  it("archives into .celestea-archived and unarchives back (id preserved)", () => {
    plant("alpha");
    expect(ops.archive("sample-ws/alpha")).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(workspaceHome(ws), "archive", "alpha", "cli-main.jsonl"))).toBe(true);
    expect(sessions.list().map((r) => r.id)).toEqual([]);
    expect(ops.archive("sample-ws/alpha")).toEqual({ ok: false, status: 404, error: "unknown session 'sample-ws/alpha'" });
    expect(ops.unarchive("sample-ws/alpha")).toEqual({ ok: true, value: undefined });
    // W877 slice A: with neither live layout present, `resolve()` falls back to the
    // NEW layout, so a legacy session restored from the archive lands there.
    expect(existsSync(join(workspaceHome(ws), "sessions", "alpha", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(ws, "alpha"))).toBe(false);
    expect(ops.unarchive("sample-ws/missing")).toEqual({ ok: false, status: 404, error: "session 'sample-ws/missing' is not archived" });
  });

  it("W794: archives or deletes the ACTIVE session and clears the marker (no 400)", () => {
    plant("alpha");
    plant("beta");
    registry.setActiveSession("sample-ws/alpha");
    // 裁决：active 只是状态标记，不是保护理由 —— 归档活动会话成功，且标记被清空
    // （archived 行不在默认列表里，标记若留着就与 GET /api/sessions 自相矛盾）。
    expect(ops.archive("sample-ws/alpha")).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(workspaceHome(ws), "archive", "alpha", "cli-main.jsonl"))).toBe(true);
    expect(registry.activeSession()).toBeNull();

    // 删除活动会话同样成功：目录进 trash，active_session 落盘为 null。
    registry.setActiveSession("sample-ws/beta");
    expect(ops.batchDelete(["sample-ws/beta"])).toEqual({ deleted: 1, failed: [] });
    expect(existsSync(join(workspaceHome(ws), "trash", "beta-1700000000.0", "cli-main.jsonl"))).toBe(true);
    expect(registry.activeSession()).toBeNull();
    expect(registry.registry().active_session).toBeNull();

    // 非活动会话的删除不动标记（删除的后果只落在被删的那个 id 上）。
    plant("gamma");
    registry.setActiveSession("sample-ws/gamma");
    expect(ops.batchDelete(["sample-ws/ghost"])).toEqual({ deleted: 0, failed: [{ id: "sample-ws/ghost", error: "unknown session 'sample-ws/ghost'" }] });
    expect(registry.activeSession()).toBe("sample-ws/gamma");
  });

  it("trashes into .celestea-trash with a timestamp and reports per-id failures", () => {
    plant("alpha");
    plant("beta");
    const out = ops.batchDelete(["sample-ws/alpha", "sample-ws/ghost"]);
    expect(out.deleted).toBe(1);
    expect(out.failed).toEqual([{ id: "sample-ws/ghost", error: "unknown session 'sample-ws/ghost'" }]);
    expect(existsSync(join(workspaceHome(ws), "trash", "alpha-1700000000.0", "cli-main.jsonl"))).toBe(true);
  });

  it("reports per-id failures for batch-archive", () => {
    plant("alpha");
    plant("beta");
    const out = ops.batchArchive(["sample-ws/alpha", "sample-ws/beta"]);
    expect(out.archived).toBe(2);
    expect(out.failed).toEqual([]);
  });
});

describe("W877 slice A · new-layout sessions (<ws>/.celestea/sessions/)", () => {
  it("(1) still lists and resolves a LEGACY-root session, pointing dir at <ws>/alpha", () => {
    plant("alpha");
    expect(sessions.list().map((r) => r.id)).toEqual(["sample-ws/alpha"]);
    const res = sessions.resolve("sample-ws/alpha");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.dir).toBe(join(ws, "alpha"));
    expect(res.value.id).toBe("sample-ws/alpha");
  });

  it("(1b) still lists and resolves a slice-A `<ws>/.celestea/sessions` session", () => {
    plantNew("alpha");
    expect(sessions.list().map((r) => r.id)).toEqual(["sample-ws/alpha"]);
    const res = sessions.resolve("sample-ws/alpha");
    expect(res.ok && res.value.dir).toBe(join(ws, ".celestea", "sessions", "alpha"));
  });

  it("(2) create() writes <home>/workspaces/<ws>/sessions/<name>/ and keeps the id", () => {
    const res = sessions.create({ workspace: "sample-ws", title: "fresh" });
    expect(res).toEqual({ ok: true, value: "sample-ws/fresh-1700000000.0" });
    const dir = join(workspaceHome(ws), "sessions", "fresh-1700000000.0");
    expect(existsSync(join(dir, "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    // ZERO pollution: not the legacy root, not even a `.celestea` container.
    expect(existsSync(join(ws, "fresh-1700000000.0"))).toBe(false);
    expect(existsSync(join(ws, ".celestea"))).toBe(false);
    expect(sessions.list().map((r) => r.id)).toEqual(["sample-ws/fresh-1700000000.0"]);
    const resolved = sessions.resolve("sample-ws/fresh-1700000000.0");
    expect(resolved.ok && resolved.value.dir).toBe(dir);
  });

  it("(3) dedupes a name present in THREE layers, keeping the canonical row", () => {
    plant("dup", LOG, { title: "legacy" });
    plantNew("dup", LOG, { title: "slice-a" });
    plantCanon("dup", LOG, { title: "canonical" });
    const rows = sessions.list().filter((r) => r.id === "sample-ws/dup");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("canonical");
    const resolved = sessions.resolve("sample-ws/dup");
    expect(resolved.ok && resolved.value.dir).toBe(join(workspaceHome(ws), "sessions", "dup"));
  });

  it("(4) create() collision-detects across ALL layers (legacy name is not re-minted)", () => {
    plant("beta-1700000000.0");
    const res = sessions.create({ workspace: "sample-ws", title: "beta" });
    expect(res).toEqual({ ok: true, value: "sample-ws/beta-1700000000.0-1" });
    expect(existsSync(join(workspaceHome(ws), "sessions", "beta-1700000000.0-1", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(workspaceHome(ws), "sessions", "beta-1700000000.0"))).toBe(false);
    expect(sessions.list().map((r) => r.id).sort()).toEqual(["sample-ws/beta-1700000000.0", "sample-ws/beta-1700000000.0-1"]);
  });

  it("(4b) a canonical name also blocks a second create() from reusing it", () => {
    const first = sessions.create({ workspace: "sample-ws", title: "twice" });
    expect(first).toEqual({ ok: true, value: "sample-ws/twice-1700000000.0" });
    const second = sessions.create({ workspace: "sample-ws", title: "twice" });
    expect(second).toEqual({ ok: true, value: "sample-ws/twice-1700000000.0-1" });
  });

  it("(legacy) rename and branch keep moving WITHIN the layer they already live in", () => {
    plant("alpha", LOG, { model: "m-1" });
    expect(ops.rename("sample-ws/alpha", "renamed")).toEqual({ ok: true, value: "sample-ws/renamed" });
    expect(existsSync(join(ws, "renamed", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(ws, ".celestea", "sessions", "renamed"))).toBe(false);
    expect(ops.branch("sample-ws/renamed", "copy")).toEqual({ ok: true, value: "sample-ws/copy-1700000000.0" });
    expect(existsSync(join(ws, "copy-1700000000.0", "cli-main.jsonl"))).toBe(true);
    expect(existsSync(join(ws, ".celestea", "sessions", "copy-1700000000.0"))).toBe(false);
  });
});
