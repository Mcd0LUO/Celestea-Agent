/**
 * `celestea-agent` — the published CLI + cross-platform launch helpers (H).
 *
 * The executable is `dist/main.js` (bin: `celestea`); the pure helpers are
 * exported so the platform branches are unit-tested without a real browser.
 */
export * from "./args.js";
export * from "./open-browser.js";
export * from "./paths.js";
export * from "./sandbox-note.js";
export * from "./web.js";
