/**
 * W9: a deterministic COMPOSE-level test of the toolDeny face filter — no HTTP
 * and no recompose timing. `engineTools` is the same assembly the host composes.
 */
import { describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import { EMPTY_GRANTS, type EffectiveGrants } from "./runtime/engine-grants.js";
import { engineTools } from "./runtime/engine-plugins.js";
import { createOfflineLlm } from "./runtime/offline-llm.js";

const profile: Profile = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 0,
  max_parallel_tool_calls: 4,
  reasoning_effort: null,
  max_output_tokens: null,
  context_window_tokens: 65_536,
  system_prompt: "test",
  request_format: "chat_completions",
  temperature: null,
};

function face(over: Partial<EffectiveGrants>): string[] {
  const grants: EffectiveGrants = { ...EMPTY_GRANTS, ...over };
  return engineTools({ profile, llm: createOfflineLlm(), workers: null, env: {}, grants }).registry.schemas().map((s) => s.name);
}

describe("W9 toolDeny face (compose-level)", () => {
  it("removes write_file from the face, and tool_extra cannot add it back", () => {
    expect(face({})).toContain("write_file");
    expect(face({ toolDeny: ["write_file"] })).not.toContain("write_file");
    expect(face({ toolDeny: ["write_file"], toolExtra: ["write_file"] })).not.toContain("write_file");
  });
});
