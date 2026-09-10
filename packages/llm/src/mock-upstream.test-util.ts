/**
 * Local mock HTTP upstream for the LLM client tests (P2a).
 *
 * Everything runs on an ephemeral 127.0.0.1 port with a dummy key: no network
 * access, no secrets. The behaviours mirror the fake TCP upstreams used by the
 * Rust regression tests (crates/llm/tests/timeout_upstream.rs).
 */

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type UpstreamBehaviour =
  /** Accept the request, never write a byte (wedged gateway). */
  | "silent"
  /** 200 + one SSE chunk, then silence (stalled stream). */
  | "chunk-then-silent"
  /** Write the given SSE frames verbatim, optionally ending the response. */
  | "frames"
  /** Answer with a non-2xx status + body. */
  | "http-error";

export interface MockUpstreamOptions {
  /** Raw SSE wire pieces for behaviour "frames" (written verbatim). */
  frames?: Array<string | Buffer>;
  /** Delay between frames, in ms. */
  gapMs?: number;
  /** End the response after the frames (otherwise the stream stays open). */
  end?: boolean;
  /** Status code for behaviour "http-error". */
  status?: number;
  /** Body for behaviour "http-error". */
  body?: string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export interface MockUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One SSE frame carrying a chat-completions delta payload. */
export function sseFrame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/** The one chunk the "chunk-then-silent" behaviour emits. */
export const PARTIAL_CHUNK = sseFrame({
  choices: [{ index: 0, delta: { content: "Hel" } }],
});

/** Body of a normal three-delta answer, terminated by [DONE]. */
export function fastStreamFrames(pieces: string[]): string[] {
  return [
    ...pieces.map((piece) => sseFrame({ choices: [{ index: 0, delta: { content: piece } }] })),
    sseFrame("[DONE]"),
  ];
}

export async function startMockUpstream(
  behaviour: UpstreamBehaviour,
  options: MockUpstreamOptions = {},
): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        json = undefined;
      }
      requests.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
        json,
      });
      void serve(behaviour, options, res);
    });
  });

  // Keep the socket open long enough for the idle-timeout tests to observe a
  // stalled (not closed) stream.
  server.keepAliveTimeout = 60_000;
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serve(
  behaviour: UpstreamBehaviour,
  options: MockUpstreamOptions,
  res: http.ServerResponse,
): Promise<void> {
  switch (behaviour) {
    case "silent":
      // Hold the connection open without answering.
      return;
    case "chunk-then-silent":
      writeSseHead(res);
      res.write(PARTIAL_CHUNK);
      return;
    case "frames": {
      writeSseHead(res);
      const frames: Array<string | Buffer> = options.frames ?? [];
      const gapMs = options.gapMs ?? 0;
      for (const frame of frames) {
        res.write(frame);
        if (gapMs > 0) await sleep(gapMs);
      }
      if (options.end === true) res.end();
      return;
    }
    case "http-error": {
      const status = options.status ?? 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(options.body ?? "{}");
      return;
    }
  }
}

function writeSseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    transferEncoding: "chunked",
  });
  res.flushHeaders();
}
