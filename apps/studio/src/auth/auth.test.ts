/**
 * W767 — the login-cookie gate's own units: token format/verification, the
 * secret file, the failure limiter, the password helper and the login page.
 * The HTTP surface is covered by `auth-http.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_COOKIE,
  AUTH_MAX_FAILURES,
  AUTH_SECRET_BYTES,
  AUTH_TTL_SECONDS,
  authCookie,
  b64url,
  cookieValue,
  createFailureLimiter,
  loadAuthSecret,
  loginPage,
  mintToken,
  verifyPassword,
  verifyToken,
} from "./index.js";

const roots: string[] = [];
const SECRET = randomBytes(AUTH_SECRET_BYTES);
const T0 = 1_700_000_000;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-auth-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** `{SHA}` htpasswd line — the format `htpasswd -s` writes, no helper needed. */
function sha1Line(user: string, password: string): string {
  return `${user}:{SHA}${createHash("sha1").update(password).digest("base64")}\n`;
}

const HAS_HTPASSWD = spawnSync("htpasswd", ["-vbi"], { encoding: "utf8" }).error === undefined;

describe("token: mint / verify", () => {
  it("round-trips the user and carries four dot-separated parts", () => {
    const token = mintToken("admin", SECRET, T0);
    expect(token.split(".")).toHaveLength(4);
    expect(verifyToken(token, SECRET, T0)).toEqual({ ok: true, user: "admin" });
    // The nonce makes every token unique, so a captured cookie is not reusable.
    expect(mintToken("admin", SECRET, T0)).not.toBe(token);
  });

  it("rejects a tampered signature, a tampered user and a foreign secret", () => {
    const token = mintToken("admin", SECRET, T0);
    const parts = token.split(".");
    expect(verifyToken(`${parts[0]}.${parts[1]}.${parts[2]}.${b64url("forged")}`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToken(`${b64url("root")}.${parts[1]}.${parts[2]}.${parts[3]}`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyToken(token, randomBytes(AUTH_SECRET_BYTES), T0)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token and malformed shapes", () => {
    const token = mintToken("admin", SECRET, T0, 60);
    expect(verifyToken(token, SECRET, T0 + 59)).toEqual({ ok: true, user: "admin" });
    expect(verifyToken(token, SECRET, T0 + 60)).toEqual({ ok: false, reason: "expired" });
    expect(verifyToken("", SECRET, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken("a.b.c", SECRET, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyToken(`${b64url("admin")}.x.notanumber.sig`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("freezes the cookie attributes (30 days, HttpOnly, Secure, SameSite=Lax, Path=/)", () => {
    const header = authCookie("t.o.k.e");
    expect(header).toBe(`${AUTH_COOKIE}=t.o.k.e; Path=/; Max-Age=${AUTH_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
    expect(cookieValue(header, AUTH_COOKIE)).toBe("t.o.k.e");
    expect(cookieValue(`other=1; ${AUTH_COOKIE}=abc; z=2`, AUTH_COOKIE)).toBe("abc");
    expect(cookieValue(undefined, AUTH_COOKIE)).toBeNull();
    expect(cookieValue("other=1", AUTH_COOKIE)).toBeNull();
  });
});

describe("secret file", () => {
  it("creates a 32-byte secret with mode 0600 and reuses it on the next load", () => {
    const path = join(tmp(), "studio-auth.secret");
    const first = loadAuthSecret(path);
    expect(first).toHaveLength(AUTH_SECRET_BYTES);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A restart must NOT log everyone out: the file is the identity of the key.
    expect(loadAuthSecret(path).equals(first)).toBe(true);
  });

  it("regenerates a garbled or widened file instead of trusting it", () => {
    const path = join(tmp(), "studio-auth.secret");
    writeFileSync(path, "short\n");
    chmodSync(path, 0o644);
    const secret = loadAuthSecret(path);
    expect(secret.length).toBeGreaterThanOrEqual(AUTH_SECRET_BYTES);
    expect(readFileSync(path, "utf8").trim()).toBe(secret.toString("base64url"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("failure limiter", () => {
  it("blocks a key after the configured failures and forgets it after the window", () => {
    let now = 1_000;
    const limiter = createFailureLimiter({ now: () => now, windowMs: 60_000, maxFailures: 3 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.blocked("u:admin")).toBe(false);
      limiter.fail("u:admin");
    }
    expect(limiter.blocked("u:admin")).toBe(true);
    expect(limiter.blocked("u:other")).toBe(false);
    now += 60_000;
    expect(limiter.blocked("u:admin")).toBe(false);
  });

  it("clears both keys of a successful attempt", () => {
    const limiter = createFailureLimiter({ now: () => 0, maxFailures: 2 });
    limiter.fail("u:admin");
    limiter.fail("ip:1.2.3.4");
    limiter.clear("u:admin");
    limiter.clear("ip:1.2.3.4");
    expect(limiter.blocked("u:admin")).toBe(false);
    expect(limiter.blocked("ip:1.2.3.4")).toBe(false);
    expect(AUTH_MAX_FAILURES).toBe(5);
  });
});

describe.skipIf(!HAS_HTPASSWD)("password helper (htpasswd -vbi)", () => {
  it("accepts the right password and denies a wrong one or an unknown user", () => {
    const file = join(tmp(), "htpasswd");
    writeFileSync(file, sha1Line("admin", "s3cret-pass"));
    expect(verifyPassword(file, "admin", "s3cret-pass")).toBe("ok");
    expect(verifyPassword(file, "admin", "nope")).toBe("denied");
    expect(verifyPassword(file, "ghost", "s3cret-pass")).toBe("denied");
  });

  it("reports an unusable store as `error` (never as a wrong password)", () => {
    const file = join(tmp(), "htpasswd");
    writeFileSync(file, sha1Line("admin", "s3cret-pass"));
    expect(verifyPassword(join(tmp(), "absent"), "admin", "s3cret-pass")).toBe("error");
    // argv safety: a username that could steer the helper is refused outright.
    expect(verifyPassword(file, "-vbi", "s3cret-pass")).toBe("denied");
    expect(verifyPassword(file, "admin", "")).toBe("denied");
  });
});

describe("login page", () => {
  it("is self-contained, posts the form, and shows the error only when given one", () => {
    const clean = loginPage();
    expect(clean).toContain('action="/auth/login"');
    expect(clean).toContain('name="username"');
    expect(clean).toContain('type="password"');
    expect(clean).not.toContain("class=\"err\"");
    expect(clean).not.toContain("<script"); // no external asset, no script on the form page
    expect(loginPage("用户名或密码不正确")).toContain('class="err"');
    // The only dynamic part is escaped (numeric entities), so it cannot break out.
    expect(loginPage("<script>alert(1)</script>")).not.toContain("<script>alert");
  });
});
