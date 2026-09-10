/**
 * A local OpenAI-compatible MOCK provider for the live-engine tests (W511).
 *
 * The live path (`CELESTEA_LLM_MODE=live`, the deployment default) must be
 * testable without a real network: this helper serves `POST /v1/chat/completions`
 * on an ephemeral 127.0.0.1 port, replays a scripted SSE answer per call, and
 * records every request (url / headers / parsed body) so a test can assert what
 * the engine actually sent — model id, injected tool specs, reasoning_effort,
 * the Bearer header.
 */

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedChatRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockProvider {
  baseUrl: string;
  /** `/v1` root, i.e. what a provider row's `base_url` holds. */
  v1BaseUrl: string;
  requests: RecordedChatRequest[];
  close(): Promise<void>;
}

/** One SSE frame of a chat-completions stream. */
export function sseChunk(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/** Text delta frame. */
export function textDelta(text: string): string {
  return sseChunk({ choices: [{ index: 0, delta: { content: text } }] });
}

/** Tool-call delta frame (one complete call, OpenAI-compatible). */
export function toolCallDelta(id: string, name: string, args: unknown): string {
  return sseChunk({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  });
}

/** Final frame carrying usage (providers send it before [DONE]). */
export function usageChunk(promptTokens: number, completionTokens: number): string {
  return sseChunk({
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  });
}

/** The `[DONE]` terminator. */
export const DONE_FRAME = sseChunk("[DONE]");

/**
 * Start the mock. `answers[i]` is the frame list of the i-th call; the last
 * entry is reused once the script is exhausted.
 */
export async function startMockProvider(answers: readonly (readonly string[])[]): Promise<MockProvider> {
  const requests: RecordedChatRequest[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: req.url ?? "", headers: req.headers, body: safeJson(raw) });
      const frames = answers[Math.min(requests.length - 1, answers.length - 1)] ?? [];
      serveFrames(res, frames);
    });
  });
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    v1BaseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function serveFrames(res: http.ServerResponse, frames: readonly string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", transferEncoding: "chunked" });
  res.flushHeaders();
  for (const frame of frames) res.write(frame);
  res.end();
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
