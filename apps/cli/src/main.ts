#!/usr/bin/env node
/**
 * `celestea` — the published CLI entry (H).
 *
 * `celestea web` boots the studio HTTP server (shared with the source entry via
 * `@celestea/studio`); `--version`/`--help` are pure. A parse error exits 2
 * with the usage line, never a silent start.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_TEXT, parseArgs } from "./args.js";
import { runWeb } from "./web.js";

/** The installed package's own version (a release tag, never a git describe). */
export function readVersion(from: string = import.meta.url): string {
  try {
    const path = fileURLToPath(new URL("../package.json", from));
    const doc = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof doc.version === "string" ? doc.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error("celestea: " + parsed.error);
  console.error("Run 'celestea --help' for usage.");
  process.exit(2);
}
if (parsed.command === "help") {
  console.log(HELP_TEXT);
} else if (parsed.command === "version") {
  console.log(readVersion());
} else {
  try {
    runWeb(parsed.options);
  } catch (e) {
    console.error("[celestea] FATAL: " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
