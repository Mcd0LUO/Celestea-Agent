/**
 * F4 slice 1 -- launch/attach unit tests.
 *
 * The executable locator, the process spawner and the transport opener are all
 * injected, so none of this needs a real browser. The fake process uses a pid
 * far above pid_max so the group-signal path can never hit a real process group.
 */

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CdpClient, type CdpTransport, type CdpTransportHandlers } from "./cdp.js";
import {
  attachBrowser,
  BrowserNotFoundError,
  BrowserStartupError,
  findHeadlessShell,
  headlessShellSubdir,
  launchBrowser,
  parseDevToolsEndpoint,
  playwrightCacheRoot,
  signalBrowser,
  type BrowserProcess,
} from "./launch.js";

/** Above any plausible pid_max, so process.kill(-pid) can only ESRCH. */
const FAKE_PID = 2_147_483_647;

class FakeTransport implements CdpTransport {
  closed = false;
  private handlers: CdpTransportHandlers | null = null;
  send(): void {
    // requests are not needed by these tests
  }
  subscribe(handlers: CdpTransportHandlers): void {
    this.handlers = handlers;
  }
  close(): void {
    this.closed = true;
    this.handlers?.onClose();
  }
}

class FakeProcess implements BrowserProcess {
  readonly pid: number;
  readonly signals: NodeJS.Signals[] = [];
  readonly stderr: { on(event: string, listener: (chunk: unknown) => void): unknown };
  private data: ((chunk: unknown) => void) | null = null;
  private exits: Array<(...args: unknown[]) => void> = [];
  private exited = false;

  constructor(pid: number = FAKE_PID) {
    this.pid = pid;
    this.stderr = {
      on: (event, listener) => {
        if (event === "data") this.data = listener;
        return this.stderr;
      },
    };
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.emitExit(null);
    return true;
  }

  once(event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === "exit") {
      if (this.exited) queueMicrotask(() => listener(null));
      else this.exits.push(listener);
    }
    return this;
  }

  emitStderr(text: string): void {
    this.data?.(text);
  }

  emitExit(code: number | null = 0): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exits) listener(code);
    this.exits = [];
  }
}

describe("F4 launch -- endpoint parsing and discovery", () => {
  it("extracts the ws:// endpoint out of noisy stderr", () => {
    const stderr = "[ERROR:dbus] noise\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-123\nmore";
    expect(parseDevToolsEndpoint(stderr)).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    expect(parseDevToolsEndpoint("nothing here")).toBeNull();
    expect(parseDevToolsEndpoint("DevTools listening on ws://127.0.0.1:1/x ")).toBe("ws://127.0.0.1:1/x");
  });

  it("maps platform+arch onto Playwright's subdirectory", () => {
    expect(headlessShellSubdir("linux", "x64")).toBe("chrome-headless-shell-linux64");
    expect(headlessShellSubdir("linux", "arm64")).toBe("chrome-headless-shell-linux-arm64");
    expect(headlessShellSubdir("darwin", "arm64")).toBe("chrome-headless-shell-mac-arm64");
    expect(headlessShellSubdir("darwin", "x64")).toBe("chrome-headless-shell-mac-x64");
    expect(headlessShellSubdir("win32", "x64")).toBe("chrome-headless-shell-win64");
  });

  it("finds the highest-versioned headless shell", () => {
    const newest = "/cache/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
    const older = "/cache/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
    const list = () => ["chromium_headless_shell-1234", "chromium_headless_shell-1243", "ffmpeg-1011"];
    expect(findHeadlessShell({ root: "/cache", platform: "linux", arch: "x64", list, exists: (path) => path === newest })).toBe(newest);
    expect(findHeadlessShell({ root: "/cache", platform: "linux", arch: "x64", list, exists: (path) => path === older })).toBe(older);
    expect(findHeadlessShell({ root: "/cache", platform: "linux", arch: "x64", list, exists: () => false })).toBeNull();
    expect(findHeadlessShell({ root: "/cache", platform: "linux", arch: "x64", list: () => [], exists: () => true })).toBeNull();
  });

  it("resolves the per-OS Playwright cache root (W891)", () => {
    const home = "C:\\Users\\op";
    const env: Record<string, string | undefined> = {};
    expect(playwrightCacheRoot({ platform: "win32", homedir: home, env })).toBe(
      "C:\\Users\\op\\AppData\\Local\\ms-playwright",
    );
    expect(playwrightCacheRoot({ platform: "darwin", homedir: "/Users/op", env })).toBe("/Users/op/Library/Caches/ms-playwright");
    expect(playwrightCacheRoot({ platform: "linux", homedir: "/home/op", env })).toBe("/home/op/.cache/ms-playwright");
    // PLAYWRIGHT_BROWSERS_PATH wins over the per-OS default, but an explicit root wins over both.
    const withEnv: Record<string, string | undefined> = { PLAYWRIGHT_BROWSERS_PATH: "D:\\pw" };
    expect(playwrightCacheRoot({ platform: "win32", homedir: home, env: withEnv })).toBe("D:\\pw");
    expect(playwrightCacheRoot({ root: "/cache", platform: "win32", homedir: home, env: withEnv })).toBe("/cache");
  });

  it("finds a Windows-layout headless shell with backslash separators", () => {
    const shell = "C:\\Users\\op\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
    const list = () => ["chromium_headless_shell-1243"];
    const found = findHeadlessShell({
      platform: "win32",
      arch: "x64",
      homedir: "C:\\Users\\op",
      env: {},
      list,
      exists: (path) => path === shell,
    });
    expect(found).toBe(shell);
  });
});

