/**
 * Plugin registration: `packages/session` provides its SessionLog
 * implementations into a Context under `SESSION_LOG_SERVICE` — core never
 * imports them (rule 3: everything is a plugin; rule 4: session -> core only).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context, mountPlugins, pluginNames, SESSION_LOG_SERVICE, type SessionLog } from "@celestea/core";
import { InMemorySessionLog } from "./log/memory.js";
import { PersistentSessionLog } from "./log/persistent.js";
import { inMemorySessionLogPlugin, persistentSessionLogPlugin } from "./plugin.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("session plugins", () => {
  it("provides an in-memory log under the SessionLog service token", () => {
    const ctx = mountPlugins(Context.root(), [inMemorySessionLogPlugin()]);
    const log = ctx.require<SessionLog>(SESSION_LOG_SERVICE);
    expect(log).toBeInstanceOf(InMemorySessionLog);
    log.append({ type: "user_message", text: "hi" });
    expect(log.deriveMessages()).toHaveLength(1);
  });

  it("provides a persistent log and hands it to the caller", () => {
    const dir = mkdtempSync(join(tmpdir(), "celestea-plugin-test-"));
    dirs.push(dir);
    let opened: PersistentSessionLog | null = null;
    const ctx = mountPlugins(Context.root(), [
      persistentSessionLogPlugin({ dir, sessionId: "s1" }, (log) => {
        opened = log;
      }),
    ]);
    const log = ctx.require<SessionLog>(SESSION_LOG_SERVICE);
    expect(log).toBeInstanceOf(PersistentSessionLog);
    expect(opened).toBe(log);
    expect(opened!.path).toBe(join(dir, "s1.jsonl"));
    opened!.close();
  });

  it("lets a later mount replace an earlier one (patch semantics)", () => {
    const memory = new InMemorySessionLog();
    const ctx = mountPlugins(Context.root(), [inMemorySessionLogPlugin("first"), inMemorySessionLogPlugin("second", memory)]);
    expect(ctx.require<SessionLog>(SESSION_LOG_SERVICE)).toBe(memory);
  });

  it("keeps a scoped context falling back to the parent's log", () => {
    const memory = new InMemorySessionLog();
    const root = mountPlugins(Context.root(), [inMemorySessionLogPlugin("root", memory)]);
    const scoped = root.scoped();
    expect(scoped.require<SessionLog>(SESSION_LOG_SERVICE)).toBe(memory);
  });

  it("names the mounted plugins in mount order", () => {
    expect(pluginNames([inMemorySessionLogPlugin("a"), inMemorySessionLogPlugin("b")])).toEqual(["a", "b"]);
  });
});
