/**
 * W767 — Studio's OWN login cookie: token minting, verification, secret file.
 *
 * The cookie gate belongs to Studio alone: this module knows nothing about any
 * other service, portal or credential store. The only external input is Studio's
 * own password file, checked in `htpasswd.ts`.
 *
 * Token wire format (four dot-separated parts, all but the expiry base64url):
 *
 *     <b64url(user)> . <b64url(rand16)> . <expUnix> . <b64url(HMAC-SHA256)>
 *
 * The signature covers the FIRST THREE parts verbatim, so neither the user, the
 * nonce nor the expiry can be edited without invalidating the cookie. The nonce
 * makes every issued token unique (no replay of a captured value into a second
 * browser). The secret is 32 random bytes kept in Studio's own data directory
 * (mode 0600); it is created on first use and reused afterwards, so a restart
 * does NOT log every user out.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

/** Cookie name (also the nginx `auth_request` marker name). */
export const AUTH_COOKIE = "studio_auth";
/** `<data dir>/studio-auth.secret` — this project's own secret, nothing else's. */
export const AUTH_SECRET_FILE = "studio-auth.secret";
/** 30 days, in seconds (the cookie's `Max-Age`). */
export const AUTH_TTL_SECONDS = 2_592_000;
/** Secret length in bytes (base64url-encoded on disk). */
export const AUTH_SECRET_BYTES = 32;
/** Upper bound on a cookie we are willing to decode (a 4-part token is ~120). */
const MAX_TOKEN_CHARS = 512;

export type TokenCheck =
  | { ok: true; user: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** base64url, no padding — the only encoding this cookie uses. */
export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** Mint one token for `user`; `nowSeconds` is unix seconds (injectable for tests). */
export function mintToken(user: string, secret: Buffer, nowSeconds: number, ttlSeconds = AUTH_TTL_SECONDS): string {
  const exp = Math.floor(nowSeconds + ttlSeconds);
  const head = `${b64url(user)}.${b64url(randomBytes(16))}.${exp}`;
  return `${head}.${b64url(signature(secret, head))}`;
}

/** Verify a token: shape, signature (constant-time) and expiry, in that order. */
export function verifyToken(token: string, secret: Buffer, nowSeconds: number): TokenCheck {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [userPart, noncePart, expPart, sigPart] = parts as [string, string, string, string];
  const expected = signature(secret, `${userPart}.${noncePart}.${expPart}`);
  const given = Buffer.from(sigPart, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  const exp = Number.parseInt(expPart, 10);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  if (exp <= Math.floor(nowSeconds)) return { ok: false, reason: "expired" };
  const user = Buffer.from(userPart, "base64url").toString("utf8");
  return user === "" ? { ok: false, reason: "malformed" } : { ok: true, user };
}

/** The `Set-Cookie` value: HttpOnly + Secure + SameSite=Lax, 30 days. */
export function authCookie(token: string): string {
  return `${AUTH_COOKIE}=${token}; Path=/; Max-Age=${AUTH_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** One cookie's raw value out of a `Cookie:` header (null when absent). */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Read the secret, creating it (32 random bytes, base64url, mode 0600) when the
 * file is missing or unusable. A short/garbled file is regenerated rather than
 * silently widening the key space.
 */
export function loadAuthSecret(path: string): Buffer {
  const existing = readSecretText(path);
  if (existing !== null) {
    const decoded = Buffer.from(existing, "base64url");
    if (decoded.length >= AUTH_SECRET_BYTES) return decoded;
  }
  const secret = randomBytes(AUTH_SECRET_BYTES);
  writeFileSync(path, `${secret.toString("base64url")}\n`, { mode: 0o600 });
  // `mode` is masked by the umask at creation; make 0600 unconditional.
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without chmod support still has the creation mode.
  }
  return secret;
}

function readSecretText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
