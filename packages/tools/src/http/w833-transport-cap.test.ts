/**
 * B3 / W812 P2-1 (R3) — the transport body cap off-by-one, end to end.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B3 W812 P2-1: an http response body of exactly the cap must report
 * truncated=false. A real loopback server answers exactly the cap, then the
 * cap+1, so collectBody's decision is exercised through the real request path.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestOnce } from "./transport.js";

const CAP = 4096;
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "0");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(n, 0x41));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function bodyOf(n: number) {
  return requestOnce({
    url: new URL("http://127.0.0.1:" + port + "/?n=" + n),
    method: "GET",
    headers: [],
    body: null,
    timeoutMs: 5_000,
    maxBodyBytes: CAP,
  });
}

describe("B3 / W812 P2-1: transport body cap", () => {
  it("reports an exactly-cap body as complete", async () => {
    const exact = await bodyOf(CAP);
    expect(exact.body.length).toBe(CAP);
    expect(exact.truncated).toBe(false);
  });

  it("reports a cap+1 body as truncated", async () => {
    const over = await bodyOf(CAP + 1);
    expect(over.body.length).toBe(CAP);
    expect(over.truncated).toBe(true);
  });
});
