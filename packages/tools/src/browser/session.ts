/**
 * F4 step 2b: one SESSION's headless browser, launched THROUGH the sandbox.
 *
 * Why through the sandbox: the browser is the one workload that must run with
 * `noAddressSpaceLimit: true` (step 2a) and, on the bwrap provider, with a
 * SHARED network namespace (the DevTools ws:// endpoint lives on 127.0.0.1 and
 * would be unreachable inside `--unshare-all`). Both facts are asserted here,
 * never inferred: `spawned.sandbox.net_isolated === true` refuses the call with
 * a structured `network_required` error instead of silently failing to connect.
 *
 * Lifecycle: the browser child is registered in the session ProcessRegistry, so
 * the host's existing shutdown hook (`processes.dispose()`) reaps it; the
 * manager ALSO exposes `dispose()` and removes the profile dir as soon as the
 * child exits. No orphan is left behind.
 *
 * The result carries an explicit isolation block: the RLIMIT_AS exemption and
 * the memory backstop are stated in the VALUE, so a caller can never mistake an
 * exempted call for a sandboxed one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageRef, Sandbox, SandboxChild, SandboxMeta } from "@celestea/core";

import type { AttachmentStore } from "../attachments/store.js";
import { contractFailure } from "../errors.js";
import { resolveShellKind } from "../platform/exec.js";
import { quoteWord } from "../platform/quote.js";
import type { ProcessRegistry } from "../process/registry.js";
import { delay, TIMED_OUT, withTimeout } from "../sandbox/async.js";
import { CdpClient } from "./cdp.js";
import { attachBrowser, findHeadlessShell, parseDevToolsEndpoint } from "./launch.js";
import { armMemoryGuard, DEFAULT_BROWSER_MEMORY_MB, type MemoryGuard, type MemoryGuardStatus } from "./memory-guard.js";
import { buildAxSnapshot, collectBoxes, isInteractiveRole, type SnapshotRef } from "./snapshot.js";
import type { BoundingBox } from "./types.js";

/** Default cap on rendered AX nodes / bytes (step 1's limits). */
export const DEFAULT_BROWSER_MAX_NODES = 200;
export const DEFAULT_BROWSER_MAX_BYTES = 32 * 1024;
/** Default wait for the DevTools endpoint. */
export const DEFAULT_BROWSER_STARTUP_MS = 20_000;
/** Grace between terminate() and kill() when disposing. */
export const DEFAULT_BROWSER_DISPOSE_GRACE_MS = 3_000;
/** How long to wait for document.readyState after navigate. */
export const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000;

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserActRequest {
  action: "click" | "type" | "key" | "scroll";
  ref?: string;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
}

/** The isolation facts of the running browser (explicit, never inferred). */
export interface BrowserIsolation {
  provider: string;
  net_isolated: boolean;
  tmp_private: boolean;
  seccomp: boolean;
  /** Always "exempted" for a browser: RLIMIT_AS is not applied. */
  address_space_limit: "exempted";
  /** The model-visible statement of that exemption. */
  address_space_note: string;
  memory_guard: MemoryGuardStatus;
}

export interface BrowserRef {
  ref: string;
  role: string;
  name: string;
  backend_dom_node_id: number | null;
  box: BoundingBox | null;
}

export interface BrowserSnapshotValue {
  text: string;
  refs: BrowserRef[];
  truncated: boolean;
  truncation_reason: string | null;
  total_nodes: number;
  included_nodes: number;
}

export interface BrowserScreenshot {
  attachment_id: string;
  media_type: string;
  width: number;
  height: number;
  bytes: number;
}

export interface BrowserResult {
  ok: true;
  url: string;
  title: string;
  snapshot: BrowserSnapshotValue;
  screenshot: BrowserScreenshot | null;
  attachments: ImageRef[];
  isolation: BrowserIsolation;
  notes: string[];
}

/** The model-visible sentence that must appear on every browser result. */
export const ADDRESS_SPACE_NOTE =
  "RLIMIT_AS is EXEMPTED for this browser process (noAddressSpaceLimit=true): its virtual address space is NOT bounded by the sandbox.";

