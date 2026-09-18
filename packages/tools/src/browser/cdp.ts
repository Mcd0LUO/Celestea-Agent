/**
 * Minimal Chrome DevTools Protocol client (F4 slice 1).
 *
 * Design: the TRANSPORT is a seam. \`WebSocketTransport\` is the production
 * implementation (Node's global WebSocket), while a test supplies an in-memory
 * fake and never needs a browser or a WebSocket server. This file owns request
 * id correlation, response/error settling, event fan-out, per-request
 * deadlines and close semantics.
 *
 * Only the domains the F4 tools need are wrapped; \`send\` stays public for
 * anything else. Zero npm dependencies.
 */

import type { AxNode, BoxModel, CdpErrorShape } from "./types.js";

/** Callbacks a transport delivers to its single subscriber. */
export interface CdpTransportHandlers {
  onMessage(data: string): void;
  onError(error: Error): void;
  onClose(): void;
}

/** The transport seam: real WebSocket in production, in-memory in tests. */
export interface CdpTransport {
  send(data: string): void;
  subscribe(handlers: CdpTransportHandlers): void;
  close(): void;
}

/** A structural WebSocket, so this module needs no DOM lib types. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CdpClientOptions {
  transport: CdpTransport;
  /** Per-request deadline; default 15000ms. */
  timeoutMs?: number;
}

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

/** Options for Runtime.evaluate. */
export interface EvaluateOptions {
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

/** Options for Page.captureScreenshot. */
export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
  captureBeyondViewport?: boolean;
}

/** A decoded screenshot: base64 plus its decoded byte count. */
export interface Screenshot {
  data: string;
  bytes: number;
}

/** Input.dispatchMouseEvent parameters. */
export interface MouseEventParams {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

/** Input.dispatchKeyEvent parameters. */
export interface KeyEventParams {
  type: "keyDown" | "keyUp" | "char" | "rawKeyDown";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
}

/** Emulation.setDeviceMetricsOverride parameters. */
export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

/** Default per-request deadline. */
export const DEFAULT_CDP_TIMEOUT_MS = 15_000;
/** Default WebSocket open deadline. */
export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

/** The transport could not be created / connected / used. */
export class CdpTransportError extends Error {
  readonly code = "cdp_transport";
  constructor(message: string) {
    super(message);
    this.name = "CdpTransportError";
  }
}

/** A request exceeded its deadline. */
export class CdpTimeoutError extends Error {
  readonly code = "cdp_timeout";
  constructor(method: string, timeoutMs: number) {
    super("CDP " + method + " timed out after " + timeoutMs + "ms");
    this.name = "CdpTimeoutError";
  }
}

/** The browser answered with a protocol error (negative code). */
export class CdpProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: CdpErrorShape) {
    super(error.message);
    this.name = "CdpProtocolError";
    this.code = error.code;
    this.data = error.data;
  }
}

/** The client (or its transport) is closed; no further requests are accepted. */
export class CdpClosedError extends Error {
  readonly code = "cdp_closed";
  constructor() {
    super("CDP client is closed");
    this.name = "CdpClosedError";
  }
}

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Production transport over Node's global WebSocket. */
export class WebSocketTransport implements CdpTransport {
  private readonly socket: WebSocketLike;

  constructor(socket: WebSocketLike) {
    this.socket = socket;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  subscribe(handlers: CdpTransportHandlers): void {
    this.socket.addEventListener("message", (event) => handlers.onMessage(stringifyData(event.data)));
    this.socket.addEventListener("error", () => handlers.onError(new CdpTransportError("websocket transport error")));
    this.socket.addEventListener("close", () => handlers.onClose());
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed: closing twice is not an error
    }
  }
}

function stringifyData(data: unknown): string {
  return typeof data === "string" ? data : String(data);
}

/** The runtime WebSocket constructor, or a structured error when absent. */
export function defaultWebSocketFactory(): WebSocketFactory {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (ctor === undefined) throw new CdpTransportError("global WebSocket is unavailable in this Node runtime");
  return (url) => new ctor(url);
}

export interface OpenTransportOptions {
  factory?: WebSocketFactory;
  openTimeoutMs?: number;
}

/** Connect and wait for the socket to open (sending before open would throw). */
export async function openWebSocketTransport(url: string, options: OpenTransportOptions = {}): Promise<WebSocketTransport> {
  const factory = options.factory ?? defaultWebSocketFactory();
  const socket = factory(url);
  await waitForOpen(socket, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
  return new WebSocketTransport(socket);
}

function waitForOpen(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => finish(new CdpTransportError("websocket did not open within " + timeoutMs + "ms")), timeoutMs);
    timer.unref();
    socket.addEventListener("open", () => finish(null));
    socket.addEventListener("error", () => finish(new CdpTransportError("websocket failed to connect")));
  });
}

