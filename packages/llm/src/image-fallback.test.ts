/**
 * W855: the image downgrade now has THREE triggers that all reuse the ONE
 * placeholder+retry path:
 *   1. upstream_rejected     (W804, unchanged): a classified 4xx image report;
 *   2. timeout               response-header timeout with an image in flight;
 *   3. configured_text_only  input_modalities explicitly excludes "image".
 *
 * Everything here is deterministic: no real upstream, no real clock. The fake
 * Llm records the exact drafts it is asked to send, so "no call carried the
 * image" / "the retry has no image block" are direct assertions instead of
 * timing guesses.
 */

import { describe, expect, it } from "vitest";

import type { ImageRef, Llm, LlmStream, ModelRequestDraft, StreamEvent } from "./seam.js";
import { assistantText } from "./seam.js";
import { collectStream } from "./seam.js";
import { connectTimeoutError, LlmError, responseHeaderTimeoutError, statusError } from "./errors.js";
import { createImageDowngradeLlm, type ImageDowngradeInfo } from "./image-fallback.js";

const REF: ImageRef = { attachment_id: "a".repeat(64), media_type: "image/png", width: 8, height: 8 };
const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function imageReq(model: string): ModelRequestDraft {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", content: "look" }, { type: "image", content: REF }],
        tool_call_id: null,
      },
    ],
    images: { [REF.attachment_id]: DATA },
  };
}

function textReq(model: string): ModelRequestDraft {
  return {
    model,
    messages: [{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }],
  };
}

function done(): StreamEvent {
  return { kind: "done", message: assistantText("ok") };
}

function streamOf(events: StreamEvent[]): LlmStream {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

interface FakeLlm {
  llm: Llm;
  calls: ModelRequestDraft[];
}

/** A recording inner seam. The handler runs on every call (1-based index). */
function fakeLlm(handler: (req: ModelRequestDraft, call: number) => LlmStream | Promise<LlmStream>): FakeLlm {
  const calls: ModelRequestDraft[] = [];
  return {
    calls,
    llm: {
      async generate(req: ModelRequestDraft): Promise<LlmStream> {
        calls.push(req);
        return await handler(req, calls.length);
      },
    },
  };
}

function hasImageBlock(req: ModelRequestDraft): boolean {
  return req.messages.some((m) => m.content.some((p) => p.type === "image"));
}

describe("W855 image downgrade triggers", () => {
  it("(a) configured_text_only: zero image-bearing calls, placeholders, exactly one downgrade", async () => {
    const fake = fakeLlm(() => streamOf([done()]));
    const events: ImageDowngradeInfo[] = [];
    const llm = createImageDowngradeLlm({
      inner: fake.llm,
      isTextOnly: (model) => model === "text-model",
      onDowngrade: (info) => events.push(info),
    });

    const collected = await collectStream(await llm.generate(imageReq("text-model")));
    expect(collected.at(-1)).toMatchObject({ kind: "done" });

    // The image-bearing upstream call NEVER happens; the only call is the
    // placeholder rewrite (which carries no image and drops the byte table).
    expect(fake.calls.filter(hasImageBlock)).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.images).toBeUndefined();
    expect(JSON.stringify(fake.calls[0]?.messages)).toContain("图片已省略");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "IMAGE_UNSUPPORTED",
      cause: "configured_text_only",
      httpStatus: null,
    });
    expect(events[0]?.placeholder).toContain("[图片已省略：");
  });

  it("(b) timeout: downgrades on a response-header timeout and the retry has no image block", async () => {
    const fake = fakeLlm((_req, call) => {
      if (call === 1) throw responseHeaderTimeoutError(60_000, "http://upstream.test/v1/chat/completions");
      return streamOf([done()]);
    });
    const events: ImageDowngradeInfo[] = [];
    const llm = createImageDowngradeLlm({ inner: fake.llm, onDowngrade: (info) => events.push(info) });

    const collected = await collectStream(await llm.generate(imageReq("deepseek-v4-flash-0731")));
    expect(collected.at(-1)).toMatchObject({ kind: "done" });

    expect(fake.calls).toHaveLength(2);
    expect(hasImageBlock(fake.calls[0]!)).toBe(true);
    expect(hasImageBlock(fake.calls[1]!)).toBe(false);
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain("图片已省略");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "IMAGE_UNSUPPORTED", cause: "timeout", httpStatus: null });
    // The timeout text is carried VERBATIM (threshold included, not hardcoded).
    expect(events[0]?.message).toContain("response headers not received within 60000ms");
  });

  it("(c) connect timeout / mid-stream failure / 401 rethrow unchanged with zero downgrades", async () => {
    const cases: Array<[string, () => unknown]> = [
      ["connect timeout", () => connectTimeoutError(15_000, "http://upstream.test/v1/chat/completions")],
      ["mid-stream failure", () => new LlmError("stream failed: decode error", "stream")],
      ["401", () => statusError(401, "401 Unauthorized", "invalid api key")],
    ];
    for (const [label, makeError] of cases) {
      const error = makeError();
      const fake = fakeLlm(() => {
        throw error;
      });
      const events: ImageDowngradeInfo[] = [];
      const llm = createImageDowngradeLlm({ inner: fake.llm, onDowngrade: (info) => events.push(info) });

      let thrown: unknown = null;
      try {
        await llm.generate(imageReq("m"));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, label).toBe(error);
      expect(fake.calls, label).toHaveLength(1);
      expect(events, label).toHaveLength(0);
    }
  });

  it("(d) a text-only request is forwarded untouched with no downgrade and no rewrite", async () => {
    const req = textReq("m");
    const fake = fakeLlm(() => streamOf([done()]));
    const events: ImageDowngradeInfo[] = [];
    const llm = createImageDowngradeLlm({
      inner: fake.llm,
      isTextOnly: () => true,
      onDowngrade: (info) => events.push(info),
    });

    await collectStream(await llm.generate(req));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toBe(req);
    expect(events).toHaveLength(0);
  });

  it("(e) an unconfigured model stays optimistic: the image is sent, nothing downgrades", async () => {
    const fake = fakeLlm(() => streamOf([done()]));
    const events: ImageDowngradeInfo[] = [];
    const llm = createImageDowngradeLlm({
      inner: fake.llm,
      isTextOnly: () => false,
      onDowngrade: (info) => events.push(info),
    });

    await collectStream(await llm.generate(imageReq("unknown-model")));
    expect(fake.calls).toHaveLength(1);
    expect(hasImageBlock(fake.calls[0]!)).toBe(true);
    expect(events).toHaveLength(0);
  });
});