export interface BrowserManagerOptions {
  sandbox: Sandbox;
  processes?: ProcessRegistry;
  attachments?: AttachmentStore | null;
  findExecutable?: () => string | null;
  attach?: (endpoint: string) => Promise<CdpClient>;
  /** Test seam: bypass the sandbox (the real path always passes the flag). */
  spawn?: (command: string) => Promise<{ child: SandboxChild; sandbox: SandboxMeta }>;
  startupTimeoutMs?: number;
  navigateTimeoutMs?: number;
  disposeGraceMs?: number;
  memoryLimitMb?: number;
  maxNodes?: number;
  maxBytes?: number;
}

interface LiveSession {
  child: SandboxChild;
  client: CdpClient;
  targetId: string;
  sessionId: string;
  meta: SandboxMeta;
  profileDir: string;
  guard: MemoryGuard;
  refs: Map<string, SnapshotRef>;
  exited: boolean;
}

/** Per-session browser owner. One instance is shared by both browser tools. */
export class BrowserManager {
  private readonly options: BrowserManagerOptions;
  private session: LiveSession | null = null;
  private disposed = false;

  constructor(options: BrowserManagerOptions) {
    this.options = options;
  }

  /** Open (or reuse) the page and return its snapshot + screenshot. */
  async open(url: string, viewport?: BrowserViewport): Promise<BrowserResult> {
    const session = await this.ensure();
    if (viewport !== undefined) {
      await session.client.setDeviceMetricsOverride({ width: viewport.width, height: viewport.height }, session.sessionId);
    }
    await this.navigate(session, url);
    return this.capture(session);
  }

  /** Act on the page opened by [open]; returns the updated snapshot. */
  async act(request: BrowserActRequest): Promise<BrowserResult> {
    const session = this.session;
    if (session === null || session.exited) {
      throw contractFailure("browser", "no_page", "no browser page is open; call browser_open first");
    }
    await this.perform(session, request);
    await delay(150);
    return this.capture(session);
  }