/** A tiny CDP client over an injected transport. */
export class CdpClient {
  private readonly transport: CdpTransport;
  private readonly timeoutMs: number;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  constructor(options: CdpClientOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    this.transport.subscribe({
      onMessage: (data) => this.receive(data),
      onError: (error) => this.failAll(error),
      onClose: () => this.failAll(new CdpClosedError()),
    });
  }

  /** Send one request; the promise settles on its correlated response. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CdpClosedError());
    const id = ++this.seq;
    const envelope: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) envelope["sessionId"] = sessionId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, this.timeoutMs));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      this.transport.send(JSON.stringify(envelope));
    });
  }

  /** Subscribe to a CDP event (method name, or "*" for every event). */
  on(event: string, handler: CdpEventHandler): () => void {
    const set = this.handlers.get(event) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  /** Close the transport and reject every in-flight request. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      // best effort: the close path must never throw
    }
    this.failAll(new CdpClosedError());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---- domain wrappers (only what the F4 tools need) -------------------------

  async createTarget(url: string): Promise<{ targetId: string }> {
    const result = await this.send("Target.createTarget", { url });
    return { targetId: String(result["targetId"]) };
  }

  async attachToTarget(targetId: string): Promise<{ sessionId: string }> {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { sessionId: String(result["sessionId"]) };
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
  }

  async pageEnable(sessionId: string): Promise<void> {
    await this.send("Page.enable", {}, sessionId);
  }

  async runtimeEnable(sessionId: string): Promise<void> {
    await this.send("Runtime.enable", {}, sessionId);
  }

  async accessibilityEnable(sessionId: string): Promise<void> {
    await this.send("Accessibility.enable", {}, sessionId);
  }

  async navigate(url: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.send("Page.navigate", { url }, sessionId);
  }

  async evaluate(expression: string, sessionId: string, options: EvaluateOptions = {}): Promise<unknown> {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: options.returnByValue ?? true, awaitPromise: options.awaitPromise ?? false },
      sessionId,
    );
    const remote = result["result"] as { value?: unknown } | undefined;
    return remote === undefined ? undefined : remote.value;
  }

  async captureScreenshot(sessionId: string, options: ScreenshotOptions = {}): Promise<Screenshot> {
    const result = await this.send("Page.captureScreenshot", { format: "png", ...options }, sessionId);
    const data = typeof result["data"] === "string" ? result["data"] : "";
    return { data, bytes: Buffer.byteLength(data, "base64") };
  }

  async dispatchMouseEvent(params: MouseEventParams, sessionId: string): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { ...params }, sessionId);
  }

  async insertText(text: string, sessionId: string): Promise<void> {
    await this.send("Input.insertText", { text }, sessionId);
  }

  async dispatchKeyEvent(params: KeyEventParams, sessionId: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { ...params }, sessionId);
  }

  async setDeviceMetricsOverride(metrics: DeviceMetrics, sessionId: string): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, mobile: false, ...metrics }, sessionId);
  }

  async getFullAXTree(sessionId: string): Promise<AxNode[]> {
    const result = await this.send("Accessibility.getFullAXTree", {}, sessionId);
    const nodes = result["nodes"];
    return Array.isArray(nodes) ? (nodes as AxNode[]) : [];
  }

  async getBoxModel(backendNodeId: number, sessionId: string): Promise<BoxModel | null> {
    const result = await this.send("DOM.getBoxModel", { backendNodeId }, sessionId);
    const model = result["model"] as BoxModel | undefined;
    return model === undefined ? null : model;
  }  private receive(data: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // malformed frame: ignore, a transport error would be separate
    }
    if (typeof message["id"] === "number") this.settle(message["id"], message);
    else if (typeof message["method"] === "string") this.emit(message);
  }

  private settle(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message["error"] as CdpErrorShape | undefined;
    if (error !== undefined) pending.reject(new CdpProtocolError(error));
    else pending.resolve((message["result"] as Record<string, unknown> | undefined) ?? {});
  }

  private emit(message: Record<string, unknown>): void {
    const method = message["method"] as string;
    const params = (message["params"] as Record<string, unknown> | undefined) ?? {};
    const sessionId = typeof message["sessionId"] === "string" ? (message["sessionId"] as string) : undefined;
    for (const key of [method, "*"]) {
      const set = this.handlers.get(key);
      if (set === undefined) continue;
      for (const handler of [...set]) handler(params, sessionId);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
