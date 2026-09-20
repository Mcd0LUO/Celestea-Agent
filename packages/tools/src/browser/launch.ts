/**
 * Browser launch / attach (F4 slice 1).
 *
 * Two entry points:
 * - launchBrowser(): spawn chrome-headless-shell with
 *   --headless --no-sandbox --remote-debugging-port=0 --user-data-dir=<tmp>,
 *   read the ws:// DevTools endpoint off stderr, and return a handle whose
 *   close() reclaims the whole process tree and removes the profile dir.
 * - attachBrowser(): connect to an externally supplied --cdp-endpoint (future
 *   real Chrome / a browser the operator started).
 *
 * The executable path, the process spawner and the transport opener are all
 * injectable, so the module is unit-testable without a browser and can grow a
 * platform-specific locator later without touching this logic.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { isWindows, pathApi } from "../platform/paths.js";
import { taskkillTree } from "../sandbox/child.js";
import { CdpClient, openWebSocketTransport, type CdpTransport, type OpenTransportOptions } from "./cdp.js";

/** Default time to wait for the DevTools endpoint. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
/** Default grace between SIGTERM and SIGKILL when closing. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
/** Flags every launched browser gets (callers append via extraArgs). */
export const DEFAULT_BROWSER_ARGS: readonly string[] = [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--remote-debugging-port=0",
];
/** The stderr marker that carries the endpoint. */
export const ENDPOINT_MARKER = "DevTools listening on ";

/** No headless-shell executable could be located. */
export class BrowserNotFoundError extends Error {
  readonly code = "browser_not_found";
  constructor(message: string) {
    super(message);
    this.name = "BrowserNotFoundError";
  }
}

/** The browser died (or stayed silent) before it printed an endpoint. */
export class BrowserStartupError extends Error {
  readonly code = "browser_startup";
  readonly stderrTail: string;
  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = "BrowserStartupError";
    this.stderrTail = stderrTail;
  }
}

/** The minimal process surface launch/close needs (spawn is injectable). */
export interface BrowserProcess {
  pid?: number | undefined;
  stderr: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** How a browser process is created (tests inject a fake). */
export type BrowserSpawn = (program: string, args: readonly string[]) => BrowserProcess;

export interface FindShellInput {
  root?: string;
  platform?: string;
  arch?: string;
  /** Injected env for the \`PLAYWRIGHT_BROWSERS_PATH\` override; defaults to \`process.env\`. */
  env?: Record<string, string | undefined>;
  /** Injected home dir for the default cache root; defaults to \`os.homedir()\`. */
  homedir?: string;
  list?: (dir: string) => string[];
  exists?: (path: string) => boolean;
}

export interface AttachOptions {
  openTransport?: (url: string, options?: OpenTransportOptions) => Promise<CdpTransport>;
  clientTimeoutMs?: number;
}

export interface LaunchOptions extends AttachOptions {
  executablePath?: string;
  userDataDir?: string;
  extraArgs?: readonly string[];
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  spawn?: BrowserSpawn;
  findExecutable?: () => string | null;
  /** W892: injected teardown (tests pin the platform so the branch is host-independent). */
  signal?: SignalBrowserDeps;
}

/** A browser connected over CDP; close() also reclaims the process. */
export interface LaunchedBrowser {
  endpoint: string;
  pid: number | null;
  userDataDir: string;
  client: CdpClient;
  close(): Promise<void>;
}

/** An externally launched browser (no process we own). */
export interface AttachedBrowser {
  endpoint: string;
  client: CdpClient;
  close(): void;
}

/** The ws:// endpoint in a stderr buffer, or null. */
export function parseDevToolsEndpoint(stderr: string): string | null {
  const at = stderr.indexOf(ENDPOINT_MARKER);
  if (at < 0) return null;
  const rest = stderr.slice(at + ENDPOINT_MARKER.length).trimStart();
  const match = /^(ws:\S+)/.exec(rest);
  return match === null ? null : match[1]!;
}

/** Playwright's per-platform subdirectory under a chromium_headless_shell-* dir. */
export function headlessShellSubdir(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "win32") return "chrome-headless-shell-win64";
  if (platform === "darwin") return arch === "arm64" ? "chrome-headless-shell-mac-arm64" : "chrome-headless-shell-mac-x64";
  return arch === "arm64" ? "chrome-headless-shell-linux-arm64" : "chrome-headless-shell-linux64";
}

