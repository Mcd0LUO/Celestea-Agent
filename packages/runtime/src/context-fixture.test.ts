/**
 * W755 acceptance 2 — fixture replay of the real harness session.
 *
 * Split out of `status.test.ts` (which the eslint `max-lines` /
 * `max-lines-per-function` budget would otherwise blow through) but the same
 * acceptance item: replay the live session whose `/api/status` reported the
 * retired口径 against the new one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelRequest, ToolSpec } from "@celestea/core";
import { deriveMessages, parseSessionJsonl } from "@celestea/session";
import {
  ContextPressure,
  createStatusTracker,
  estimatedContextChars,
  estimatedContextTokens,
  statuslineOf,
  type StatusView,
} from "./status.js";
import { UsageTracker } from "./usage.js";

// ---------------------------------------------------------------------------
// W755 acceptance 2 — fixture replay
// ---------------------------------------------------------------------------

const FIXTURE_SLUG = "harness架构哥-1788933931.279221103";
const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const fixtureDir = join(FIXTURES_DIR, "sessions", FIXTURE_SLUG);
const hasFixture = existsSync(join(fixtureDir, "cli-main.jsonl"));

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * W755 acceptance 2 — the real harness session whose live `/api/status` reported
 * `used: 565437 / ratio: 0.5654` (`fixtures/live/status.json`, the retired
 * session_event_chars口径).
 *
 * The substitute for `apps/studio/src/replay/e2e-replay.ts`: that harness needs
 * `fixtures/index.json` (the golden manifest), which this checkout does not ship,
 * so the replay is done on the same artifacts directly — the session's own
 * `cli-main.jsonl` through the REAL derive/trim/estimate path
 * (`@celestea/session` + `@celestea/agent-loop`), with the tool schemas from
 * `fixtures/live/tools.json` and the system prompt rebuilt from the live
 * `fixtures/live/prompts.json` sections (the harness prompt is request-side and
 * is not in the log).
 */
describe.skipIf(!hasFixture)("W755 fixture replay — harness架构哥", () => {
  /** A view over the fixture session, with the W755 fields filled in. */
  const fixtureView = (over: Partial<StatusView>): StatusView => ({
    model: "m",
    reasoning_effort: null,
    status: createStatusTracker(),
    usage: new UsageTracker(),
    context_window: 1_000_000,
    events: () => [],
    assembled: () => null,
    pressure: new ContextPressure(),
    ...over,
  });

  it("reports the model-visible assembly and lands the ratio in [0.07, 0.17]", () => {
    const events = parseSessionJsonl(readFileSync(join(fixtureDir, "cli-main.jsonl"), "utf8")).events;
    const tools = readJson<{ body: { tools: ToolSpec[] } }>(join(FIXTURES_DIR, "live", "tools.json")).body.tools;
    const sections = readJson<{ body: { sections: { order: number; template: string }[] } }>(
      join(FIXTURES_DIR, "live", "prompts.json"),
    ).body.sections;
    const system = [...sections].sort((a, b) => a.order - b.order).map((s) => s.template).join("\n\n");
    const request: ModelRequest = {
      model: "deepseek-v4.1-flash-expires-on-0910",
      system,
      messages: deriveMessages(events),
      tools,
      max_tokens: null,
      temperature: null,
    };

    const line = statuslineOf(fixtureView({ events: () => events, assembled: () => request }));
    const cu = line.context_usage;
    // Exactly the engine's assembly, not a char count of the log.
    expect(cu.method).toBe("assembled_estimate");
    expect(cu.used).toBe(estimatedContextTokens(request));
    expect(cu.used).toBe(155_698);
    expect(cu.window).toBe(1_000_000);
    expect(cu.window_source).toBe("profile");
    expect(cu.ratio).toBe(0.1557);
    expect(cu.ratio).toBeGreaterThanOrEqual(0.07);
    expect(cu.ratio).toBeLessThanOrEqual(0.17);

    // The retired口径 for this very fixture: 565,437 characters reported as
    // "tokens" (fixtures/live/status.json) — the 3.63x over-report.
    const chars = estimatedContextChars(events);
    expect(chars).toBeGreaterThan(560_000);
    expect(cu.used * 3).toBeLessThan(chars);
  });
});
