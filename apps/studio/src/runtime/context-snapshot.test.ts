/**
 * The context projection (W725): the flattening rules the frontend renders
 * verbatim. The engine side of the snapshot is tested in `agent-loop`; this
 * file pins what the HOST does with the engine's `Message[]`.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@celestea/core";
import { messageViews, renderContent } from "./context-snapshot.js";

/** A tool call carried by an assistant message. */
function call(id: string, name: string, args: unknown): Message {
  return { role: "assistant", content: [{ type: "tool_call", content: { id, name, args } }], tool_call_id: null };
}

describe("messageViews", () => {
  it("flattens content blocks and resolves a tool result back to its call name", () => {
    const views = messageViews([
      { role: "user", content: [{ type: "text", content: "read it" }], tool_call_id: null },
      { role: "assistant", content: [{ type: "text", content: "on it" }, { type: "tool_call", content: { id: "c1", name: "read_file", args: { path: "/tmp/x" } } }], tool_call_id: null },
      { role: "tool", content: [{ type: "text", content: "hi" }], tool_call_id: "c1" },
      { role: "tool", content: [{ type: "text", content: "orphan" }], tool_call_id: "c9" },
    ]);
    expect(views).toEqual([
      { role: "user", content: "read it" },
      { role: "assistant", content: 'on it\n[tool_call] read_file {"path":"/tmp/x"}', tool_name: "read_file", tool_call_id: "c1" },
      { role: "tool", content: "hi", tool_name: "read_file", tool_call_id: "c1" },
      { role: "tool", content: "orphan", tool_call_id: "c9" },
    ]);
  });

  it("never throws on args JSON cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(renderContent(call("c1", "run_shell", cyclic).content)).toBe("[tool_call] run_shell <unserializable args>");
    expect(renderContent(call("c2", "run_shell", undefined).content)).toBe("[tool_call] run_shell null");
  });
});
