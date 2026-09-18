/**
 * W885 — the platform seam barrel (`@celestea/tools/platform` internals).
 *
 * Three concerns, deliberately split so each file stays inside the repo's
 * 400-line / 80-line-per-function shape rules:
 *   paths.ts   platform ids, path API, PATH delimiter, PATHEXT suffixes
 *   exec.ts    shell resolution (gitbash > pwsh > cmd) + PATH lookup
 *   quote.ts   per-shell command quoting + the run_code interpreter line
 */

export * from "./paths.js";
export * from "./exec.js";
export * from "./quote.js";
