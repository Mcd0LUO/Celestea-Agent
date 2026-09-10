/**
 * `@celestea/studio` — the L3 host application (Hono HTTP layer + data stores).
 *
 * Module map:
 *   app.ts                  createStudioApp: compose + 39 routes + static/SPA
 *   routes.ts               the frozen contract route table (id -> method+path)
 *   config.ts               host paths + the constants Rust hardcodes
 *   runtime-adapter.ts      the ONE engine seam (RuntimeAdapter interface)
 *   fake-runtime-adapter.ts scripted P4 stand-in for the engine
 *   sse.ts                  SSE bus: envelope / 8 events / lagged degradation
 *   static.ts               read-only Vite build + traversal hardening
 *   plugins.ts              compose root: store plugins -> Context services
 *   settings.ts             host-side system_prompt / base_url overrides
 *   handlers/               one module per endpoint group
 *   store/                  data stores (workspaces / providers / prompts)
 */

export * from "./routes.js";
export * from "./config.js";
export * from "./runtime-adapter.js";
export * from "./fake-runtime-adapter.js";
export * from "./sse.js";
export * from "./static.js";
export * from "./settings.js";
export * from "./plugins.js";
export * from "./app.js";
export * from "./store/index.js";
