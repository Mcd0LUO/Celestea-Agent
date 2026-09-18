/**
 * F4 slice 1 -- CdpClient unit tests over an IN-MEMORY transport.
 *
 * The transport is a seam precisely so these tests need neither a browser nor a
 * WebSocket server: FakeTransport records what the client sends and lets a test
 * push response/event/error frames as the browser would.
 */

import { describe, expect, it } from "vitest";

import { CdpClient, CdpClosedError, CdpProtocolError, CdpTimeoutError, type CdpTransport, type CdpTransportHandlers } from "./cdp.js";

class FakeTransport implements CdpTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private handlers: CdpTransportHandlers | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  subscribe(handlers: CdpTransportHandlers): void {
    this.handlers = handlers;
  }

  close(): void {
    this.closed = true;
    this.handlers?.onClose();
  }

  deliver(message: Record<string, unknown>): void {
    this.handlers?.onMessage(JSON.stringify(message));
  }

  deliverRaw(data: string): void {
    this.handlers?.onMessage(data);
  }

  fail(error: Error): void {
    this.handlers?.onError(error);
  }

  idOf(index: number): number {
    return Number(this.sent[index]!["id"]);
  }

  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]!;
  }
}

describe("F4 CdpClient -- request correlation", () => {
  it("resolves each request with its own result, even out of order", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const first = client.send("Runtime.evaluate", { expression: "1" });
    const second = client.send("Runtime.evaluate", { expression: "2" });
    expect(transport.sent).toHaveLength(2);
    transport.deliver({ id: transport.idOf(1), result: { value: "second" } });
    transport.deliver({ id: transport.idOf(0), result: { value: "first" } });
    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
  });

  it("carries the method, params and sessionId into the frame", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const pending = client.send("Page.navigate", { url: "https://example.com" }, "session-7");
    expect(transport.last()).toMatchObject({
      id: 1,
      method: "Page.navigate",
      params: { url: "https://example.com" },
      sessionId: "session-7",
    });
    transport.deliver({ id: 1, result: {} });
    await pending;
  });

  it("rejects with the protocol error and its code", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const pending = client.send("No.suchMethod");
    transport.deliver({ id: transport.idOf(0), error: { code: -32601, message: "method not found", data: { x: 1 } } });
    await expect(pending).rejects.toBeInstanceOf(CdpProtocolError);
    await pending.catch((error: CdpProtocolError) => {
      expect(error.code).toBe(-32601);
      expect(error.data).toEqual({ x: 1 });
    });
  });

  it("times out a request the browser never answers", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport, timeoutMs: 20 });
    await expect(client.send("Page.navigate")).rejects.toBeInstanceOf(CdpTimeoutError);
    expect(transport.sent).toHaveLength(1);
  });

  it("rejects every in-flight request when the transport errors", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const pending = client.send("Page.navigate");
    transport.fail(new Error("socket exploded"));
    await expect(pending).rejects.toThrow("socket exploded");
  });

  it("ignores a malformed frame and keeps working", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    transport.deliverRaw("{not json");
    const pending = client.send("Runtime.evaluate");
    transport.deliver({ id: transport.idOf(0), result: { value: 1 } });
    await expect(pending).resolves.toEqual({ value: 1 });
  });
});

describe("F4 CdpClient -- events and close", () => {
  it("fans an event out to its method handler and to the wildcard", () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const seen: Array<[Record<string, unknown>, string | undefined]> = [];
    const all: string[] = [];
    const off = client.on("Page.loadEventFired", (params, sessionId) => seen.push([params, sessionId]));
    client.on("*", (_params, sessionId) => all.push(String(sessionId)));
    transport.deliver({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "s1" });
    expect(seen).toEqual([[{ timestamp: 1 }, "s1"]]);
    expect(all).toEqual(["s1"]);
    off();
    transport.deliver({ method: "Page.loadEventFired", params: { timestamp: 2 }, sessionId: "s1" });
    expect(seen).toHaveLength(1);
  });

  it("close rejects in-flight requests and refuses new ones", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });
    const pending = client.send("Page.navigate");
    client.close();
    await expect(pending).rejects.toBeInstanceOf(CdpClosedError);
    await expect(client.send("Page.navigate")).rejects.toBeInstanceOf(CdpClosedError);
    expect(transport.closed).toBe(true);
    expect(client.isClosed).toBe(true);
  });
});

