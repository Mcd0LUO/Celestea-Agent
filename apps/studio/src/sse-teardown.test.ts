/**
 * W1484 · SSE teardown: is the studio's \`GET /api/events\` an upgraded socket?
 *
 * The question comes from the DSH reference implementation
 * (\`packages/host/webserver/src/index.ts\`): Node's
 * \`server.closeAllConnections()\` does NOT include sockets that were upgraded
 * (101 Switching Protocols), so DSH hand-tracks \`upgradedSockets\` and destroys
 * them one by one — without that, the teardown hangs forever.
 *
 * This suite answers the same question for the studio, mechanically, over a REAL
 * socket (no mocked \`Request\`/\`Response\`):
 *
 *   A. the response head is \`HTTP/1.1 200\` + chunked — a PLAIN request — and the
 *      real \`startStudioServer().stop()\` (the W742 teardown, unchanged) really
 *      does cut an OPEN SSE stream;
 *   B. the contrast that makes (A) meaningful: with the stream open,
 *      \`server.close()\` alone stays PENDING — \`closeAllConnections()\` is the
 *      load-bearing step. That is the same hang shape DSH works around, here for
 *      a plain GET, which is exactly why no explicit socket tracking is needed;
 *   C. the cut releases the bus subscription (\`stream.onAbort\`), so a teardown
 *      cannot leak subscribers.
 *
 * Ratchet: if \`/api/events\` ever becomes an upgraded socket (a WebSocket-based
 * push, or any transport answering 101), (A) turns red — which is precisely the
 * moment the explicit \`upgradedSockets\` tracking would become necessary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApp } from "./app.js";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { startStudioServer } from "./server.js";
import type { StudioBus } from "./sse.js";

const roots: string[] = [];
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway data root: the same file set \`makeHarness\` plants, no static build. */
function throwawayEnv(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "w1484-sse-"));
  roots.push(root);
  writeFileSync(join(root, "workspaces.json"), JSON.stringify({ workspaces: [], active_session: null }));
  return {
    root,
    env: {
      CELESTEA_HOME: root,
      CELESTEA_WORKSPACES_FILE: join(root, "workspaces.json"),
      CELESTEA_PROVIDERS_FILE: join(root, "providers.json"),
      CELESTEA_PROMPTS_FILE: join(root, "prompts.json"),
      STUDIO_STATIC_ROOT: join(root, "dist"),
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until \`ok()\` holds, else fail with the label (never a silent timeout). */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

interface RawClient {
  /** The status line + headers exactly as they arrived. */
  head(): string;
  /** Everything received so far. */
  body(): string;
  /** True once the socket saw FIN/RST (either side). */
  closed(): boolean;
  destroy(): void;
}

/**
 * One raw HTTP client — a real TCP socket, so the response head is observed
 * byte-for-byte instead of through a fetch abstraction that hides the framing.
 */
async function openRawSse(port: number, path = "/api/events", extraHeaders = ""): Promise<RawClient> {
  const socket: Socket = connect(port, "127.0.0.1");
  let text = "";
  let closed = false;
  let headSeen: (() => void) | null = null;
  const sawHead = new Promise<void>((resolve) => {
    headSeen = resolve;
  });
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    if (text.includes("\r\n\r\n")) headSeen?.();
  });
  socket.on("close", () => {
    closed = true;
    headSeen?.();
  });
  socket.on("error", () => {
    closed = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n${extraHeaders}\r\n`);
  await Promise.race([sawHead, sleep(5_000)]);
  return {
    head: () => text.split("\r\n\r\n")[0] ?? "",
    body: () => text,
    closed: () => closed,
    destroy: () => socket.destroy(),
  };
}

interface LiveInstance {
  port: number;
  server: Server;
  bus: StudioBus;
}

/** A real listener over the real app (the ONE line \`startStudioServer\` also runs). */
async function makeLiveInstance(): Promise<LiveInstance> {
  const { root, env } = throwawayEnv();
  const studio = createStudioApp({
    cwd: root,
    env,
    runtime: createFakeRuntimeAdapter({ profile: { model: "test-model" } }),
  });
  // `createAdaptorServer` is the real factory `serve` wraps. Its published type
  // is the http/http2 UNION (`ServerType`), so the cast pins the HTTP/1.1 branch
  // this suite actually speaks — the same object `startStudioServer` holds.
  const live = createAdaptorServer({ fetch: studio.app.fetch }) as unknown as Server;
  const port = await new Promise<number>((resolve) => {
    live.listen(0, "127.0.0.1", () => resolve((live.address() as AddressInfo).port));
  });
  disposers.push(() => {
    live.closeAllConnections?.();
    live.close();
  });
  return { port, server: live, bus: studio.services.bus };
}

