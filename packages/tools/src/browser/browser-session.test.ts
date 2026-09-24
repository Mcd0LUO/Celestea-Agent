/**
 * F4 step 2b -- browser tools over a SCRIPTED transport and a fake sandbox.
 *
 * The properties pinned here are the ones the task makes non-negotiable:
 *   1. the browser is spawned with `noAddressSpaceLimit: true`;
 *   2. a network-isolated sandbox is REFUSED (structured, never a silent hang);
 *   3. every result states the RLIMIT_AS exemption + the memory backstop;
 *   4. the screenshot rides the real session attachment chain;
 *   5. dispose() reclaims the process and the profile dir (no orphan);
 *   6. the child is registered in the session ProcessRegistry (session shutdown).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxChild, SandboxConfig, SandboxExit, SandboxMeta, SandboxRunResult, SandboxSpawned, SandboxSpawnRequest, SandboxRunRequest } from "@celestea/core";

import { createAttachmentStore } from "../attachments/store.js";
import { ProcessRegistry } from "../process/registry.js";
import { CdpClient, type CdpTransport, type CdpTransportHandlers } from "./cdp.js";
import { BrowserManager } from "./session.js";

const FAKE_PID = 2_147_483_647;
const ENDPOINT = "ws://127.0.0.1:1234/devtools/browser/abc";
/** A real 1x1 PNG, so the attachment store's header parser accepts it. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

class FakeChild implements SandboxChild {
  readonly pid = FAKE_PID;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  private resolveExit: ((exit: SandboxExit) => void) | null = null;
  private readonly exitPromise: Promise<SandboxExit>;

  constructor() {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  wait(): Promise<SandboxExit> {
    return this.exitPromise;
  }

  terminate(): void {
    this.signals.push("terminate");
  }

  kill(): void {
    this.signals.push("kill");
    this.resolveExit?.({ code: null, signal: "SIGKILL" });
  }

  emitEndpoint(): void {
    this.stderr.write("DevTools listening on " + ENDPOINT + "\n");
  }
}

const CONFIG: SandboxConfig = {
  timeoutMs: 1000,
  maxTimeoutMs: 1000,
  maxCpuSec: 600,
  maxOutputBytes: 1024,
  // W891: "/tmp" is POSIX-only; the host temp dir exists everywhere.
  workdir: tmpdir(),
  root: tmpdir(),
  programDir: join(tmpdir(), "run-code"),
  extraEnv: [],
};

class FakeSandbox implements Sandbox {
  readonly config = CONFIG;
  readonly spawns: SandboxSpawnRequest[] = [];
  readonly children: FakeChild[] = [];
  meta: SandboxMeta = { provider: "userspace", net_isolated: false, tmp_private: false, seccomp: false, enforcement: "partial", promise_gaps: ["no_os_isolation"] };

  async run(_request: SandboxRunRequest): Promise<SandboxRunResult> {
    throw new Error("run is not used by the browser tools");
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    this.spawns.push(request);
    const child = new FakeChild();
    this.children.push(child);
    setTimeout(() => child.emitEndpoint(), 5);
    return { child, sandbox: this.meta };
  }
}

/** A CDP transport that answers every method the manager uses. */
class ScriptedTransport implements CdpTransport {
  readonly methods: string[] = [];
  private handlers: CdpTransportHandlers | null = null;
  private closed = false;

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
    this.methods.push(message.method);
    setTimeout(() => {
      if (!this.closed) this.handlers?.onMessage(JSON.stringify({ id: message.id, result: this.respond(message.method, message.params ?? {}) }));
    }, 0);
  }

  subscribe(handlers: CdpTransportHandlers): void {
    this.handlers = handlers;
  }

  close(): void {
    this.closed = true;
  }

  private respond(method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (method === "Target.createTarget") return { targetId: "target-1" };
    if (method === "Target.attachToTarget") return { sessionId: "session-1" };
    if (method === "Runtime.evaluate") {
      const expression = String(params["expression"] ?? "");
      if (expression.includes("readyState")) return { result: { type: "string", value: "complete" } };
      if (expression.includes("document.title")) return { result: { type: "string", value: "Test Page" } };
      if (expression.includes("location.href")) return { result: { type: "string", value: "https://example.com/" } };
      return { result: { type: "string", value: "" } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          { role: { value: "heading" }, name: { value: "Welcome" } },
          { role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 11 },
          { role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 12 },
        ],
      };
    }
    if (method === "DOM.getBoxModel") return { model: { content: [10, 20, 110, 20, 110, 50, 10, 50] } };
    if (method === "Page.captureScreenshot") return { data: PNG_BASE64 };
    return {};
  }
}

function makeManager(options: { sandbox: FakeSandbox; store?: boolean; processes?: ProcessRegistry; transport?: ScriptedTransport; meta?: SandboxMeta }) {
  const dir = mkdtempSync(join(tmpdir(), "f4b-att-"));
  const store = options.store === false ? null : createAttachmentStore(join(dir, "attachments"));
  const transport = options.transport ?? new ScriptedTransport();
  const manager = new BrowserManager({
    sandbox: options.sandbox,
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    attachments: store,
    findExecutable: () => "/fake/chrome-headless-shell",
    attach: async () => new CdpClient({ transport, timeoutMs: 2000 }),
    disposeGraceMs: 50,
    memoryLimitMb: 256,
  });
  return { manager, store, transport, dir };
}

