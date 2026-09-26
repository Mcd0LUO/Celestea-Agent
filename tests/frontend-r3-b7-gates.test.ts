/**
 * R3 W838 · B7 —— 前端门禁工具（第 9 批）。
 * 来源：/server-center/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 *   的 B7 验收探针：
 *   F6/N3：STRICT=1 时「可收紧项（tighten）」必须与陈旧项一样失败，且输出与退出码一致。
 *   F7：apps/web 的 check 必须内置 CELESTEA_BUNDLE_STRICT=1（dist 缺失不再静默退出 0）。
 * 方式：把**真实门禁脚本**复制到临时目录（同内容、不同 ROOT），用真实 node 子进程跑真实脚本；
 * 断言退出码与输出，不 mock 门禁逻辑本身。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "apps", "web", "tools");
const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "w838-gate-"));
  mkdirSync(join(dir, "tools"), { recursive: true });
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function run(script: string, env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** 临时模块树：一个 450 行文件 + 登记上限 500 = 纯 tighten（>400 默认上限，<500 登记上限）。 */
function tightenSandbox(): string {
  const dir = sandbox();
  copyFileSync(join(TOOLS, "check-module-size.mjs"), join(dir, "tools", "check-module-size.mjs"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const body = Array.from({ length: 450 }, (_, i) => "export const v" + i + " = " + i + ";").join("\n") + "\n";
  writeFileSync(join(dir, "src", "big.ts"), body);
  writeFileSync(
    join(dir, "tools", "module-size-baseline.json"),
    JSON.stringify({ kind: "frontend-module-size-baseline", defaultLimit: 400, limits: { "src/big.ts": 500 } }),
  );
  return dir;
}

describe("R3 W838-F6/N3 · module-size STRICT 拦 tighten", () => {
  it("tighten-only 时 STRICT=1 退出 1，输出与退出码一致", () => {
    const script = join(tightenSandbox(), "tools", "check-module-size.mjs");
    const plain = run(script);
    expect(plain.code).toBe(0); // 非 STRICT：只报警
    expect(plain.out).toContain("可收紧");
    const strict = run(script, { CELESTEA_MODULE_SIZE_STRICT: "1" });
    expect(strict.code).toBe(1); // F6：tighten 也进 STRICT 失败集合
    expect(strict.out).toContain("可收紧项");
    expect(strict.out).toContain("STRICT=1");
  });
});

describe("R3 W838-F7 · web check 内置 BUNDLE STRICT", () => {
  it("check 脚本含 CELESTEA_BUNDLE_STRICT=1，无 dist 时脚本退出 1", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "apps", "web", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["check"]).toContain("CELESTEA_BUNDLE_STRICT=1");
    const dir = sandbox();
    copyFileSync(join(TOOLS, "check-bundle-size.mjs"), join(dir, "tools", "check-bundle-size.mjs"));
    writeFileSync(
      join(dir, "tools", "bundle-size-baseline.json"),
      JSON.stringify({ kind: "frontend-bundle-size-baseline", gzipLevel: 9, gzip: { js: 1, css: 1 } }),
    );
    const script = join(dir, "tools", "check-bundle-size.mjs");
    const plain = run(script);
    expect(plain.code).toBe(0); // 未构建：非 STRICT 只提示跳过
    expect(plain.out).toContain("跳过");
    const strict = run(script, { CELESTEA_BUNDLE_STRICT: "1" });
    expect(strict.code).toBe(1); // F7：check 走 STRICT → dist 缺失即失败
    expect(strict.out).toContain("dist/assets 不存在");
  });
});

/**
 * W9112 follow-up · 产物体积门禁的**跨平台容差**。
 *
 * 为什么需要这组断言：CI 实测 ubuntu 的 css 合计 gzip 比 windows 大 2 字节
 * （raw 完全相同），根因是 esbuild 的原生二进制与 zlib 实现都按平台分。容差
 * 一旦没有边界断言，它就会慢慢变成「随便超都不红」——那等于删掉门禁。
 *
 * 三条边界，缺一不可：
 *   ① 容差内（超出 2）⇒ 通过（exit 0），且**如实打印** ⚠（不许静默）；
 *   ② 容差外（超出 129）⇒ 失败（exit 1）；
 *   ③ 恰好等于容差（超出 128）⇒ 通过（闭区间上界，边界值写进断言）。
 */
function bundleSandbox(limitCss: number): string {
  const dir = sandbox();
  copyFileSync(join(TOOLS, "check-bundle-size.mjs"), join(dir, "tools", "check-bundle-size.mjs"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  // 一个可压缩的确定性产物；具体字节数不重要，门禁比的是「实际 vs 上限」。
  // Must gzip to > 128 bytes so that a "beyond tolerance" limit stays POSITIVE
  // (the gate rejects a non-positive baseline, which would test the wrong path).
  writeFileSync(join(dir, "dist", "assets", "index-abc.css"), "abcdefghij".repeat(8192));
  writeFileSync(
    join(dir, "tools", "bundle-size-baseline.json"),
    JSON.stringify({ kind: "frontend-bundle-size-baseline", gzipLevel: 9, gzip: { js: 1_000_000, css: limitCss } }),
  );
  return join(dir, "tools", "check-bundle-size.mjs");
}

describe("W9112 follow-up · bundle-size 跨平台容差（边界有牙）", () => {
  it("① 容差内（超出 2 字节）⇒ 通过，但如实打印 ⚠（不静默）", () => {
    // 先量出真实 gzip，再把上限设成「真实 - 2」制造「超出 2」。
    const probe = bundleSandbox(1_000_000); // huge limit: the gate passes and prints the real number
    const gz = Number(/css (\d+)\//.exec(run(probe).out)?.[1] ?? 0);
    expect(gz, "探针要能量到真实 css gzip").toBeGreaterThan(0);
    const script = bundleSandbox(gz - 2);
    const r = run(script);
    expect(r.code).toBe(0);
    expect(r.out).toContain("容差");
    expect(r.out).toContain("平台噪声");
  });

  it("② 容差外（超出 129 字节）⇒ 失败", () => {
    const probe = bundleSandbox(1_000_000); // huge limit: the gate passes and prints the real number
    const gz = Number(/css (\d+)\//.exec(run(probe).out)?.[1] ?? 0);
    const script = bundleSandbox(gz - 129);
    const r = run(script);
    expect(r.code).toBe(1);
    expect(r.out).toContain("未通过");
  });

  it("③ 恰好等于容差（超出 128 字节）⇒ 通过（闭区间上界）", () => {
    const probe = bundleSandbox(1_000_000); // huge limit: the gate passes and prints the real number
    const gz = Number(/css (\d+)\//.exec(run(probe).out)?.[1] ?? 0);
    const script = bundleSandbox(gz - 128);
    const r = run(script);
    expect(r.code).toBe(0);
  });
});
