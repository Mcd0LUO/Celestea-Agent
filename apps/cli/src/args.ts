/**
 * `celestea` CLI argument parsing (H) — pure and unit-testable.
 *
 * Supported:
 *   celestea web [--port N] [--bind ADDR] [--no-open] [--token SECRET]
 *   celestea --version | -v
 *   celestea --help | -h
 *
 * Unknown flags/commands are an explicit error (never silently ignored), so a
 * typo cannot start a server on the wrong port.
 */

export const DEFAULT_PORT = 3777;
export const DEFAULT_BIND = "127.0.0.1";

export type CliCommand = "web" | "version" | "help";

export interface WebOptions {
  port: number;
  bind: string;
  open: boolean;
  /** H-security: bearer token; `undefined` = fall back to CELESTEA_AUTH_TOKEN. */
  token?: string;
}

export type ParseResult =
  | { ok: true; command: "web"; options: WebOptions }
  | { ok: true; command: "version" }
  | { ok: true; command: "help" }
  | { ok: false; error: string };

/** Parse `--port N` / `--port=N`; a non-integer or out-of-range port is an error. */
function parsePort(raw: string): { port: number } | { error: string } {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== raw.trim()) {
    return { error: `--port must be an integer between 0 and 65535 (got ${JSON.stringify(raw)})` };
  }
  return { port };
}

/** The argv after the program name, e.g. `["web", "--port", "8080"]`. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const rest = [...argv];
  const first = rest.shift();
  if (first === undefined || first === "--help" || first === "-h") return { ok: true, command: "help" };
  if (first === "--version" || first === "-v") return { ok: true, command: "version" };
  if (first !== "web") return { ok: false, error: `unknown command ${JSON.stringify(first)} (expected "web")` };

  const options: WebOptions = { port: DEFAULT_PORT, bind: DEFAULT_BIND, open: true };
  while (rest.length > 0) {
    const flag = rest.shift() as string;
    if (flag === "--no-open") {
      options.open = false;
      continue;
    }
    if (flag === "--port" || flag.startsWith("--port=")) {
      const raw = flag.includes("=") ? flag.slice("--port=".length) : (rest.shift() as string | undefined);
      if (raw === undefined) return { ok: false, error: "--port requires a value" };
      const parsed = parsePort(raw);
      if ("error" in parsed) return { ok: false, error: parsed.error };
      options.port = parsed.port;
      continue;
    }
    if (flag === "--bind" || flag.startsWith("--bind=")) {
      const raw = flag.includes("=") ? flag.slice("--bind=".length) : (rest.shift() as string | undefined);
      if (raw === undefined || raw.trim() === "") return { ok: false, error: "--bind requires a non-empty value" };
      options.bind = raw.trim();
      continue;
    }
    if (flag === "--token" || flag.startsWith("--token=")) {
      const raw = flag.includes("=") ? flag.slice("--token=".length) : (rest.shift() as string | undefined);
      if (raw === undefined || raw.trim() === "") return { ok: false, error: "--token requires a non-empty value" };
      options.token = raw.trim();
      continue;
    }
    return { ok: false, error: `unknown option ${JSON.stringify(flag)}` };
  }
  return { ok: true, command: "web", options };
}

export const HELP_TEXT = [
  "celestea — Celestea Studio agent (web UI + HTTP API)",
  "",
  "Usage:",
  "  celestea web [--port N] [--bind ADDR] [--no-open] [--token SECRET]",
  "  celestea --version",
  "  celestea --help",
  "",
  "Options:",
  `  --port N      HTTP port (default ${DEFAULT_PORT}; 0 = an ephemeral free port)`,
  `  --bind ADDR   Bind address (default ${DEFAULT_BIND}).`,
  "  --no-open     Do not open the browser",
  "  --token SEC   Require this bearer token on every /api/* request except",
  "                /api/health (also read from CELESTEA_AUTH_TOKEN).",
  "                Browser: open http://<host>:<port>/auth/token?token=<SEC> once",
  "                to set the HttpOnly session cookie, then use the UI normally.",
  "",
  "WARNING — a non-loopback --bind (0.0.0.0 / :: / a public IP) is NOT just",
  "'the web UI': it exposes FULL unauthenticated control of this machine:",
  "  · POST /api/exec runs arbitrary shell commands as this user;",
  "  · GET /api/fs/list reads any directory;",
  "  · every agent endpoint (turn, tools, sessions) is reachable.",
  "Such a bind is REFUSED unless a token is configured. Prefer --bind 127.0.0.1",
  "behind nginx (which owns the browser login gate).",
  "",
  "Data root: $CELESTEA_HOME (else $XDG_DATA_HOME/celestea, else ~/.celestea).",
  "Set the model + API key in <data root>/providers.json, or via CELESTEA_API_KEY.",
].join("\n");