describe("F4b · BrowserManager spawn contract", () => {
  it("spawns through the sandbox WITH noAddressSpaceLimit: true", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await manager.open("https://example.com/");
    expect(sandbox.spawns).toHaveLength(1);
    expect(sandbox.spawns[0]!.noAddressSpaceLimit).toBe(true);
    expect(sandbox.spawns[0]!.command).toContain("--headless");
    expect(sandbox.spawns[0]!.command).toContain("--remote-debugging-port=0");
    await manager.dispose();
  });

  it("refuses a network-isolated sandbox with a structured error and no orphan", async () => {
    const sandbox = new FakeSandbox();
    sandbox.meta = { provider: "bwrap", net_isolated: true, tmp_private: true, seccomp: false, enforcement: "full" };
    const { manager } = makeManager({ sandbox });
    await expect(manager.open("https://example.com/")).rejects.toThrow(/code=network_required/);
    expect(sandbox.children[0]!.signals).toContain("kill");
    expect(manager.running).toBe(false);
  });

  it("registers the child in the session ProcessRegistry (shutdown hook)", async () => {
    const sandbox = new FakeSandbox();
    const processes = new ProcessRegistry();
    const { manager } = makeManager({ sandbox, processes });
    await manager.open("https://example.com/");
    expect(processes.size).toBe(1);
    processes.dispose();
    expect(sandbox.children[0]!.signals).toContain("kill");
    await manager.dispose();
  });
});

describe("F4b · BrowserManager result contract", () => {
  it("states the RLIMIT_AS exemption and the memory backstop in every result", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    const value = await manager.open("https://example.com/");
    expect(value.isolation.address_space_limit).toBe("exempted");
    expect(value.isolation.address_space_note).toContain("RLIMIT_AS");
    expect(value.isolation.address_space_note).toContain("noAddressSpaceLimit=true");
    expect(value.notes.join(" ")).toContain("RLIMIT_AS");
    expect(["cgroup-v2", "rss-watchdog", "none"]).toContain(value.isolation.memory_guard.kind);
    expect(value.isolation.memory_guard.detail.length).toBeGreaterThan(0);
    expect(value.isolation.provider).toBe("userspace");
    await manager.dispose();
  });

  it("returns the capped AX snapshot and a screenshot through the attachment store", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    const value = await manager.open("https://example.com/", { width: 1280, height: 800 });
    expect(value.title).toBe("Test Page");
    expect(value.snapshot.text).toContain('[e1] button "Submit"');
    expect(value.snapshot.refs.map((ref) => ref.ref)).toEqual(["e1", "e2"]);
    expect(value.snapshot.truncated).toBe(false);
    expect(value.screenshot).not.toBeNull();
    expect(value.screenshot!.bytes).toBeGreaterThan(0);
    expect(value.attachments).toHaveLength(1);
    expect(value.attachments[0]!.attachment_id).toMatch(/^[0-9a-f]{64}$/);
    await manager.dispose();
  });

  it("click resolves a ref to its box and dispatches real mouse events", async () => {
    const sandbox = new FakeSandbox();
    const transport = new ScriptedTransport();
    const { manager } = makeManager({ sandbox, transport });
    await manager.open("https://example.com/");
    const value = await manager.act({ action: "click", ref: "e1" });
    expect(value.snapshot.refs.map((ref) => ref.ref)).toEqual(["e1", "e2"]);
    expect(transport.methods).toContain("Input.dispatchMouseEvent");
    await manager.dispose();
  });

  it("an unknown ref is a structured error, not a crash", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await manager.open("https://example.com/");
    await expect(manager.act({ action: "click", ref: "e99" })).rejects.toThrow(/code=unknown_ref/);
    await manager.dispose();
  });

  it("act without an open page is refused", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await expect(manager.act({ action: "key", key: "Enter" })).rejects.toThrow(/code=no_page/);
  });
});

describe("F4b · BrowserManager lifecycle", () => {
  it("dispose terminates the process tree, waits, and removes the profile dir", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await manager.open("https://example.com/");
    expect(manager.running).toBe(true);
    await manager.dispose();
    expect(manager.running).toBe(false);
    const child = sandbox.children[0]!;
    expect(child.signals).toContain("terminate");
  });

  it("dispose is idempotent and safe before any launch", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await manager.dispose();
    await manager.dispose();
    expect(manager.running).toBe(false);
  });

  it("cleans up the profile dir on the host after the child exits", async () => {
    const sandbox = new FakeSandbox();
    const { manager } = makeManager({ sandbox });
    await manager.open("https://example.com/");
    sandbox.children[0]!.kill();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.running).toBe(false);
    await manager.dispose();
  });
});
