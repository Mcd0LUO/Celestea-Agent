/**
 * Studio data stores — the public surface of this directory.
 *
 * Module map:
 *   fs-json.ts          atomic JSON read/write + dir helpers (durability map)
 *   result.ts           StoreResult / StoreFailure + `{e}` formatting
 *   session-id.ts       sanitize / parse `<ws>/<session>` / name validation
 *   mode.ts             session mode vocabulary (standard | execution, W729)
 *   session-meta.ts     `<dir>/session.json` (model + prompt binding + mode)
 *   validate.ts         model / prompt-id / url / effort validation
 *   builtin-sections.ts frozen 10-row builtin prompt registry (data only)
 *   prompts-template.ts `{{var}}` scan / validate / render
 *   prompts.ts          prompts.json + <ws>/.celestea-prompts.json registry
 *   prompts-compose.ts  build_gen assembly + active-prompt chain
 *   workspaces.ts       workspaces.json v2 registry (+ folder rename)
 *   sessions.ts         session scan / resolve / create / transcript
 *   session-ops.ts      rename / branch / archive / trash moves
 *   providers.ts        providers.json (0600) + public_view redaction
 *   provider-probe.ts   /models probe incl. keyless same-origin borrow
 */

export * from "./result.js";
export * from "./fs-json.js";
export * from "./session-id.js";
export * from "./mode.js";
export * from "./session-meta.js";
export * from "./validate.js";
export * from "./builtin-sections.js";
export * from "./prompts-template.js";
export * from "./prompts.js";
export * from "./prompts-compose.js";
export * from "./workspaces.js";
export * from "./sessions.js";
export * from "./session-ops.js";
export * from "./providers.js";
export * from "./provider-probe.js";