describe("F4 CdpClient -- domain wrappers", () => {
  it("maps Target/Page/Runtime/Accessibility calls onto the wire", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });

    const created = client.createTarget("about:blank");
    transport.deliver({ id: transport.idOf(0), result: { targetId: "target-1" } });
    await expect(created).resolves.toEqual({ targetId: "target-1" });
    expect(transport.sent[0]).toMatchObject({ method: "Target.createTarget", params: { url: "about:blank" } });

    const attached = client.attachToTarget("target-1");
    expect(transport.last()).toMatchObject({ method: "Target.attachToTarget", params: { targetId: "target-1", flatten: true } });
    transport.deliver({ id: transport.idOf(1), result: { sessionId: "session-1" } });
    await expect(attached).resolves.toEqual({ sessionId: "session-1" });

    const enabled = client.pageEnable("session-1");
    expect(transport.last()).toMatchObject({ method: "Page.enable", sessionId: "session-1" });
    transport.deliver({ id: transport.idOf(2), result: {} });
    await enabled;

    const evaluated = client.evaluate("document.title", "session-1");
    expect(transport.last()).toMatchObject({
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true, awaitPromise: false },
    });
    transport.deliver({ id: transport.idOf(3), result: { result: { type: "string", value: "Hello" } } });
    await expect(evaluated).resolves.toBe("Hello");

    const shot = client.captureScreenshot("session-1");
    expect(transport.last()).toMatchObject({ method: "Page.captureScreenshot", params: { format: "png" } });
    transport.deliver({ id: transport.idOf(4), result: { data: Buffer.from("hello").toString("base64") } });
    await expect(shot).resolves.toEqual({ data: "aGVsbG8=", bytes: 5 });

    const tree = client.getFullAXTree("session-1");
    transport.deliver({ id: transport.idOf(5), result: { nodes: [{ role: { value: "button" } }] } });
    await expect(tree).resolves.toEqual([{ role: { value: "button" } }]);

    const box = client.getBoxModel(11, "session-1");
    expect(transport.last()).toMatchObject({ method: "DOM.getBoxModel", params: { backendNodeId: 11 } });
    transport.deliver({ id: transport.idOf(6), result: { model: { content: [0, 0, 10, 0, 10, 5, 0, 5] } } });
    await expect(box).resolves.toEqual({ content: [0, 0, 10, 0, 10, 5, 0, 5] });

    const missingBox = client.getBoxModel(12, "session-1");
    transport.deliver({ id: transport.idOf(7), result: {} });
    await expect(missingBox).resolves.toBeNull();
  });

  it("sends Input and Emulation commands with their parameters", async () => {
    const transport = new FakeTransport();
    const client = new CdpClient({ transport });

    const click = client.dispatchMouseEvent({ type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 }, "s1");
    expect(transport.last()).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 },
    });
    transport.deliver({ id: transport.idOf(0), result: {} });
    await click;

    const typed = client.insertText("hello", "s1");
    expect(transport.last()).toMatchObject({ method: "Input.insertText", params: { text: "hello" } });
    transport.deliver({ id: transport.idOf(1), result: {} });
    await typed;

    const key = client.dispatchKeyEvent({ type: "keyDown", key: "Enter" }, "s1");
    expect(transport.last()).toMatchObject({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } });
    transport.deliver({ id: transport.idOf(2), result: {} });
    await key;

    const metrics = client.setDeviceMetricsOverride({ width: 1280, height: 800 }, "s1");
    expect(transport.last()).toMatchObject({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    });
    transport.deliver({ id: transport.idOf(3), result: {} });
    await metrics;
  });
});