describe("W1484 · /api/events teardown is a plain HTTP connection (no upgraded-socket tracking needed)", () => {
  it("A: answers 200 (never 101) and the real stop() cuts an open stream", async () => {
    const { root, env } = throwawayEnv();
    const handle = startStudioServer({
      port: 0,
      hostname: "127.0.0.1",
      log: false,
      cwd: root,
      env: { ...env, CELESTEA_SHUTDOWN_DRAIN_MS: "200", CELESTEA_SHUTDOWN_TIMEOUT_MS: "1000" },
      runtime: createFakeRuntimeAdapter({ profile: { model: "test-model" } }),
    });
    disposers.push(() => void handle.stop("SIGTERM"));
    const bound = await handle.listening;
    const client = await openRawSse(bound.port);
    disposers.push(() => client.destroy());

    // The framing fact this whole item turns on: a plain request, not an upgrade.
    expect(client.head().startsWith("HTTP/1.1 200 ")).toBe(true);
    expect(client.head()).not.toContain("101 Switching Protocols");
    expect(client.head().toLowerCase()).not.toContain("upgrade:");
    expect(client.head()).toContain("content-type: text/event-stream");
    expect(client.closed()).toBe(false);

    // The production teardown (W742 order, untouched) must not leave it hanging.
    await handle.stop("SIGTERM");
    await waitFor("stop() to cut the open SSE socket", () => client.closed());
  }, 30_000);

  it("B: close() alone stays pending on an open stream; closeAllConnections() is what cuts it", async () => {
    const live = await makeLiveInstance();
    const client = await openRawSse(live.port);
    disposers.push(() => client.destroy());

    const closedByCallback = new Promise<string>((resolve) => live.server.close(() => resolve("closed")));
    await sleep(300);
    // Negative control, inline: the listener is shut but the SSE socket keeps it
    // alive — the exact hang DSH fixes by destroying upgraded sockets.
    expect(await Promise.race([closedByCallback, Promise.resolve("pending")])).toBe("pending");
    expect(client.closed()).toBe(false);

    live.server.closeAllConnections();
    await waitFor("close() to resolve once the connections are cut", () => client.closed());
    expect(await closedByCallback).toBe("closed");
  }, 30_000);

  it("C: cutting the connection releases the bus subscription (no subscriber leak)", async () => {
    const live = await makeLiveInstance();
    const client = await openRawSse(live.port);
    disposers.push(() => client.destroy());
    await waitFor("the SSE handler to subscribe", () => live.bus.subscriberCount() === 1);

    live.server.closeAllConnections();
    await waitFor("the subscription to be released", () => live.bus.subscriberCount() === 0);
    expect(client.closed()).toBe(true);
  }, 30_000);

  it("D: a client disconnect releases the bus subscription too", async () => {
    const live = await makeLiveInstance();
    const client = await openRawSse(live.port);
    await waitFor("the SSE handler to subscribe", () => live.bus.subscriberCount() === 1);

    client.destroy();
    await waitFor("the subscription to be released", () => live.bus.subscriberCount() === 0);
  }, 30_000);

  /**
   * POSITIVE CONTROL for the premise above. This is NOT the studio: it is a raw
   * \`node:http\` server that answers 101 and tracks its upgraded sockets the way
   * DSH does. It proves two things the "no change needed" conclusion rests on:
   *   - the assertions used in (A)/(B) DO fire for an upgraded socket (they are
   *     not vacuous — with a 101, \`close()\` stays pending and the client stays
   *     open even AFTER \`closeAllConnections()\`);
   *   - destroying the tracked socket is what releases it — the DSH workaround,
   *     needed there and (per A/B/C) not needed here.
   */
  it("E: positive control — a 101 upgraded socket survives closeAllConnections() and needs explicit destroy", async () => {
    const upgraded = new Set<Socket>();
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("plain");
    });
    // `node:http` types the upgrade socket as `Duplex`; at runtime it IS the
    // net.Socket — the DSH reference stores it the same way.
    server.on("upgrade", (_req, socket) => {
      upgraded.add(socket as Socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    disposers.push(() => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close();
    });

    const client = await openRawSse(port, "/ws", "Upgrade: websocket\r\nConnection: Upgrade\r\n");
    disposers.push(() => client.destroy());
    expect(client.head().startsWith("HTTP/1.1 101 ")).toBe(true);
    expect(upgraded.size).toBe(1);

    const closedByCallback = new Promise<string>((resolve) => server.close(() => resolve("closed")));
    await sleep(200);
    server.closeAllConnections();
    await sleep(300);
    // THE DSH HANG: a listener shut with only closeAllConnections() never resolves.
    expect(await Promise.race([closedByCallback, Promise.resolve("pending")])).toBe("pending");
    expect(client.closed()).toBe(false);

    // The workaround: destroy the tracked upgraded socket.
    for (const socket of upgraded) socket.destroy();
    await waitFor("the upgraded socket to be destroyed", () => client.closed());
    expect(await closedByCallback).toBe("closed");
  }, 30_000);

});
