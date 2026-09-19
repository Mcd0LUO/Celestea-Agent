/**
 * W891 — set an env var and run a command, portably.
 *
 * Why: `CELESTEA_BUNDLE_STRICT=1 pnpm …` is POSIX shell syntax. pnpm runs package
 * scripts through `cmd.exe` on Windows (and its shell-emulator is off by default),
 * so the inline form is a hard `is not recognized as an internal or external
 * command` there — i.e. `pnpm check` could never be green on Windows, which is
 * exactly what the new windows-latest CI job measures. Passing the variable
 * through Node's own env works identically on every OS.
 *
 * Usage: node scripts/run-with-env.mjs CELESTEA_BUNDLE_STRICT=1 -- <command> [args…]
 */
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator < 0) {
  console.error("[run-with-env] usage: node scripts/run-with-env.mjs KEY=value [KEY=value…] -- <command> [args…]");
  process.exit(2);
}
const assignments = argv.slice(0, separator);
const command = argv.slice(separator + 1);
if (command.length === 0) {
  console.error("[run-with-env] missing command after --");
  process.exit(2);
}
const env = { ...process.env };
for (const assignment of assignments) {
  const at = assignment.indexOf("=");
  if (at <= 0) {
    console.error("[run-with-env] not a KEY=value assignment: " + assignment);
    process.exit(2);
  }
  env[assignment.slice(0, at)] = assignment.slice(at + 1);
}
// shell:true so pnpm (a .cmd shim on Windows) resolves like it does from a script.
const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
