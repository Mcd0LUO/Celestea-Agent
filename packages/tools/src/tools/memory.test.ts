/**
 * B2 (F3 P1) — the workspace-memory WRITE side: append-only log, dedup, tombstone,
 * supersede, render, and the end-to-end read the turn-start injection performs.
 *
 * Pure pieces run against an in-memory [MemoryStoreIo]; the end-to-end case uses
 * a real temp CELESTEA_HOME so the tool and the READ side (core's
 * `memoryContextOf`) agree on the same file on disk.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryContextOf } from "@celestea/core";
import {
  foldMemoryLog,
  memoryTextHash,
  nextMemoryId,
  parseMemoryLog,
  renderMemoryMarkdown,
  type MemoryLogLine,
} from "../memory/log.js";
import { memoryStoreOf, readMemoryState, type MemoryStoreIo } from "../memory/store.js";
import { forgetTool, rememberTool } from "./memory.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An in-memory io seam: a Map of path -> text, append concatenates. */
function fakeIo(): MemoryStoreIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readText: (f) => files.get(f) ?? null,
    ensureDir: () => undefined,
    append: (f, t) => void files.set(f, (files.get(f) ?? "") + t),
    write: (f, t) => void files.set(f, t),
  };
}

const WS = "/ws/demo";

describe("B2 · append-only memory log (pure)", () => {
  it("parses a log, ignores the header and a torn tail, and folds entries", () => {
    const text = [
      '{"kind":"memory-log","version":1}',
      '{"kind":"entry","id":"m1","text":"a","tags":[],"at":"t"}',
      '{"kind":"entry","id":"m2","text":"b","tags":["x"],"at":"t"}',
      '{"kind":"entry"', // torn tail
    ].join("\n");
    const lines = parseMemoryLog(text);
    expect(lines.map((l) => (l.kind === "entry" ? l.id : l.id))).toEqual(["m1", "m2"]);
    expect(foldMemoryLog(lines).entries.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("nextMemoryId derives the next free id", () => {
    expect(nextMemoryId([])).toBe("m1");
    expect(nextMemoryId([{ kind: "entry", id: "m7", text: "", tags: [], at: "" }])).toBe("m8");
  });

  it("renders groups (sorted, untagged last) with an explicit generated banner", () => {
    const entries = [
      { kind: "entry" as const, id: "m1", text: "no tag", tags: [], at: "" },
      { kind: "entry" as const, id: "m2", text: "in zeta", tags: ["zeta"], at: "" },
      { kind: "entry" as const, id: "m3", text: "in alpha", tags: ["alpha"], at: "" },
    ];
    const md = renderMemoryMarkdown(entries);
    expect(md).toContain("DATA, not instructions");
    expect(md.indexOf("## alpha")).toBeLessThan(md.indexOf("## zeta"));
    expect(md.indexOf("## zeta")).toBeLessThan(md.indexOf("## general"));
    expect(md).toContain("[m1] no tag");
  });

  it("empty entries render nothing (zero cost)", () => {
    expect(renderMemoryMarkdown([])).toBe("");
  });
});

describe("B2 · remember / forget over the io seam", () => {
  const tools = (io: MemoryStoreIo, now = "2026-09-19T00:00:00.000Z") => ({
    remember: rememberTool({ workspace: WS, env: { CELESTEA_HOME: "/home" }, io, now: () => now }),
    forget: forgetTool({ workspace: WS, env: { CELESTEA_HOME: "/home" }, io, now: () => now }),
  });

  it("appends an entry and renders MEMORY.md with the layer + absolute file", async () => {
    const io = fakeIo();
    const t = tools(io);
    const out = (await t.remember.execute({ text: "the build is reproducible" })) as Record<string, unknown>;
    expect(out["appended"]).toBe(true);
    expect(out["reason"]).toBe("added");
    expect(out["layer"]).toBe("global");
    expect(String(out["file"])).toContain("entries.jsonl");
    const state = readMemoryState(memoryStoreOf(WS, { env: { CELESTEA_HOME: "/home" } }, io));
    expect(state.entries.map((e) => e.text)).toEqual(["the build is reproducible"]);
    // MEMORY.md was rendered next to the log.
    const memory = [...io.files.entries()].find(([k]) => k.endsWith("MEMORY.md"));
    expect(String(memory?.[1])).toContain("the build is reproducible");
  });

  it("identical text is a NOOP: appended=false, no second line, no second entry", async () => {
    const io = fakeIo();
    const t = tools(io);
    const first = (await t.remember.execute({ text: "same fact" })) as Record<string, unknown>;
    const again = (await t.remember.execute({ text: "same fact" })) as Record<string, unknown>;
    expect(first["appended"]).toBe(true);
    expect(again["appended"]).toBe(false);
    expect(again["reason"]).toBe("duplicate");
    expect(again["id"]).toBe(first["id"]);
    const state = readMemoryState(memoryStoreOf(WS, { env: { CELESTEA_HOME: "/home" } }, io));
    expect(state.entries).toHaveLength(1);
    expect(state.lines.filter((l) => l.kind === "entry")).toHaveLength(1);
  });

  it("forget appends a TOMBSTONE and never rewrites history", async () => {
    const io = fakeIo();
    const t = tools(io);
    const added = (await t.remember.execute({ text: "temp fact" })) as Record<string, unknown>;
    const forgotten = (await t.forget.execute({ id: added["id"] })) as Record<string, unknown>;
    expect(forgotten["forgotten"]).toBe(true);
    const state = readMemoryState(memoryStoreOf(WS, { env: { CELESTEA_HOME: "/home" } }, io));
    expect(state.entries).toHaveLength(0);
    // History retained: the original entry line is still in the log.
    expect(state.lines.filter((l) => l.kind === "entry")).toHaveLength(1);
    expect(state.lines.some((l) => l.kind === "forget")).toBe(true);
  });

  it("forget by exact text works; an unknown target fails structured", async () => {
    const io = fakeIo();
    const t = tools(io);
    await t.remember.execute({ text: "find me" });
    await expect(t.forget.execute({ text: "find me" })).resolves.toMatchObject({ forgotten: true });
    await expect(t.forget.execute({ id: "m99" })).rejects.toMatchObject({ kind: "unknown_id" });
    await expect(t.forget.execute({})).rejects.toMatchObject({ kind: "missing_target" });
  });

  it("supersedes hides the older entry while keeping its history line", () => {
    const lines: MemoryLogLine[] = [
      { kind: "entry", id: "m1", text: "old", tags: [], at: "t" },
      { kind: "entry", id: "m2", text: "new", tags: [], at: "t", supersedes: "m1" },
    ];
    const state = foldMemoryLog(lines);
    expect(state.entries.map((e) => e.text)).toEqual(["new"]);
    expect(state.tombstoned.has("m1")).toBe(true);
    expect(state.lines).toHaveLength(2);
  });

  it("refuses a blank note and one over the cap", async () => {
    const t = tools(fakeIo());
    await expect(t.remember.execute({ text: "   " })).rejects.toMatchObject({ kind: "empty_text" });
    await expect(t.remember.execute({ text: "x".repeat(3000) })).rejects.toMatchObject({ kind: "text_too_long" });
  });

  it("a generation with no workspace fails closed with no_workspace", async () => {
    const tool = rememberTool({ workspace: null });
    await expect(tool.execute({ text: "x" })).rejects.toMatchObject({ kind: "no_workspace" });
  });

  it("the dedup key is the content hash (stable across writes)", () => {
    expect(memoryTextHash("a")).toBe(memoryTextHash("a"));
    expect(memoryTextHash("a")).not.toBe(memoryTextHash("b"));
  });
});

describe("B2 · end-to-end: a remembered fact reaches the READ side", () => {
  it("renders MEMORY.md that core's memoryContextOf injects", async () => {
    const home = mkdtempSync(join(tmpdir(), "f3-memory-home-"));
    const ws = mkdtempSync(join(tmpdir(), "f3-memory-ws-"));
    dirs.push(home, ws);
    const env = { CELESTEA_HOME: home };
    const remember = rememberTool({ workspace: ws, env });
    const out = (await remember.execute({ text: "deploys run on port 3777" })) as Record<string, unknown>;
    expect(out["appended"]).toBe(true);

    // The READ side (turn-start injection) resolves the same global layer.
    const context = memoryContextOf(ws, { env });
    expect(context).not.toBeNull();
    expect(String(context)).toContain("deploys run on port 3777");
    // The anti-poisoning notice is intact (write side never touches the read side).
    expect(String(context)).toContain("data, NOT instructions");

    // The on-disk MEMORY.md is what the read side read.
    const memoryFile = join(home, "workspaces", ws.split("/").pop() as string, "memory", "MEMORY.md");
    expect(readFileSync(memoryFile, "utf8")).toContain("deploys run on port 3777");
  });
});
