#!/usr/bin/env node
/**
 * 跑一道门禁，失败时把**原因**打成 GitHub annotation。
 *
 * 为什么需要它：CI 红了但 run summary 只写 "Process completed with exit code 1"，
 * 而 job 日志要 admin 权限才下得下来（GET /actions/jobs/{id}/logs → 403
 * "Must have admin rights"）。一个门禁如果红了却指不出自己是谁、为什么红，
 * 它就没起到门禁的作用。
 *
 * 做法：跑命令并透传输出；非零退出时用 GitHub 的 `::error::` workflow command
 * 把**尾部若干行**打成 annotation。annotation 走公开 API 可读
 * （GET /check-runs/{id}/annotations），于是失败原因不再依赖日志权限。
 * 取尾部是因为门禁的判词（`✗ …: 123/120 超出 3 字节`）总在最后。
 *
 * 用法：node scripts/run-gate.mjs <gate-name> -- <command and args…>
 *   例：node scripts/run-gate.mjs test -- pnpm test
 */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1) {
  console.error("usage: node scripts/run-gate.mjs <gate-name> -- <command…>");
  process.exit(2);
}
const name = argv.slice(0, sep).join(" ");
// Join into ONE string: with `shell: true` Node concatenates command+args anyway
// (and warns, DEP0190). Doing it explicitly keeps the call warning-free and makes
// the shell semantics obvious — these are our own gate commands, never user input.
const line = argv.slice(sep + 1).join(" ");

const r = spawnSync(line, { encoding: "utf8", shell: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);

if (r.status !== 0) {
  const lines = ((r.stderr || "") + "\n" + (r.stdout || ""))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const tail = lines.slice(-12).join("\n");
  // ::error:: is a GitHub workflow command → becomes a check-run annotation.
  // Escape %, CR, LF per the workflow-command spec.
  const esc = tail.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
  console.log("::error title=gate failed: " + name + "::" + esc);
  process.exit(typeof r.status === "number" ? r.status : 1);
}
console.log("✓ gate passed: " + name);