  /** Reclaim the browser: terminate the tree, wait, kill, remove the profile. */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.disposed = true;
    if (session === null) return;
    session.guard.dispose();
    session.client.close();
    try {
      session.child.terminate();
    } catch {
      /* already gone */
    }
    const exit = await withTimeout(session.child.wait(), this.graceMs);
    if (exit === TIMED_OUT) {
      try {
        session.child.kill();
      } catch {
        /* already gone */
      }
      await withTimeout(session.child.wait(), this.graceMs);
    }
    removeDir(session.profileDir);
  }

  /** True while a live browser is attached (diagnostics / tests). */
  get running(): boolean {
    return this.session !== null && !this.session.exited;
  }

  // ---- launch / attach -------------------------------------------------------

  private async ensure(): Promise<LiveSession> {
    if (this.session !== null && !this.session.exited) return this.session;
    if (this.disposed) throw contractFailure("browser", "disposed", "this browser manager was disposed");
    const executable = (this.options.findExecutable ?? findHeadlessShell)();
    if (executable === null || executable === undefined || executable === "") {
      throw contractFailure("browser", "browser_unavailable", "no chrome-headless-shell found; install Playwright chromium or set an executable path");
    }
    const profileDir = mkdtempSync(join(tmpdir(), "celestea-browser-"));
    const spawned = await this.spawnBrowser(this.browserCommand(executable, profileDir));
    if (spawned.sandbox.net_isolated) {
      spawned.child.kill();
      removeDir(profileDir);
      throw contractFailure(
        "browser",
        "network_required",
        "the sandbox is network-isolated (net_isolated=true), so the browser's DevTools endpoint on 127.0.0.1 is unreachable; grant this session the 'network' capability (grants.network / CELESTEA_SANDBOX_NET=1) so the sandbox shares the host network",
      );
    }
    let client: CdpClient;
    try {
      const endpoint = await this.readEndpoint(spawned.child);
      client = await (this.options.attach ?? defaultAttach)(endpoint);
    } catch (error) {
      spawned.child.kill();
      removeDir(profileDir);
      throw error;
    }
    const guard = armMemoryGuard({ pid: spawned.child.pid, limitMb: this.memoryLimitMb });
    const session: LiveSession = {
      child: spawned.child,
      client,
      targetId: "",
      sessionId: "",
      meta: spawned.sandbox,
      profileDir,
      guard,
      refs: new Map(),
      exited: false,
    };
    this.session = session;
    void spawned.child.wait().then(() => {
      session.exited = true;
      guard.dispose();
      removeDir(profileDir);
    });
    this.options.processes?.insert(spawned.child, false);
    const target = await client.createTarget("about:blank");
    const attached = await client.attachToTarget(target.targetId);
    session.targetId = target.targetId;
    session.sessionId = attached.sessionId;
    await client.pageEnable(session.sessionId);
    await client.runtimeEnable(session.sessionId);
    await client.accessibilityEnable(session.sessionId);
    return session;
  }

  private spawnBrowser(command: string): Promise<{ child: SandboxChild; sandbox: SandboxMeta }> {
    if (this.options.spawn !== undefined) return this.options.spawn(command);
    // HARD REQUIREMENT (F4 step 2a): the browser cannot start under RLIMIT_AS.
    return this.options.sandbox.spawn({ command, noAddressSpaceLimit: true });
  }

  private browserCommand(executable: string, profileDir: string): string {
    const kind = resolveShellKind(this.options.sandbox.shell ?? {}).kind;
    const words = [
      executable,
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profileDir,
      "about:blank",
    ];
    return words.map((word) => quoteWord(kind, word)).join(" ");
  }

  private readEndpoint(child: SandboxChild): Promise<string> {
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
      const timer = setTimeout(() => {
        finish(null, contractFailure("browser", "browser_startup", "browser did not print a DevTools endpoint within " + this.startupMs + "ms; stderr tail: " + tail(buffer)));
      }, this.startupMs);
      timer.unref();
      child.stderr?.on("data", (chunk: Buffer | string) => {
        buffer += String(chunk);
        const endpoint = parseDevToolsEndpoint(buffer);
        if (endpoint !== null) finish(endpoint, null);
      });
      void child.wait().then((exit) => {
        finish(null, contractFailure("browser", "browser_startup", "browser exited code=" + String(exit.code) + " before a DevTools endpoint; stderr tail: " + tail(buffer)));
      });
    });
  }

  // ---- page operations -------------------------------------------------------

  private async navigate(session: LiveSession, url: string): Promise<void> {
    await session.client.navigate(url, session.sessionId);
    const deadline = Date.now() + this.navigateMs;
    while (Date.now() < deadline) {
      const state = await session.client.evaluate("document.readyState", session.sessionId).catch(() => null);
      if (state === "complete") return;
      await delay(50);
    }
  }

  private async perform(session: LiveSession, request: BrowserActRequest): Promise<void> {
    const ref = request.ref === undefined ? undefined : session.refs.get(request.ref);
    if (request.action !== "key" && request.action !== "scroll" && ref === undefined) {
      throw contractFailure("browser", "unknown_ref", "ref '" + String(request.ref) + "' is unknown; take a browser_open snapshot first");
    }
    if (request.action === "click") await this.click(session, ref as SnapshotRef);
    else if (request.action === "type") await this.typeText(session, ref as SnapshotRef, request.text ?? "");
    else if (request.action === "key") await this.key(session, request.key ?? "Enter");
    else await this.scroll(session, ref, request.deltaX ?? 0, request.deltaY ?? 0);
  }

  private async click(session: LiveSession, ref: SnapshotRef): Promise<void> {
    const box = ref.box ?? (await this.boxOf(session, ref));
    if (box === null) throw contractFailure("browser", "no_box", "ref '" + ref.ref + "' has no layout box (not visible?)");
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await session.client.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 }, session.sessionId);
    await session.client.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 }, session.sessionId);
  }

  private async typeText(session: LiveSession, ref: SnapshotRef, text: string): Promise<void> {
    const backend = ref.backendDOMNodeId;
    if (backend === null) throw contractFailure("browser", "no_node", "ref '" + ref.ref + "' has no backend node id");
    await session.client.send("DOM.focus", { backendNodeId: backend }, session.sessionId);
    await session.client.insertText(text, session.sessionId);
  }

  private async key(session: LiveSession, key: string): Promise<void> {
    await session.client.dispatchKeyEvent({ type: "keyDown", key }, session.sessionId);
    await session.client.dispatchKeyEvent({ type: "keyUp", key }, session.sessionId);
  }

  private async scroll(session: LiveSession, ref: SnapshotRef | undefined, deltaX: number, deltaY: number): Promise<void> {
    let x = 400;
    let y = 300;
    if (ref !== undefined) {
      const box = ref.box ?? (await this.boxOf(session, ref));
      if (box !== null) {
        x = Math.round(box.x + box.width / 2);
        y = Math.round(box.y + box.height / 2);
      }
    }
    await session.client.dispatchMouseEvent({ type: "mouseWheel", x, y, deltaX, deltaY }, session.sessionId);
  }

  private async boxOf(session: LiveSession, ref: SnapshotRef): Promise<BoundingBox | null> {
    if (ref.backendDOMNodeId === null) return null;
    const model = await session.client.getBoxModel(ref.backendDOMNodeId, session.sessionId).catch(() => null);
    if (model === null) return null;
    const quad = model.content.map(Number);
    if (quad.length < 8) return null;
    const xs = [quad[0] as number, quad[2] as number, quad[4] as number, quad[6] as number];
    const ys = [quad[1] as number, quad[3] as number, quad[5] as number, quad[7] as number];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }

  // ---- snapshot + screenshot -------------------------------------------------

  private async capture(session: LiveSession): Promise<BrowserResult> {
    const nodes = await session.client.getFullAXTree(session.sessionId);
    const interactive = nodes.filter((node) => node.ignored !== true && isInteractiveRole(node.role?.value ?? "")).slice(0, this.maxNodes);
    const boxes = await collectBoxes(session.client, interactive, session.sessionId);
    const snap = buildAxSnapshot(nodes, { boxes, maxNodes: this.maxNodes, maxBytes: this.maxBytes });
    session.refs = new Map(snap.refs.map((ref) => [ref.ref, ref]));
    const title = await session.client.evaluate("document.title", session.sessionId).catch(() => "");
    const url = await session.client.evaluate("location.href", session.sessionId).catch(() => "");
    const shot = await this.screenshot(session);
    return {
      ok: true,
      url: typeof url === "string" ? url : "",
      title: typeof title === "string" ? title : "",
      snapshot: {
        text: snap.text,
        refs: snap.refs.map((ref) => ({
          ref: ref.ref,
          role: ref.role,
          name: ref.name,
          backend_dom_node_id: ref.backendDOMNodeId,
          box: ref.box,
        })),
        truncated: snap.truncated,
        truncation_reason: snap.truncationReason,
        total_nodes: snap.totalNodes,
        included_nodes: snap.includedNodes,
      },
      ...shot,
      isolation: this.isolation(session),
      notes: this.notes(shot.screenshot),
    };
  }

  private async screenshot(session: LiveSession): Promise<{ screenshot: BrowserScreenshot | null; attachments: ImageRef[] }> {
    const store = this.options.attachments;
    if (store === undefined || store === null) return { screenshot: null, attachments: [] };
    const shot = await session.client.captureScreenshot(session.sessionId);
    const bytes = Buffer.from(shot.data, "base64");
    const ref = await store.put({ bytes, name: "browser-" + Date.now() + ".png" });
    return {
      screenshot: { attachment_id: ref.attachment_id, media_type: ref.media_type, width: ref.width, height: ref.height, bytes: bytes.length },
      attachments: [ref],
    };
  }

  private isolation(session: LiveSession): BrowserIsolation {
    return {
      provider: session.meta.provider,
      net_isolated: session.meta.net_isolated,
      tmp_private: session.meta.tmp_private,
      seccomp: session.meta.seccomp,
      address_space_limit: "exempted",
      address_space_note: ADDRESS_SPACE_NOTE,
      memory_guard: session.guard.status(),
    };
  }

  private notes(screenshot: BrowserScreenshot | null): string[] {
    const notes: string[] = [ADDRESS_SPACE_NOTE];
    if (screenshot === null) notes.push("no attachment store: the screenshot was not captured (the accessibility snapshot is still returned)");
    return notes;
  }

  // ---- option accessors ------------------------------------------------------

  private get startupMs(): number {
    return this.options.startupTimeoutMs ?? DEFAULT_BROWSER_STARTUP_MS;
  }

  private get navigateMs(): number {
    return this.options.navigateTimeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
  }

  private get graceMs(): number {
    return this.options.disposeGraceMs ?? DEFAULT_BROWSER_DISPOSE_GRACE_MS;
  }

  private get memoryLimitMb(): number {
    return this.options.memoryLimitMb ?? DEFAULT_BROWSER_MEMORY_MB;
  }

  private get maxNodes(): number {
    return this.options.maxNodes ?? DEFAULT_BROWSER_MAX_NODES;
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? DEFAULT_BROWSER_MAX_BYTES;
  }
}

async function defaultAttach(endpoint: string): Promise<CdpClient> {
  const attached = await attachBrowser(endpoint);
  return attached.client;
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function tail(text: string, max = 800): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
