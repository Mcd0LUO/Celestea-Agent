#!/usr/bin/env node
/** chmod +x a built bin target (tsc emits the shebang but not the exec bit). */
import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const file = process.argv[2];
if (file === undefined || file === "") {
  console.error("usage: node scripts/make-bin-executable.mjs <file>");
  process.exit(1);
}
const path = resolve(file);
if (!existsSync(path)) {
  console.error("[make-bin-executable] missing " + path);
  process.exit(1);
}
chmodSync(path, 0o755);
console.log("[make-bin-executable] chmod 755 " + path);