describe("W891 -- process-tree teardown is a platform decision", () => {
  it("POSIX: signals the whole process group and never taskkills", () => {
    const proc = new FakeProcess(4242);
    const groups: Array<[number, NodeJS.Signals]> = [];
    let trees = 0;
    signalBrowser(proc, "SIGTERM", {
      platform: "linux",
      killGroup: (pid, signal) => groups.push([pid, signal]),
      killTree: () => {
        trees++;
        return true;
      },
    });
    expect(groups).toEqual([[4242, "SIGTERM"]]);
    expect(trees).toBe(0);
    expect(proc.signals).toEqual([]);
  });

  it("win32: taskkills the tree and never uses the (meaningless) negative pid", () => {
    const proc = new FakeProcess(4242);
    const killed: number[] = [];
    let groups = 0;
    signalBrowser(proc, "SIGTERM", {
      platform: "win32",
      killGroup: () => {
        groups++;
      },
      killTree: (pid) => {
        killed.push(pid);
        return true;
      },
    });
    expect(killed).toEqual([4242]);
    expect(groups).toBe(0);
    expect(proc.signals).toEqual([]);
  });

  it("win32: falls back to the direct child when taskkill cannot reach the tree", () => {
    const proc = new FakeProcess(4242);
    signalBrowser(proc, "SIGKILL", { platform: "win32", killTree: () => false });
    expect(proc.signals).toEqual(["SIGKILL"]);
  });

  it("POSIX: falls back to the direct child when the group signal fails", () => {
    const proc = new FakeProcess(4242);
    signalBrowser(proc, "SIGKILL", {
      platform: "linux",
      killGroup: () => {
        throw new Error("ESRCH");
      },
    });
    expect(proc.signals).toEqual(["SIGKILL"]);
  });
});

describe("F4 launch -- launchBrowser", () => {
  it("spawns with the contract flags, attaches, and reclaims on close", async () => {
    const proc = new FakeProcess();
    const transport = new FakeTransport();
    const spawned: Array<{ program: string; args: readonly string[] }> = [];
    const browser = await launchBrowser({
      executablePath: "/fake/chrome-headless-shell",
      userDataDir: "/tmp/w885-fake-profile",
      spawn: (program, args) => {
        spawned.push({ program, args });
        queueMicrotask(() => proc.emitStderr("DevTools listening on ws://127.0.0.1:1234/devtools/browser/abc\n"));
        return proc;
      },
      openTransport: async () => transport,
      // W892: pin the POSIX branch — FakeProcess models a signalable child, and
      // on Windows the real teardown taskkills instead (covered by its own case).
      signal: { platform: "linux" },
    });
    expect(browser.endpoint).toBe("ws://127.0.0.1:1234/devtools/browser/abc");
    expect(browser.pid).toBe(FAKE_PID);
    expect(browser.client).toBeInstanceOf(CdpClient);
    expect(spawned[0]!.program).toBe("/fake/chrome-headless-shell");
    expect(spawned[0]!.args).toEqual([
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--user-data-dir=/tmp/w885-fake-profile",
      "about:blank",
    ]);
    await browser.close();
    expect(proc.signals).toContain("SIGTERM");
    expect(transport.closed).toBe(true);
  });

  it("removes the profile dir it created, but not an injected one", async () => {
    const proc = new FakeProcess();
    const browser = await launchBrowser({
      executablePath: "/fake",
      spawn: () => {
        queueMicrotask(() => proc.emitStderr("DevTools listening on ws://127.0.0.1:1/x\n"));
        return proc;
      },
      openTransport: async () => new FakeTransport(),
      shutdownGraceMs: 50,
      // W892: pin the POSIX branch so the teardown is host-independent (on Windows
      // the real path taskkills; that branch has its own case).
      signal: { platform: "linux" },
    });
    expect(existsSync(browser.userDataDir)).toBe(true);
    await browser.close();
    expect(existsSync(browser.userDataDir)).toBe(false);
  });

  it("fails closed when no executable can be located", async () => {
    await expect(launchBrowser({ findExecutable: () => null })).rejects.toBeInstanceOf(BrowserNotFoundError);
  });

  it("reports a structured startup error (and kills the process) when the browser dies", async () => {
    const proc = new FakeProcess();
    const pending = launchBrowser({
      executablePath: "/fake",
      spawn: () => {
        queueMicrotask(() => proc.emitExit(1));
        return proc;
      },
      openTransport: async () => new FakeTransport(),
      shutdownGraceMs: 50,
      // W892: pin the POSIX branch so the teardown is host-independent (on Windows
      // the real path taskkills; that branch has its own case).
      signal: { platform: "linux" },
    });
    await expect(pending).rejects.toBeInstanceOf(BrowserStartupError);
    await pending.catch((error: BrowserStartupError) => {
      expect(error.stderrTail).toBe("");
    });
    expect(proc.signals).toContain("SIGTERM");
  });
});

describe("F4 launch -- attachBrowser", () => {
  it("connects to an external endpoint and closes the transport", async () => {
    const transport = new FakeTransport();
    const attached = await attachBrowser("ws://127.0.0.1:9222/devtools/browser/xyz", { openTransport: async () => transport });
    expect(attached.endpoint).toBe("ws://127.0.0.1:9222/devtools/browser/xyz");
    expect(attached.client).toBeInstanceOf(CdpClient);
    attached.close();
    expect(transport.closed).toBe(true);
  });
});
