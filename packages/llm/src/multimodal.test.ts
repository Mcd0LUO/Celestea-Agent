/**
 * W804 (multimodal P0, stage 3): the wire content array + the §7.6 downgrade.
 *
 * The downgrade test is a REAL integration: a real local HTTP upstream (a mock
 * gateway) that rejects any body containing an image_url exactly like
 * deepseek-v4-flash-0731 does, plus the real OpenAiCompatClient, the real 400
 * classifier and the real retry decorator. No network, no secrets.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectStream,
  ImageUnsupportedError,
  isImageUnsupportedBody,
  isImageUnsupportedError,
  OpenAiCompatClient,
  type ImageRef,
  type ModelRequestDraft,
} from "@celestea/llm";
import { buildRequestBody, collectMessageParts } from "./wire.js";
import { createImageDowngradeLlm } from "./image-fallback.js";

const REF: ImageRef = { attachment_id: "a".repeat(64), media_type: "image/png", width: 8, height: 8 };
const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function userWithImage(): ModelRequestDraft {
  return {
    model: "deepseek-v4-flash-0731",
    messages: [
      { role: "user", content: [{ type: "text", content: "look" }, { type: "image", content: REF }], tool_call_id: null },
    ],
    images: { [REF.attachment_id]: DATA },
  };
}

describe("wire content arrays (stage 3, section 3.5/3.3)", () => {
  it("keeps a text-only request byte-identical (content stays a string)", () => {
    const body = buildRequestBody(
      { model: "m", messages: [{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }] },
      { model: "m" },
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("renders a user image as [text, image_url] with the data URL", () => {
    const body = buildRequestBody(userWithImage(), { model: "m" });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: DATA } },
        ],
      },
    ]);
  });

  it("splits a tool message with an image into tool-text then user-image (shape B)", () => {
    const req: ModelRequestDraft = {
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool_call", content: { id: "c1", name: "read_image", args: {} } }], tool_call_id: null },
        { role: "tool", content: [{ type: "text", content: '{"ok":true}' }, { type: "image", content: REF }], tool_call_id: "c1" },
      ],
      images: { [REF.attachment_id]: DATA },
    };
    const body = buildRequestBody(req, { model: "m" });
    expect(body.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(body.messages[1]).toMatchObject({ role: "tool", content: '{"ok":true}', tool_call_id: "c1" });
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: DATA } }] });
  });

  it("throws (never silently drops) when an image has no resolved bytes", () => {
    expect(() => buildRequestBody({ model: "m", messages: [userWithImage().messages[0]!] }, { model: "m" })).toThrow(
      /has no resolvable bytes/,
    );
  });

  it("throws when a system/assistant message carries an image", () => {
    expect(() =>
      buildRequestBody(
        { model: "m", messages: [{ role: "assistant", content: [{ type: "image", content: REF }], tool_call_id: null }], images: { [REF.attachment_id]: DATA } },
        { model: "m" },
      ),
    ).toThrow(/must not carry an image/);
  });

  it("collectMessageParts skips empty text but keeps order", () => {
    const parts = collectMessageParts(
      [{ type: "text", content: "" }, { type: "text", content: "a" }, { type: "image", content: REF }],
      { [REF.attachment_id]: DATA },
    );
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
  });
});

describe("400 classification (stage 3, section 7.6)", () => {
  it("recognises the two real upstream reports and nothing else", () => {
    expect(isImageUnsupportedBody("multimodal input is not supported by this chat renderer")).toBe(true);
    expect(
      isImageUnsupportedBody("Error from provider (Console Go): Upstream request failed: [400] Model only supports text input; received unsupported content type 'image_url'."),
    ).toBe(true);
    expect(isImageUnsupportedBody('{"error":{"message":"rate limited"}}')).toBe(false);
    expect(isImageUnsupportedBody("invalid api key")).toBe(false);
  });

  it("builds an ImageUnsupportedError that is an LlmError with httpStatus 400", () => {
    const err = new ImageUnsupportedError(400, "400 Bad Request", "multimodal input is not supported");
    expect(err).toBeInstanceOf(ImageUnsupportedError);
    expect(isImageUnsupportedError(err)).toBe(true);
    expect(err.httpStatus).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("multimodal input is not supported");
  });
});

// --- the real-upstream downgrade integration -------------------------------

interface MockGateway {
  baseUrl: string;
  bodies: string[];
  close(): Promise<void>;
}

/** A gateway that 400s any body carrying an image_url, otherwise streams "ok". */
async function startGateway(): Promise<MockGateway> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      if (body.includes("image_url")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"multimodal input is not supported by this chat renderer","type":"invalid_request_error","code":"invalid_request_error"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"text-only-ok"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: "http://127.0.0.1:" + String(addr.port),
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let gateway: MockGateway | null = null;
afterEach(async () => {
  if (gateway !== null) await gateway.close();
  gateway = null;
});

describe("§7.6 downgrade against a real HTTP upstream", () => {
  it("classifies the 400, strips the image, retries once and still completes", async () => {
    gateway = await startGateway();
    const client = new OpenAiCompatClient({
      baseUrl: gateway.baseUrl,
      apiKey: "sk-dummy-test-key-never-real",
      model: "deepseek-v4-flash-0731",
      connectTimeoutMs: 5_000,
      responseTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
    });

    // 1. the raw client classifies the 400 before any retry exists.
    let raw: unknown = null;
    try {
      await client.generate(userWithImage());
    } catch (e) {
      raw = e;
    }
    expect(isImageUnsupportedError(raw)).toBe(true);
    expect((raw as ImageUnsupportedError).httpStatus).toBe(400);

    // 2. the decorated llm downgrades and the turn completes.
    const events: Array<{ reason: string; model: string; httpStatus: number | null; placeholder: string }> = [];
    const llm = createImageDowngradeLlm({
      inner: client,
      onDowngrade: (info) => events.push({ reason: info.reason, model: info.model, httpStatus: info.httpStatus, placeholder: info.placeholder }),
    });
    const stream = await llm.generate(userWithImage());
    const collected = await collectStream(stream);
    expect(collected.at(-1)).toMatchObject({ kind: "done" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "IMAGE_UNSUPPORTED", model: "deepseek-v4-flash-0731", httpStatus: 400 });
    expect(events[0]!.placeholder).toContain("[图片已省略：");

    // 3. request 1 carried the image, request 2 did not (and has the placeholder).
    expect(gateway.bodies).toHaveLength(3); // raw + downgrade attempt 1 + retry
    expect(gateway.bodies[0]).toContain("image_url");
    expect(gateway.bodies[1]).toContain("image_url");
    expect(gateway.bodies[2]).not.toContain("image_url");
    expect(gateway.bodies[2]).not.toContain("base64");
    expect(gateway.bodies[2]).toContain("图片已省略");
  });
});
