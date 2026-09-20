/**
 * W892 — Windows 真机验证：CI 与 Linux 开发机都证明不了的那几条。
 *
 * 在 Windows 上跑：
 *   npx tsx scripts/verify-windows.ts
 *
 * 为什么需要它：本仓的 Windows 结论此前只来自「静态推理 + 注入式单测 + 可见门控」。
 * `pnpm check` 的 windows 任务能覆盖类型/lint/单测，但覆盖不了这些**真实 OS 行为**：
 *   1. 真实进程树回收（taskkill /T 到底收没收掉孙子进程）——单测只能证明「判定逻辑」，
 *      证明不了 taskkill 在真机上有效；
 *   2. allPaths「全权限」在工作区外真的可读写（这是 W891 报的 P0，我在 Linux 上只能推理）；
 *   3. 本机 Playwright 浏览器缓存真的能被找到（`.exe` 后缀 + 逐 OS 根目录）；
 *   4. 生产解释器解析（带空格的 `C:\\Program Files\\...` 路径）。
 *
 * 退出码：有任何 FAIL 即 1；SKIP 不算失败（但会打印原因）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { renameWithRetry } from "@celestea/core";
import {
  PathGuardPolicy,
  findHeadlessShell,
  playwrightCacheRoot,
  resolveInterpreter,
  resolveShellKind,
  taskkillTree,
} from "@celestea/tools";

type Verdict = "PASS" | "FAIL" | "SKIP";
interface Row { name: string; verdict: Verdict; detail: string }
const rows: Row[] = [];

function record(name: string, verdict: Verdict, detail: string): void {
  rows.push({ name, verdict, detail });
  const badge = verdict === "PASS" ? "[ ok ]" : verdict === "FAIL" ? "[FAIL]" : "[skip]";
  console.log(badge + " " + name + " — " + detail);
}

/** Existence check that treats EPERM as "alive but not ours to signal". */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate()` or the deadline; returns whether it became true. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

function checkPlatform(selfTest: boolean): void {
  if (process.platform === "win32") {
    record("platform", "PASS", "process.platform=win32");
    return;
  }
  record("platform", selfTest ? "SKIP" : "FAIL", "process.platform=" + process.platform + (selfTest ? " (self-test mode: win32 branches will NOT run)" : ""));
}

function checkShell(): void {
  try {
    const shell = resolveShellKind();
    record("shell resolution", "PASS", shell.kind + " -> " + shell.path + (existsSync(shell.path) ? " (exists)" : " (NOT FOUND)"));
  } catch (error) {
    record("shell resolution", "FAIL", String(error));
  }
}

function checkInterpreters(): void {
  const node = resolveInterpreter("typescript");
  record("TS interpreter", existsSync(node) ? "PASS" : "FAIL", node + (node.includes(" ") ? " (contains a space — quoting must hold)" : ""));
  const python = resolveInterpreter("python");
  record("Python interpreter", existsSync(python) ? "PASS" : "SKIP", python + (existsSync(python) ? "" : " (not installed — the Python matrix will skip)"));
}

/** The per-OS default the product must produce (only win32 is this script's job). */
function expectedCacheRoot(): string {
  if (process.platform === "win32") {
    return join(process.env["LOCALAPPDATA"] ?? join(process.env["USERPROFILE"] ?? "", "AppData", "Local"), "ms-playwright");
  }
  return join(process.env["HOME"] ?? "", ".cache", "ms-playwright");
}

function checkPlaywrightCache(): void {
  const root = playwrightCacheRoot();
  const expected = expectedCacheRoot();
  const rootOk = process.env["PLAYWRIGHT_BROWSERS_PATH"] !== undefined || root === expected;
  record("Playwright cache root", rootOk ? "PASS" : "FAIL", root + (rootOk ? "" : " (expected " + expected + ")"));
  const shell = findHeadlessShell();
  if (shell === null) {
    record("headless shell discovery", "SKIP", "no chromium_headless_shell-* under " + root + " (install Playwright browsers to exercise this)");
    return;
  }
  // The .exe suffix is the win32 half of the fix; on POSIX the binary has no suffix.
  const ok = existsSync(shell) && (process.platform !== "win32" || shell.endsWith(".exe"));
  record("headless shell discovery", ok ? "PASS" : "FAIL", shell);
}

/**
 * Recycle a whole tree the way the PRODUCT does per platform: `taskkill /T` on
 * Windows, the process-group signal on POSIX. Using the product's own
 * `taskkillTree` on win32 is the point — on Linux this branch never runs.
 */
function killTree(pid: number): boolean {
  if (process.platform === "win32") return taskkillTree(pid);
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** The real thing: a root process that forked a grandchild must BOTH die. */
async function checkTreeKill(dir: string): Promise<void> {
  const rootPidFile = join(dir, "root.pid");
  const grandPidFile = join(dir, "grand.pid");
  writeFileSync(
    join(dir, "grand.mjs"),
    ["import { writeFileSync } from 'node:fs';", "writeFileSync(process.argv[2], String(process.pid));", "setInterval(() => {}, 1000);", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "root.mjs"),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "writeFileSync(process.argv[2], String(process.pid));",
      "spawn(process.execPath, [fileURLToPath(new URL('./grand.mjs', import.meta.url)), process.argv[3]], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  // POSIX: detached so the child leads its own group (the tree-kill analogue).
  const root = spawn(process.execPath, [join(dir, "root.mjs"), rootPidFile, grandPidFile], {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  try {
    const ready = await until(() => existsSync(rootPidFile) && existsSync(grandPidFile), 8_000);
    if (!ready) {
      record("process-tree kill", "FAIL", "fixture never wrote its pid files");
      return;
    }
    const rootPid = Number(readFileSync(rootPidFile, "utf8"));
    const grandPid = Number(readFileSync(grandPidFile, "utf8"));
    if (!alive(rootPid) || !alive(grandPid)) {
      record("process-tree kill", "FAIL", "fixture pids not alive before the kill (root=" + rootPid + " grand=" + grandPid + ")");
      return;
    }
    const reported = killTree(rootPid);
    const gone = await until(() => !alive(rootPid) && !alive(grandPid), 5_000);
    record(
      "process-tree kill",
      gone ? "PASS" : "FAIL",
      "root=" + rootPid + " grand=" + grandPid + " taskkillTree=" + String(reported) + " root_alive=" + String(alive(rootPid)) + " grand_alive=" + String(alive(grandPid)),
    );
    if (!gone) {
      try { process.kill(grandPid, "SIGKILL"); } catch { /* best effort */ }
    }
  } finally {
    root.kill("SIGKILL");
  }
}

/** allPaths must open the WHOLE filesystem, not just the workspace (the W891 P0). */
function checkAllPaths(wsDir: string, outsideDir: string): void {
  const outsideFile = join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "outside\n");
  const hostRoot = parse(wsDir).root;
  const wide = new PathGuardPolicy({ workspace: wsDir, readRoots: [hostRoot], writeRoots: [hostRoot], workspaceWritable: false });
  const allowed = wide.checkRead(outsideFile).kind === "allow" && wide.checkWrite(join(outsideDir, "made.txt")).kind === "allow";
  record("allPaths host root", allowed ? "PASS" : "FAIL", "root=" + JSON.stringify(hostRoot) + " read=" + wide.checkRead(outsideFile).kind);
  // The OLD hardcoded literal must be shown to be broken ON WINDOWS. On POSIX it
  // is the correct root, so this proof is win32-only (and says so rather than
  // pretending to have checked something).
  if (process.platform !== "win32") {
    record("allPaths regression proof", "SKIP", "only meaningful on win32 (on POSIX \"/\" IS the host root)");
    return;
  }
  const buggy = new PathGuardPolicy({ workspace: wsDir, readRoots: ["/"], writeRoots: ["/"], workspaceWritable: false });
  const buggyDenies = buggy.checkRead(outsideFile).kind === "deny";
  record("allPaths regression proof", buggyDenies ? "PASS" : "FAIL", "the POSIX literal \"/\" must NOT match a Windows path (deny=" + String(buggyDenies) + ")");
}

/** A real atomic write must still move the file on Windows. */
function checkRename(dir: string): void {
  const from = join(dir, "from.txt");
  const to = join(dir, "to.txt");
  writeFileSync(from, "x");
  try {
    renameWithRetry(from, to);
    const ok = !existsSync(from) && readFileSync(to, "utf8") === "x";
    record("renameWithRetry", ok ? "PASS" : "FAIL", "moved " + from + " -> " + to);
  } catch (error) {
    record("renameWithRetry", "FAIL", String(error));
  }
}

async function main(): Promise<void> {
  console.log("=== W892 Windows 真机验证 ===");
  // `--any-platform` exists so the fixture mechanics can be SELF-TESTED on a
  // Linux box; it is not a substitute for the real Windows run (the win32-only
  // branches simply do not execute there).
  const selfTest = process.argv.includes("--any-platform");
  checkPlatform(selfTest);
  if (process.platform !== "win32" && !selfTest) {
    console.log("\nThis script is meant for a real Windows host; stopping. (Use --any-platform to self-test the fixture.)");
    process.exit(1);
  }
  checkShell();
  checkInterpreters();
  checkPlaywrightCache();
  const dir = mkdtempSync(join(tmpdir(), "w892-verify-"));
  const wsDir = mkdtempSync(join(tmpdir(), "w892-ws-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "w892-out-"));
  try {
    await checkTreeKill(dir);
    checkAllPaths(wsDir, outsideDir);
    checkRename(dir);
  } finally {
    for (const d of [dir, wsDir, outsideDir]) rmSync(d, { recursive: true, force: true });
  }
  const failed = rows.filter((r) => r.verdict === "FAIL");
  const skipped = rows.filter((r) => r.verdict === "SKIP");
  console.log("\n=== summary: " + String(rows.length - failed.length - skipped.length) + " pass / " + String(skipped.length) + " skip / " + String(failed.length) + " fail ===");
  for (const r of failed) console.log("FAIL: " + r.name + " — " + r.detail);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
