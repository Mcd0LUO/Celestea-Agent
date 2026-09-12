/**
 * W767 — password verification against Studio's OWN password file.
 *
 * `htpasswd -vbi` is used deliberately: `-b` takes the password on **stdin**
 * (never in argv, so it cannot show up in `ps`/audit logs), `-v` verifies, `-i`
 * reads stdin. The file is read-only input — Studio never writes it, and it is
 * the only credential source this module knows about.
 *
 * The username is restricted to a conservative charset: it travels in argv, and
 * a leading `-` or a newline must never be able to steer the helper.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

/** The verifier binary (net/httpd-tools `htpasswd`). */
export const HTPASSWD_BIN = "htpasswd";
/** Accepted username shape (argv-safe, 1..64 chars). */
export const HTPASSWD_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Bound the helper: a hung/absent binary must not hang a login. */
const HTPASSWD_TIMEOUT_MS = 5_000;

/**
 * `ok` = the password verified; `denied` = wrong password or unknown user (the
 * two are deliberately indistinguishable); `error` = the helper or the file is
 * unusable (an operator problem, never reported as a wrong password).
 */
export type PasswordVerdict = "ok" | "denied" | "error";

export function verifyPassword(file: string, user: string, password: string): PasswordVerdict {
  if (password === "" || !HTPASSWD_USER_RE.test(user)) return "denied";
  if (!isReadable(file)) return "error";
  const run = spawnSync(HTPASSWD_BIN, ["-vbi", file, user], {
    input: `${password}\n`,
    encoding: "utf8",
    timeout: HTPASSWD_TIMEOUT_MS,
  });
  if (run.error !== undefined) return "error";
  if (run.status === 0) return "ok";
  // 3 = password mismatch, 6 = user not found (both are "denied"); anything
  // else (4 = file error, a signal, a timeout) is an operator problem.
  return run.status === 3 || run.status === 6 ? "denied" : "error";
}

function isReadable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
