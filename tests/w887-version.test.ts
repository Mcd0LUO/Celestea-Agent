/**
 * W887 — 版本号单一真源（git tag）+ 防漂移门禁。
 *
 * 红→绿覆盖：
 *   · parseDescribe 的四种 describe 形态（恰好 tag / 带提交数 / dirty / 无 tag）；
 *   · 无 git（PATH 里没有 git）与无 tag（不在仓库里）时回落 package.json；
 *   · apps/web/src/version.ts 不再出现硬编码的 x.y.z 字面量；
 *   · 构建产物（dist/assets/*.js）里是当前派生值，不是旧常量；
 *   · /api/health.version 非空且与脚本计算一致。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeVersion, parseDescribe, REPO_ROOT, WEB_PACKAGE_JSON } from "../scripts/version.mjs";
import { makeHarness } from "../apps/studio/src/harness.test-util.js";

const pkgVersion = (): string => JSON.parse(readFileSync(WEB_PACKAGE_JSON, "utf8")).version;

const gitDescribe = (): string => {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const DESCRIBE = gitDescribe();
const PARSED = parseDescribe(DESCRIBE);

describe("W887 parseDescribe (pure function)", () => {
  it("parses a describe exactly on a tag", () => {
    expect(parseDescribe("v2.7.0")).toEqual({ tag: "v2.7.0", commitsSinceTag: 0, sha: null, dirty: false });
  });

  it("parses N commits after a tag", () => {
    expect(parseDescribe("v2.7.0-33-g00de6ab")).toEqual({ tag: "v2.7.0", commitsSinceTag: 33, sha: "00de6ab", dirty: false });
  });

  it("parses the dirty suffix on both forms", () => {
    expect(parseDescribe("v2.7.0-33-g00de6ab-dirty")).toEqual({ tag: "v2.7.0", commitsSinceTag: 33, sha: "00de6ab", dirty: true });
    expect(parseDescribe("v2.7.0-dirty")).toEqual({ tag: "v2.7.0", commitsSinceTag: 0, sha: null, dirty: true });
  });

  it("parses a repo with no tag (bare abbreviated sha)", () => {
    expect(parseDescribe("00de6ab")).toEqual({ tag: null, commitsSinceTag: null, sha: "00de6ab", dirty: false });
    expect(parseDescribe("00de6ab-dirty")).toEqual({ tag: null, commitsSinceTag: null, sha: "00de6ab", dirty: true });
  });

  it("keeps hyphens inside the tag name", () => {
    expect(parseDescribe("nightly-2026-09-19-4-g00de6ab")).toEqual({ tag: "nightly-2026-09-19", commitsSinceTag: 4, sha: "00de6ab", dirty: false });
  });

  it("returns null for empty / unrecognizable input (never throws)", () => {
    expect(parseDescribe("")).toBeNull();
    expect(parseDescribe("   ")).toBeNull();
    expect(parseDescribe("-dirty")).toBeNull();
  });
});

describe("W887 computeVersion fallback (no git / no tag)", () => {
  it("falls back to apps/web/package.json when git is not on PATH", () => {
    const info = computeVersion({ cwd: REPO_ROOT, env: { PATH: "/nonexistent-w887" }, packagePath: WEB_PACKAGE_JSON });
    expect(info.source).toBe("package");
    expect(info.version).toBe(pkgVersion());
  });

  it("falls back when cwd is not inside a git repo", () => {
    const info = computeVersion({ cwd: tmpdir(), env: process.env, packagePath: WEB_PACKAGE_JSON });
    expect(info.source).toBe("package");
    expect(info.version).toBe(pkgVersion());
  });
});

describe("W887 computeVersion from git", () => {
  it.skipIf(PARSED === null || PARSED.tag === null)("matches git describe in this repo", () => {
    const info = computeVersion({ cwd: REPO_ROOT });
    expect(info.source).toBe("git");
    expect(info.describe).toBe(DESCRIBE);
    expect(info.version).toBe(String(PARSED?.tag).replace(/^v/, ""));
    expect(info.commitsSinceTag).toBe(PARSED?.commitsSinceTag);
    expect(info.dirty).toBe(PARSED?.dirty);
  });
});

describe("W887 anti-drift", () => {
  const versionSrc = readFileSync(join(REPO_ROOT, "apps", "web", "src", "version.ts"), "utf8");

  it("apps/web/src/version.ts has no hardcoded semver literal", () => {
    expect(versionSrc).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("reads the injected globals and degrades to dev, never undefined", () => {
    expect(versionSrc).toContain("__APP_VERSION__");
    expect(versionSrc).toContain("__APP_COMMITS__");
    expect(versionSrc).toContain("__APP_SHA__");
    expect(versionSrc).toContain("__APP_DIRTY__");
    expect(versionSrc).toContain("__BUILD_TIME__");
    expect(versionSrc).toContain("'dev'");
  });

  it("vite.config.ts injects the derived values via define (no hardcoded version)", () => {
    const vite = readFileSync(join(REPO_ROOT, "apps", "web", "vite.config.ts"), "utf8");
    expect(vite).toContain("computeVersion");
    for (const key of ["__APP_VERSION__", "__APP_COMMITS__", "__APP_SHA__", "__APP_DIRTY__", "__BUILD_TIME__"]) {
      expect(vite).toContain(key);
    }
    expect(vite).not.toMatch(/'2\.\d+\.\d+'/);
  });
});

describe("W887 build product carries the CURRENT derived version", () => {
  const distAssets = join(REPO_ROOT, "apps", "web", "dist", "assets");
  const built = existsSync(distAssets)
    ? readdirSync(distAssets)
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFileSync(join(distAssets, f), "utf8"))
        .join("\n")
    : "";

  it.skipIf(built === "")("the bundle contains the git-derived version, not the old literal", () => {
    const info = computeVersion();
    expect(info.source).toBe("git");
    expect(built).toContain("Studio v");
    expect(built).toContain(info.version);
    expect(built).not.toContain("2.6.5");
  });
});

describe("W887 /api/health.version", () => {
  const harness = makeHarness({ session: { name: "sample-session", log: "" } });

  it("is non-empty and equals the script's derived version", async () => {
    const res = await harness.app.request("/api/health");
    const body = (await res.json()) as { version?: unknown };
    expect(typeof body.version).toBe("string");
    expect(String(body.version).length).toBeGreaterThan(0);
    expect(body.version).toBe(computeVersion().version);
  });
});
