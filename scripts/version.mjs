#!/usr/bin/env node
/**
 * version.mjs — Celestea Studio 版本的**唯一真源**（W887）。
 *
 * 为什么是构建期派生而不是手写常量：版本号手写必然漂移（W887 报障：前端左上角
 * 停在 2.6.5，而 git 最新 tag 已是 v2.7.0，落后一个发布 + 33 个提交）。这里把
 * 真源钉死在 `git describe --tags --always --dirty` 上：
 *
 *   v2.7.0-33-g00de6ab-dirty  ->  tag=v2.7.0, commitsSinceTag=33, sha=00de6ab, dirty=true
 *   v2.7.0                    ->  tag=v2.7.0, commitsSinceTag=0,  sha=null,    dirty=false
 *   00de6ab（仓库无 tag）      ->  tag=null,   commitsSinceTag=null, sha=00de6ab
 *
 * 解析是**纯函数** `parseDescribe(describe)`（只吃字符串，不碰文件系统/进程），
 * 与 packages/core/src/celestea-home.ts 的注入式样板一致：git 调用与解析分离，
 * 解析的每种形态都能单测。
 *
 * 无 git / 无 tag（tarball、CI shallow clone、没有 tag 的仓库）不崩：回落到
 * apps/web/package.json 的 version，并标记 `source: 'package'`。
 *
 * 用法：
 *   node scripts/version.mjs            # 打印一行人类可读摘要
 *   node scripts/version.mjs --json     # 打印 VersionInfo JSON（供构建/服务端消费）
 *   node scripts/version.mjs --write    # 把 apps/web/package.json 的 version 写成派生值
 *   pnpm version:sync                   # 同上（根 package.json 的脚本）
 *
 * 刻意**不**挂进 pnpm check：门禁不应依赖工作树的 git 状态（dirty/提交数会漂）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件在 <repo>/scripts/version.mjs）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 回落版本的真源：前端 package.json。 */
export const WEB_PACKAGE_JSON = join(REPO_ROOT, "apps", "web", "package.json");

const DIRTY_SUFFIX = "-dirty";
const DISTANCE_RE = /^(.*)-(\d+)-g([0-9a-fA-F]+)$/;
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ABBREV_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/** 去掉 git tag 的 `v` 前缀（v2.7.0 -> 2.7.0）。 */
export function stripLeadingV(tag) {
  return typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : String(tag);
}

/**
 * 纯函数：把 `git describe --tags --always --dirty` 的输出解析成结构。
 * 无法识别（空串/异常形态）返回 null，由调用方决定回落。
 */
export function parseDescribe(describe) {
  const raw = typeof describe === "string" ? describe.trim() : "";
  if (raw === "") return null;
  let rest = raw;
  let dirty = false;
  if (rest.endsWith(DIRTY_SUFFIX)) {
    dirty = true;
    rest = rest.slice(0, -DIRTY_SUFFIX.length);
  }
  if (rest === "") return null;
  const distance = DISTANCE_RE.exec(rest);
  if (distance !== null) {
    return { tag: distance[1], commitsSinceTag: Number(distance[2]), sha: distance[3].toLowerCase(), dirty };
  }
  if (SEMVER_TAG_RE.test(rest)) {
    return { tag: rest, commitsSinceTag: 0, sha: null, dirty };
  }
  // `--always` 在仓库没有任何可达 tag 时退化成裸的短 sha。
  if (ABBREV_SHA_RE.test(rest)) {
    return { tag: null, commitsSinceTag: null, sha: rest.toLowerCase(), dirty };
  }
  // 非 semver 的 tag（例如 nightly-2026-09-19）恰好落在 tag 上。
  return { tag: rest, commitsSinceTag: 0, sha: null, dirty };
}

/** 读 package.json 的 version（读不到返回 null，绝不抛）。 */
export function readPackageVersion(packagePath = WEB_PACKAGE_JSON) {
  try {
    const raw = JSON.parse(readFileSync(packagePath, "utf8"));
    const version = typeof raw.version === "string" ? raw.version.trim() : "";
    return version === "" ? null : version;
  } catch {
    return null;
  }
}

/** 跑一次 git（找不到 git / 不是仓库 / 命令失败一律返回 null）。 */
function tryGit(cwd, env) {
  const opts = { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  try {
    const describe = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], opts).trim();
    if (describe === "") return null;
    let sha = "";
    try {
      sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], opts).trim();
    } catch {
      sha = "";
    }
    return { describe, sha };
  } catch {
    return null;
  }
}

/**
 * 计算版本信息。`cwd` = 跑 git 的目录；`env` 传给子进程（测试可借它制造无 git）；
 * `now` / `packagePath` 为可注入的测试缝。任何 git 失败都回落到 package.json。
 */
export function computeVersion(input = {}) {
  const cwd = input.cwd ?? REPO_ROOT;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const buildTime = now.toISOString();
  const pkgVersion = readPackageVersion(input.packagePath ?? WEB_PACKAGE_JSON);
  const git = tryGit(cwd, env);
  const parsed = git === null ? null : parseDescribe(git.describe);
  const sha = (parsed && parsed.sha) || (git && git.sha) || "";
  if (parsed !== null && parsed.tag !== null) {
    return {
      version: stripLeadingV(parsed.tag),
      describe: git.describe,
      sha,
      commitsSinceTag: parsed.commitsSinceTag,
      dirty: parsed.dirty,
      buildTime,
      source: "git",
      tag: parsed.tag,
    };
  }
  return {
    version: pkgVersion ?? "dev",
    describe: git === null ? "" : git.describe,
    sha,
    commitsSinceTag: parsed === null ? null : parsed.commitsSinceTag,
    dirty: parsed === null ? false : parsed.dirty,
    buildTime,
    source: "package",
    tag: null,
  };
}

/** `--write`：把 apps/web/package.json 的 version 写成派生值（保持 2 空格缩进）。 */
export function writeWebPackageVersion(info, packagePath = WEB_PACKAGE_JSON) {
  const raw = JSON.parse(readFileSync(packagePath, "utf8"));
  raw.version = info.version;
  writeFileSync(packagePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return packagePath;
}

/** CLI：默认摘要，--json 机器可读，--write 同步 package.json。 */
function main(argv) {
  const info = computeVersion();
  if (argv.includes("--write")) {
    const target = writeWebPackageVersion(info);
    console.log("[version] wrote " + info.version + " -> " + target + " (source: " + info.source + ")");
    return 0;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }
  const distance = info.commitsSinceTag === null ? "" : "+" + info.commitsSinceTag;
  const dirty = info.dirty ? "*" : "";
  console.log("[version] " + info.version + distance + dirty + "  (" + (info.describe || info.source) + ")");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
