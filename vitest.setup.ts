/**
 * W880 test isolation: point CELESTEA_HOME at a throwaway directory so no test
 * ever writes into the developer's (or CI user's) real data root. A FRESH
 * directory per test also keeps the canonical container (keyed by workspace
 * basename) from leaking sessions between tests that reuse a basename.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

/**
 * W1529 test hygiene: redirect `os.tmpdir()` into ONE throwaway directory per
 * test file, removed in `afterAll`.
 *
 * Why: 99 test files call `mkdtempSync(join(tmpdir(), "<prefix>-"))` 231 times
 * between them, and the great majority never remove what they made. Each full
 * `pnpm check` therefore left thousands of directories behind — measured on this
 * host: 2859 `celestea-reg-*` + 4159 `celestea-w-*` + 2912 `celestea-wd-*` …
 * (3838 root-owned `/tmp` entries in total, 4.4G of an 18G tmpfs). Fixing that
 * file-by-file would mean 99 edits with 99 chances to miss one, and any NEW test
 * could reintroduce it. Redirecting the root of `tmpdir()` covers every current
 * and future `mkdtemp(join(tmpdir(), …))` call at once.
 *
 * How it is safe:
 *   - `os.tmpdir()` reads the environment **per call**, so pointing `TMPDIR` at a
 *     fresh directory also captures `mkdtemp` in module scope / `beforeAll` (the
 *     directory already exists by then — verified: an injected-but-missing path
 *     fails with ENOENT, so we create it first).
 *   - `setupFiles` runs once per test file, so each file gets its own directory
 *     and a slow/parallel file can never see another's leftovers.
 *   - Tests that hardcode `"/tmp/…"` literals are unaffected: they name a path for
 *     the code under test to reject/quote, and never create it.
 *
 * All three variables are set because `os.tmpdir()` reads a different one per
 * platform (`TMPDIR` on POSIX; `TEMP`/`TMP` on Windows — CI runs both).
 */
const OUTER_TMP = process.env["TMPDIR"] ?? process.env["TMP"] ?? process.env["TEMP"] ?? "";
let testTmp: string | undefined;

/**
 * Reclaim directories whose owning worker died before its `afterAll`.
 *
 * `afterAll` cannot run when the worker is SIGKILLed — and some suites do exactly
 * that on purpose (the sandbox tests assert `--die-with-parent` by killing the
 * Node parent). Measured: a full `pnpm check` still left 7 directories behind,
 * all from files that kill their own process. Sweeping on startup makes the
 * scheme self-healing: the next run clears the previous run's orphans.
 *
 * Only entries matching our own prefix are touched, and only if older than an
 * hour — a directory a *concurrently running* suite just made must survive.
 */
const SWEEP_AGE_MS = 60 * 60 * 1000;
function sweepOrphaned(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("celestea-test-tmp-")) continue;
      const full = join(tmpdir(), name);
      try {
        if (Date.now() - statSync(full).mtimeMs < SWEEP_AGE_MS) continue;
        rmSync(full, { recursive: true, force: true });
      } catch {
        /* another process may be racing us for the same orphan */
      }
    }
  } catch {
    /* an unreadable tmp must never fail the suite */
  }
}

// Guard against re-entry (e.g. an outer runner that already redirected us):
// never nest our directory inside one we made.
if (process.env["CELESTEA_TEST_TMPDIR"] === undefined) {
  sweepOrphaned();
  try {
    testTmp = mkdtempSync(join(tmpdir(), "celestea-test-tmp-"));
    process.env["CELESTEA_TEST_TMPDIR"] = testTmp;
    process.env["TMPDIR"] = testTmp;
    process.env["TMP"] = testTmp;
    process.env["TEMP"] = testTmp;
  } catch {
    // A read-only tmp is not worth failing the suite over: fall back to the
    // host default and leave `os.tmpdir()` untouched.
    testTmp = undefined;
    delete process.env["CELESTEA_TEST_TMPDIR"];
  }
}

afterAll(() => {
  if (testTmp === undefined) return;
  try {
    rmSync(testTmp, { recursive: true, force: true });
  } catch {
    /* best effort: a leftover directory must never turn a green run red */
  }
  // Restore the outer environment so a second `setupFiles` pass in the same
  // process (or a reused worker) starts from the host default, not ours.
  if (OUTER_TMP === "") {
    delete process.env["TMPDIR"];
    delete process.env["TMP"];
    delete process.env["TEMP"];
  } else {
    process.env["TMPDIR"] = OUTER_TMP;
    process.env["TMP"] = OUTER_TMP;
    process.env["TEMP"] = OUTER_TMP;
  }
  delete process.env["CELESTEA_TEST_TMPDIR"];
});

/**
 * i18n（P0/P1）：前端既有断言写的是**中文文案**（产品默认语言）。jsdom 的
 * navigator.language 是 en-US、Node 21+ 也带 navigator.language ⇒ i18n 会判成英文，
 * 与既有断言冲突。这里把 navigator.language 固定为 zh-CN，让 i18n 默认中文。
 * （i18n 自己的单测会显式 stub navigator / 清 localStorage，不受影响。）
 */
try {
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN", languages: ["zh-CN", "zh"] },
    configurable: true,
    writable: true,
  });
} catch {
  /* 环境不允许覆盖 navigator：i18n 回落默认中文 */
}

let home: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "celestea-home-test-"));
  process.env.CELESTEA_HOME = home;
});

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

