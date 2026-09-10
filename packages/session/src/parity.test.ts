/**
 * RUST PARITY — the P1 acceptance test.
 *
 * For every exported golden session it asserts, field for field:
 *   1. `deriveMessages` === the Rust engine's `derive_messages` output
 *      (`derive-messages-expected.json`, regenerated from celestea-session by a
 *      read-only probe that links crates/core + crates/session);
 *   2. `projectMessages` === the Rust Studio HTTP projection
 *      (`messages-expected.json`, fetched from GET /api/sessions/{id}/messages);
 *   3. the JSONL round-trip is byte-identical to the persisted file
 *      (`serializeSessionEvent` === the raw line, per event).
 *
 * Skipped (with a reason) when fixtures/ has not been exported yet.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstJsonDiff } from "@celestea/core";
import { deriveMessages, parseSessionJsonl, projectMessages, serializeSessionEvent } from "./index.js";

const SESSIONS_DIR = fileURLToPath(new URL("../../../fixtures/sessions", import.meta.url));
const hasFixtures = existsSync(SESSIONS_DIR);
const slugs = hasFixtures
  ? readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

function readSession(slug: string): { raw: string; goldenDerived: unknown[]; goldenStudio: unknown[] } {
  const dir = join(SESSIONS_DIR, slug);
  return {
    raw: readFileSync(join(dir, "cli-main.jsonl"), "utf8"),
    goldenDerived: (JSON.parse(readFileSync(join(dir, "derive-messages-expected.json"), "utf8")) as { messages: unknown[] })
      .messages,
    goldenStudio: (JSON.parse(readFileSync(join(dir, "messages-expected.json"), "utf8")) as { messages: unknown[] }).messages,
  };
}

describe.skipIf(!hasFixtures)("Rust parity (golden sessions)", () => {
  it("covers the exported sessions", () => {
    expect(slugs.length).toBeGreaterThanOrEqual(5);
  });

  for (const slug of hasFixtures ? slugs : []) {
    describe(slug, () => {
      const { raw, goldenDerived, goldenStudio } = readSession(slug);
      const parsed = parseSessionJsonl(raw);

      it("replays the log without a torn tail", () => {
        expect(parsed.tornTail).toBeNull();
        expect(parsed.events.length).toBeGreaterThan(0);
      });

      it("derive_messages matches the Rust engine field for field", () => {
        const actual = deriveMessages(parsed.events);
        expect(actual, "message count").toHaveLength(goldenDerived.length);
        for (let i = 0; i < goldenDerived.length; i++) {
          expect(firstJsonDiff(goldenDerived[i], actual[i], `$[${i}]`), `message ${i}`).toBeNull();
        }
      });

      it("Studio projection matches the Rust HTTP golden", () => {
        const actual = projectMessages(parsed.events);
        expect(actual, "message count").toHaveLength(goldenStudio.length);
        for (let i = 0; i < goldenStudio.length; i++) {
          expect(firstJsonDiff(goldenStudio[i], actual[i], `$[${i}]`), `message ${i}`).toBeNull();
        }
      });

      it("serializes every event back to its original JSONL line", () => {
        const lines = raw.split("\n").filter((l) => l !== "" && l !== "\r");
        expect(lines, "non-blank line count").toHaveLength(parsed.events.length);
        for (let i = 0; i < lines.length; i++) {
          expect(serializeSessionEvent(parsed.events[i]!), `line ${i + 1}`).toBe(lines[i]);
        }
      });
    });
  }
});

describe.skipIf(hasFixtures)("Rust parity (fixtures not exported)", () => {
  it("explains how to export them", () => {
    console.warn("fixtures/sessions not found - run `pnpm golden:export` to enable the parity tests");
    expect(hasFixtures).toBe(false);
  });
});
