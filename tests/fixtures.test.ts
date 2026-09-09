/**
 * Golden-fixture regression tests.
 *
 * These run against fixtures/ produced by `pnpm golden:export`. They are
 * skipped (with a clear reason) when the fixtures have not been exported yet,
 * so a fresh clone still gets a green `pnpm test`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath, firstJsonDiff, SSE_EVENT_NAMES, TURN_OUTCOMES } from "@celestea/core";
import { analyzeReplay, parseSessionJsonl, projectMessages } from "@celestea/session";
import { parseRegistryTsv, serializeRegistryTsv } from "@celestea/workers";

const MANIFEST = fixturePath("index.json");
const hasFixtures = existsSync(MANIFEST);

interface Manifest {
  generatedAt: string;
  sessions: Array<{ id: string; slug: string; roles: string[]; events: number; turns: number; danglingToolCalls: number; subCalls: number }>;
  counts: { sessions: number; files: number };
  redaction: { replacements: number; byRule: Record<string, number> };
}

const manifest = hasFixtures ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : null;

describe.skipIf(!hasFixtures)("golden fixtures", () => {
  it("covers at least 3 real sessions and the 3 required behaviours", () => {
    expect(manifest!.sessions.length).toBeGreaterThanOrEqual(3);
    const roles = new Set(manifest!.sessions.flatMap((s) => s.roles));
    expect(roles.has("dangling-tool-call")).toBe(true);
    expect(roles.has("run_code-parent-id")).toBe(true);
    expect(roles.has("normal-multi-turn")).toBe(true);
  });

  it("reproduces the Rust messages projection exactly for every session", () => {
    for (const s of manifest!.sessions) {
      const dir = fixturePath("sessions", s.slug);
      const parsed = parseSessionJsonl(readFileSync(join(dir, "cli-main.jsonl"), "utf8"));
      const actual = projectMessages(parsed.events);
      const golden = (JSON.parse(readFileSync(join(dir, "messages-expected.json"), "utf8")) as { messages: unknown[] }).messages;
      expect(actual, `${s.id}: length`).toHaveLength(golden.length);
      for (let i = 0; i < golden.length; i++) {
        expect(firstJsonDiff(golden[i], actual[i], `$[${i}]`), `${s.id}: message ${i}`).toBeNull();
      }
    }
  });

  it("keeps the dangling tool_call and run_code parent_id evidence", () => {
    const dangling = manifest!.sessions.filter((s) => s.roles.includes("dangling-tool-call"));
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling.some((s) => s.danglingToolCalls > 0)).toBe(true);
    const nested = manifest!.sessions.filter((s) => s.roles.includes("run_code-parent-id"));
    expect(nested.some((s) => s.subCalls > 0)).toBe(true);
  });

  it("reports only contract outcomes and monotonic turn ids", () => {
    for (const s of manifest!.sessions) {
      const parsed = parseSessionJsonl(readFileSync(fixturePath("sessions", s.slug, "cli-main.jsonl"), "utf8"));
      const stats = analyzeReplay(parsed);
      for (const o of Object.keys(stats.outcomes)) expect(TURN_OUTCOMES).toContain(o);
      expect(stats.turnIds.malformed).toHaveLength(0);
      expect(stats.turnIds.duplicates).toHaveLength(0);
      expect(stats.turnIds.nonMonotonic).toHaveLength(0);
    }
  });

  it("exports no api key / token in cleartext", () => {
    const patterns = [/sk-[A-Za-z0-9_-]{16,}/, /npm_[A-Za-z0-9]{30,}/, /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /-auth-[A-Za-z0-9_-]{12,}/, /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(fixturePath());
    for (const f of files) {
      const text = readFileSync(f, "utf8").split("<REDACTED>").join(" ");
      for (const p of patterns) expect(p.test(text), `${f} matched ${String(p)}`).toBe(false);
    }
  });

  it("keeps the providers public_view api_key-free", () => {
    const text = readFileSync(fixturePath("providers", "public-view.json"), "utf8");
    expect(text).not.toContain('"api_key"');
  });

  it("round-trips registry.tsv byte-for-byte", () => {
    const raw = readFileSync(fixturePath("workers", "registry.tsv"), "utf8");
    expect(serializeRegistryTsv(parseRegistryTsv(raw).entries)).toBe(raw);
  });

  it("derived SSE transcripts only use contract event names", () => {
    for (const s of manifest!.sessions) {
      const p = fixturePath("sessions", s.slug, "sse-transcript-derived.jsonl");
      if (!existsSync(p)) continue; // large session: regenerated on demand
      const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        const frame = JSON.parse(line) as { event: string; data: { turn: number; seq: number; payload: unknown } };
        expect(SSE_EVENT_NAMES).toContain(frame.event as (typeof SSE_EVENT_NAMES)[number]);
        expect(typeof frame.data.turn).toBe("number");
        expect(typeof frame.data.seq).toBe("number");
        expect(typeof frame.data.payload).toBe("object");
      }
    }
  });
});

describe.skipIf(hasFixtures)("golden fixtures (not exported)", () => {
  it("explains how to export them", () => {
    expect(hasFixtures).toBe(false);
    // eslint-disable-next-line no-console
    console.warn("fixtures/ not found - run `pnpm golden:export` to enable the golden regression tests");
  });
});
