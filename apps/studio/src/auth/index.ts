/**
 * W767 — Studio's own login-cookie gate (see `docs/feature-studio-auth.md`).
 *
 * token.ts       cookie token format + secret file (0600, Studio's data dir)
 * htpasswd.ts    password verification against Studio's read-only password file
 * rate-limit.ts  per-username / per-IP failure limiter (60 s window)
 * page.ts        the self-contained login page the backend renders
 */

export * from "./token.js";
export * from "./htpasswd.js";
export * from "./rate-limit.js";
export * from "./page.js";
