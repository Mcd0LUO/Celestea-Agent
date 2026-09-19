import { describe, expect, it } from "vitest";
import {
  apiTokenCookie,
  assertBindIsSafe,
  AUTH_TOKEN_COOKIE,
  AUTH_TOKEN_HEADER,
  cookieMatches,
  InsecureBindError,
  isLoopbackBind,
  presentedToken,
  readAuthToken,
  tokenCookieValue,
  tokensMatch,
} from "./api-token.js";

describe("isLoopbackBind", () => {
  it("accepts only addresses that cannot be reached remotely", () => {
    for (const bind of ["127.0.0.1", "127.0.0.1:3777", "localhost", "::1", "[::1]:3777", "127.0.0.5", "::ffff:127.0.0.1"]) {
      expect(isLoopbackBind(bind), bind).toBe(true);
    }
    for (const bind of ["0.0.0.0", "0.0.0.0:3777", "::", "192.168.1.5", "10.0.0.1", "example.com"]) {
      expect(isLoopbackBind(bind), bind).toBe(false);
    }
  });
});

describe("presentedToken / tokensMatch", () => {
  it("reads the x-celestea-token header and Authorization: Bearer", () => {
    expect(presentedToken(undefined, "s3cret")).toBe("s3cret");
    expect(presentedToken("Bearer s3cret", undefined)).toBe("s3cret");
    expect(presentedToken("bearer s3cret", undefined)).toBe("s3cret");
    expect(presentedToken("Basic s3cret", undefined)).toBeNull();
    expect(presentedToken(undefined, undefined)).toBeNull();
    expect(presentedToken(undefined, "  ")).toBeNull();
  });
  it("compares exactly (length mismatch and content mismatch are false)", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("readAuthToken", () => {
  it("reads CELESTEA_AUTH_TOKEN, treating blank as unset", () => {
    expect(readAuthToken({ CELESTEA_AUTH_TOKEN: "tok" })).toBe("tok");
    expect(readAuthToken({ CELESTEA_AUTH_TOKEN: "  " })).toBeNull();
    expect(readAuthToken({})).toBeNull();
  });
});

describe("assertBindIsSafe (fail-closed)", () => {
  it("refuses a non-loopback bind with no token, with actionable guidance", () => {
    expect(() => assertBindIsSafe("0.0.0.0", null)).toThrow(InsecureBindError);
    try {
      assertBindIsSafe("0.0.0.0", null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      expect(message).toContain("refusing to bind 0.0.0.0 without authentication");
      expect(message).toContain("/api/exec");
      expect(message).toContain("--token");
      expect(message).toContain("--bind 127.0.0.1");
    }
  });
  it("allows a non-loopback bind once a token is set", () => {
    expect(() => assertBindIsSafe("0.0.0.0", "tok")).not.toThrow();
  });
  it("allows loopback with no token (existing deployments untouched)", () => {
    expect(() => assertBindIsSafe("127.0.0.1", null)).not.toThrow();
    expect(() => assertBindIsSafe("::1", null)).not.toThrow();
  });
  it("exposes the header name the middleware reads", () => {
    expect(AUTH_TOKEN_HEADER).toBe("x-celestea-token");
  });
});

describe("the bootstrap cookie (browser path)", () => {
  const TOKEN = "s3cret";

  it("stores an HMAC of the token, never the plaintext token", () => {
    const value = tokenCookieValue(TOKEN);
    expect(value).not.toBe(TOKEN);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, so the middleware can recompute it without storing state.
    expect(tokenCookieValue(TOKEN)).toBe(value);
    expect(tokenCookieValue("other")).not.toBe(value);
  });

  it("cookieMatches accepts only the right cookie value", () => {
    expect(cookieMatches(tokenCookieValue(TOKEN), TOKEN)).toBe(true);
    expect(cookieMatches("deadbeef", TOKEN)).toBe(false);
    expect(cookieMatches(null, TOKEN)).toBe(false);
    expect(cookieMatches(undefined, TOKEN)).toBe(false);
    expect(cookieMatches("", TOKEN)).toBe(false);
  });

  it("sets HttpOnly + SameSite=Strict + Path=/ and omits Secure over plain HTTP", () => {
    const cookie = apiTokenCookie(TOKEN, false);
    expect(cookie.startsWith(`${AUTH_TOKEN_COOKIE}=`)).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain(TOKEN);
  });

  it("adds Secure only behind TLS (nginx x-forwarded-proto)", () => {
    expect(apiTokenCookie(TOKEN, true)).toContain("Secure");
  });
});
