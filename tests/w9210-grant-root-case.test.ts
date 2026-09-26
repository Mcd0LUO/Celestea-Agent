/**
 * W9210 (F4) — a grant root must not slip past the data-dir / `$HOME` refusals
 * by SPELLING the same path with different case on Windows.
 *
 * `realpathSync` collapses separators, `..` and symlinks but does NOT fold
 * case on Windows, so the old `===` / `isInside` string comparisons accepted a
 * case-varied grant root. The accepted root then covered
 * `<data dir>/providers.json` and the path-guard allowed writing it — a
 * privilege escalation (persist your own provider config, then read its keys).
 *
 * The suite drives the REAL HTTP grant endpoint, because that is the surface the
 * escalation is reachable from: a hand-edited `grants.json` would prove only
 * that the reader is strict, not that the UI cannot mint the entry.
 */

import { describe, expect, it } from "vitest";

import { makeHarness, grant, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { effectiveGrantsOf, insidePath, samePath } from "../apps/studio/src/runtime/engine-grants.js";

const S1 = "sample-ws%2Fs1";

/** A harness clamped to write-read so `allPaths` cannot mask the grant rule. */
function harness(): StudioHarness {
  return makeHarness({ session: { name: "s1", log: "" }, env: { CELESTEA_PERMISSION_MAX: "write-read" } });
}

async function grantRoot(h: StudioHarness, root: string): Promise<{ status: number; effective: unknown }> {
  const res = await grant(h, S1, { cap: "write_roots", scope: { roots: [root] }, ttl_sec: 0 });
  const body = res.body as Record<string, unknown>;
  const effective = (body["effective"] ?? {}) as Record<string, unknown>;
  return { status: res.status, effective: effective["write_roots"] };
}

describe("W9210 · grant roots are compared under the platform's case rules", () => {
  it("refuses the studio data directory and $HOME even when spelled with different case", async () => {
    const h = harness();
    const dataDir = h.root;

    // The exact spellings were already refused before the fix; keep them as the
    // control that the refusal itself still fires.
    const exactData = await grantRoot(h, dataDir);
    expect(exactData.status).toBe(200);
    expect(exactData.effective).toEqual([]);

    // ★ The regression: the SAME directory, different case. On Windows this was
    // accepted as a writable root; on POSIX it is a genuinely different path, so
    // the case is asserted per-platform rather than demanding a refusal the OS
    // does not warrant.
    const caseData = await grantRoot(h, dataDir.toUpperCase());
    if (process.platform === "win32") {
      expect(caseData.effective, "a case-varied data dir must not become a writable root").toEqual([]);
    } else {
      expect(caseData.status).toBe(200);
    }
    h.cleanup();
  });

  it("keeps POSIX case-sensitive: folding there would refuse the wrong directory", () => {
    // The platform seam is injected, so the win32 branch is proven on Linux too.
    expect(samePath("C:\\Users\\A", "c:\\users\\a", "win32")).toBe(true);
    expect(insidePath("C:\\Users\\A\\b", "c:\\users\\a", "win32")).toBe(true);
    // POSIX: a different case IS a different directory — never folded.
    expect(samePath("/home/A", "/home/a", "linux")).toBe(false);
    expect(insidePath("/home/a/b", "/HOME/A", "linux")).toBe(false);
  });

  it("still accepts an unrelated directory (the refusals are not a blanket ban)", async () => {
    const h = harness();
    const neutral = h.root + "-neutral";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(neutral, { recursive: true });
    const res = await grantRoot(h, neutral);
    expect(res.status).toBe(200);
    expect(res.effective).toEqual([neutral]);
    h.cleanup();
  });
});

describe("W9210 · effectiveGrantsOf applies the same rule to a hand-written file", () => {
  it("drops a case-varied $HOME root instead of honouring it", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dataDir = mkdtempSync(join(tmpdir(), "w9210-f4-"));
    const home = join(dataDir, "home");
    mkdirSync(home, { recursive: true });
    const session = join(dataDir, "ws", "s1");
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, "cli-main.jsonl"), "");
    const root = process.platform === "win32" ? home.toUpperCase() : home;
    writeFileSync(
      join(session, "grants.json"),
      JSON.stringify({
        version: 1,
        session: "ws/s1",
        updated_at: 0,
        grants: [{ id: "g1", cap: "write_roots", scope: { roots: [root] }, granted_at: 0, granted_by: "hand", expires_at: null, uses_left: null, note: "" }],
      }),
    );
    const env = { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME: home, CELESTEA_PERMISSION_MAX: "write-read" };
    const out = effectiveGrantsOf(session, "ws/s1", env, 1_700_000_500);
    if (process.platform === "win32") {
      expect(out.grants.writeRoots, "a case-varied $HOME is still $HOME").toEqual([]);
      expect(out.warnings.join(" | ")).toContain("$HOME");
    } else {
      // POSIX: the ternary above does NOT upper-case, so `root` IS `home` — the
      // exact-spelling $HOME refusal fires, the same rule as the first test's
      // control. (Case folding is a win32 concern; the POSIX half of the platform
      // seam is proven separately by the injected-`platform` assertions, which run
      // on every host.)
      //
      // The earlier version asserted `[root]` here ("a case-varied path is a
      // different directory") — unsatisfiable on Linux, because on POSIX there is
      // no case-varied spelling of the same path to accept. Caught by ubuntu CI.
      expect(out.grants.writeRoots).toEqual([]);
      expect(out.warnings.join(" | ")).toContain("$HOME");
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
});
