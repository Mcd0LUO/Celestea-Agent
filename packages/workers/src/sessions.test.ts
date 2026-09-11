import { describe, expect, it } from "vitest";
import { recordingSessionLog } from "./log.js";
import { SessionRegistry } from "./sessions.js";

describe("SessionRegistry", () => {
  it("creates sessions with sequential session-<n> ids", () => {
    const reg = new SessionRegistry();
    const a = reg.create({ title: "W1·first" });
    const b = reg.create({ title: "W2·second", workspace: "/ws/p", model: "m" });
    expect(a.meta.id).toBe("session-0");
    expect(b.meta.id).toBe("session-1");
    expect(b.meta.workspace).toBe("/ws/p");
    expect(reg.size).toBe(2);
  });

  it("gives every session its own log from the injected factory", () => {
    const reg = new SessionRegistry({ logFactory: recordingSessionLog });
    const a = reg.create({ title: "a" });
    const b = reg.create({ title: "b" });
    a.log.append({ type: "user_message", text: "in a" });
    expect(reg.logOf(a.meta.id)?.events()).toHaveLength(1);
    expect(reg.logOf(b.meta.id)?.events()).toHaveLength(0);
    expect(reg.logOf("session-404")).toBeUndefined();
  });

  it("registers an externally built session (the host conversation)", () => {
    const reg = new SessionRegistry();
    reg.register({ meta: { id: "cli-main", title: "cli-main", workspace: null, model: "m", mode: null }, log: recordingSessionLog() });
    expect(reg.get("cli-main")?.meta.id).toBe("cli-main");
    expect(reg.resolve("cli-main").session?.meta.id).toBe("cli-main");
  });

  it("resolves by id first, then by unique title, then by workspace", () => {
    const reg = new SessionRegistry();
    const a = reg.create({ title: "W101·alpha", workspace: "/ws/alpha" });
    reg.create({ title: "W102·beta" });
    expect(reg.resolve(a.meta.id).session?.meta.id).toBe(a.meta.id);
    expect(reg.resolve("W101·alpha").session?.meta.id).toBe(a.meta.id);
    expect(reg.resolve("/ws/alpha").session?.meta.id).toBe(a.meta.id);
  });

  it("reports an ambiguous target with its candidates instead of guessing", () => {
    const reg = new SessionRegistry();
    const a = reg.create({ title: "same", workspace: "/ws/x" });
    const b = reg.create({ title: "same", workspace: "/ws/y" });
    const result = reg.resolve("same");
    expect(result.error?.kind).toBe("ambiguous");
    expect(reg.resolve("/ws/x").session?.meta.id).toBe(a.meta.id);
    const candidates = result.error?.kind === "ambiguous" ? result.error.candidates : [];
    expect(candidates.map((c) => c.id).sort()).toEqual([a.meta.id, b.meta.id].sort());
  });

  it("reports a not-found target", () => {
    const reg = new SessionRegistry();
    expect(reg.resolve("nope").error).toEqual({ kind: "not_found", target: "nope" });
  });

  it("removes, lists and clears sessions", () => {
    const reg = new SessionRegistry({ prefix: "s" });
    const a = reg.create({ title: "a" });
    expect(a.meta.id).toBe("s0");
    expect(reg.metas()).toHaveLength(1);
    expect(reg.remove(a.meta.id)).toBe(true);
    expect(reg.remove(a.meta.id)).toBe(false);
    reg.create({ title: "b" });
    reg.clear();
    expect(reg.size).toBe(0);
  });
});