/**
 * The Playwright browser cache root for a platform (W891 Windows slice).
 *
 * Playwright resolves its cache per OS — \`%LOCALAPPDATA%\\ms-playwright\` on
 * Windows, \`~/Library/Caches/ms-playwright\` on macOS, \`~/.cache/ms-playwright\`
 * elsewhere — and \`PLAYWRIGHT_BROWSERS_PATH\` overrides all three. Before this the
 * locator hardcoded the Linux path, so a Windows host with a normal Playwright
 * install reported "browser not found". Inputs are injectable (the W885 seam) so
 * the win32 branch is unit-testable on Linux.
 */
export function playwrightCacheRoot(
  input: { root?: string; platform?: string; env?: Record<string, string | undefined>; homedir?: string } = {},
): string {
  if (input.root !== undefined) return input.root;
  const env = input.env ?? process.env;
  const override = env["PLAYWRIGHT_BROWSERS_PATH"];
  if (override !== undefined && override.trim() !== "") return override.trim();
  const platform = input.platform ?? process.platform;
  const home = input.homedir ?? homedir();
  const join = pathApi(platform).join;
  if (platform === "win32") return join(home, "AppData", "Local", "ms-playwright");
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  return join(home, ".cache", "ms-playwright");
}

/** Highest-versioned chrome-headless-shell under the Playwright cache. */
export function findHeadlessShell(input: FindShellInput = {}): string | null {
  const platform = input.platform ?? process.platform;
  const root = playwrightCacheRoot({
    ...(input.root === undefined ? {} : { root: input.root }),
    platform,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.homedir === undefined ? {} : { homedir: input.homedir }),
  });
  const list = input.list ?? defaultList;
  const exists = input.exists ?? existsSync;
  const subdir = headlessShellSubdir(platform, input.arch ?? process.arch);
  const join = pathApi(platform).join;
  const versions = list(root).filter((name) => name.startsWith("chromium_headless_shell-")).sort(compareVersionDesc);
  // Windows ships the same binary with a .exe suffix; the rest of the layout is identical.
  const binary = isWindows(platform) ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  for (const version of versions) {
    const candidate = join(root, version, subdir, binary);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function defaultList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function compareVersionDesc(a: string, b: string): number {
  return versionTail(b) - versionTail(a);
}

function versionTail(name: string): number {
  const match = /-(\d+)$/.exec(name);
  return match === null ? -1 : Number(match[1]);
}

/** Attach to an already-running CDP endpoint. */
export async function attachBrowser(endpoint: string, options: AttachOptions = {}): Promise<AttachedBrowser> {
  const open = options.openTransport ?? openWebSocketTransport;
  const transport = await open(endpoint);
  const client = new CdpClient({ transport, timeoutMs: options.clientTimeoutMs });
  return { endpoint, client, close: () => client.close() };
}

/** Spawn a browser, wait for its endpoint, attach. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const executable = resolveExecutable(options);
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "celestea-browser-"));
  const ownsDir = options.userDataDir === undefined;
  const grace = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const args = [...DEFAULT_BROWSER_ARGS, "--user-data-dir=" + userDataDir, ...(options.extraArgs ?? []), "about:blank"];
  const proc = (options.spawn ?? defaultBrowserSpawn)(executable, args);
  let endpoint: string;
  try {
    endpoint = await readEndpoint(proc, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  } catch (error) {
    await terminateBrowserProcess(proc, grace, options.signal);
    if (ownsDir) removeDir(userDataDir);
    throw error;
  }
  const attached = await attachBrowser(endpoint, options);
  return {
    endpoint,
    pid: proc.pid ?? null,
    userDataDir,
    client: attached.client,
    close: async () => {
      attached.close();
      await terminateBrowserProcess(proc, grace, options.signal);
      if (ownsDir) removeDir(userDataDir);
    },
  };
}

function resolveExecutable(options: LaunchOptions): string {
  // An injected locator is authoritative (a null from it means "none"), so a
  // test can force the not-found path without touching the real cache.
  const found = options.executablePath ?? (options.findExecutable === undefined ? findHeadlessShell() : options.findExecutable());
  if (found === null || found === undefined || found === "") {
    throw new BrowserNotFoundError("no chrome-headless-shell found; pass executablePath or install Playwright chromium");
  }
  return found;
}

function readEndpoint(proc: BrowserProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (endpoint: string | null, error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve(endpoint as string);
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(null, new BrowserStartupError("browser did not print a DevTools endpoint within " + timeoutMs + "ms", tail(buffer))),
      timeoutMs,
    );
    timer.unref();
    proc.stderr?.on("data", (chunk) => {
      buffer += chunkToText(chunk);
      const endpoint = parseDevToolsEndpoint(buffer);
      if (endpoint !== null) finish(endpoint, null);
    });
    proc.once("exit", (code) => finish(null, new BrowserStartupError("browser exited (code " + String(code) + ") before a DevTools endpoint", tail(buffer))));
    proc.once("error", (error) => finish(null, error instanceof Error ? error : new Error(String(error))));
  });
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return String(chunk);
}

function tail(text: string, max = 2000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function defaultBrowserSpawn(program: string, args: readonly string[]): BrowserProcess {
  return spawn(program, [...args], { detached: true, stdio: ["ignore", "ignore", "pipe"] }) as unknown as BrowserProcess;
}

/** SIGTERM the process group, wait, then SIGKILL if it is still alive. */
export async function terminateBrowserProcess(
  proc: BrowserProcess,
  graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS,
  deps: SignalBrowserDeps = {},
): Promise<void> {
  const exited = waitForExit(proc, graceMs);
  signalBrowser(proc, "SIGTERM", deps);
  if (!(await exited)) signalBrowser(proc, "SIGKILL", deps);
}

/**
 * W891: Windows has no POSIX process group, and `process.kill(-pid)` there does not
 * mean "the group" — it is not a supported target. `taskkill /T` walks the
 * parent-child chain instead (best effort, same TOCTOU caveat as the sandbox
 * child wrapper). Without this the launched browser's renderer children leak on
 * close, which is exactly the leak the group signal exists to prevent.
 */
export interface SignalBrowserDeps {
  /** Injected platform (tests); defaults to the host. */
  platform?: string;
  /** Injected group-kill (tests); defaults to `process.kill(-pid, signal)`. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injected tree-kill (tests); defaults to `taskkillTree`. */
  killTree?: (pid: number) => boolean;
}

export function signalBrowser(proc: BrowserProcess, signal: NodeJS.Signals, deps: SignalBrowserDeps = {}): void {
  const pid = proc.pid;
  if (pid !== undefined) {
    if (isWindows(deps.platform ?? process.platform)) {
      // taskkill has no signal choice; a SIGTERM request still has to be a /F
      // kill, because Windows has no cooperative SIGTERM for a GUI process.
      if ((deps.killTree ?? taskkillTree)(pid)) return;
    } else {
      try {
        (deps.killGroup ?? ((p, s) => process.kill(-p, s)))(pid, signal);
        return;
      } catch {
        // not a group leader (or already gone): fall through to the direct child
      }
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // already reaped
  }
}

function waitForExit(proc: BrowserProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    proc.once("exit", () => finish(true));
  });
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a leftover profile dir must never fail close()
  }
}
