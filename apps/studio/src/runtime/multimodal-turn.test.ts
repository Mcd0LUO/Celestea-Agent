/**
 * W804 (multimodal P0, stage 5): POST /api/turn inline attachments end to end.
 *
 * REAL integration: the production engine factory, a real temp workspace, the
 * real Hono app, the real content-addressed store, a real turn through the real
 * agent loop, and the REAL session log on disk. The assertions pin the red line
 * mechanically (the log contains no base64) and the whole chain (stored bytes ->
 * log reference -> derived image block -> resolved data URL at the wire).
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@celestea/core";
import { activate, makeEngineHarness, readSessionLog, waitIdle } from "./test-util.js";
import { jsonRequest } from "../harness.test-util.js";

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SHA = createHash("sha256").update(PNG).digest("hex");

describe("W804 POST /api/turn inline attachments (real engine)", () => {
  it("stores the bytes, logs only the reference and makes the image model-visible", async () => {
    const requests: ModelRequest[] = [];
    const h = makeEngineHarness({ sessions: { att: [] }, llm: { onRequest: (req) => requests.push(req) } });
    await activate(h, "sample-ws/att");

    const res = await h.app.request(
      "/api/turn",
      jsonRequest("POST", { input: "看这张图", attachments: [{ data: PNG.toString("base64"), name: "dot.png" }] }),
    );
    expect(res.status).toBe(202);
    await waitIdle(h);

    // 1. the log carries the reference, never the bytes.
    const log = readSessionLog(h, "att");
    const user = log
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type?: string; text?: string; attachments?: Array<Record<string, unknown>> })
      .find((row) => row.type === "user_message" && Array.isArray(row.attachments));
    expect(user?.text).toBe("看这张图");
    expect(user?.attachments).toHaveLength(1);
    expect(user?.attachments?.[0]).toMatchObject({
      attachment_id: SHA,
      media_type: "image/png",
      width: 1,
      height: 1,
      name: "dot.png",
    });
    // RED LINE (mechanical): no data URL / base64 / raw PNG payload in the log.
    expect(log).not.toContain("data:");
    expect(log).not.toContain("base64");
    expect(log).not.toContain(PNG.toString("base64"));

    // 2. the bytes really are on disk under the session's attachments/.
    const dir = join(h.workspace, "att", "attachments");
    const files = readdirSync(dir);
    expect(files).toEqual([SHA + ".png"]);
    expect(readFileSync(join(dir, files[0]!)).equals(PNG)).toBe(true);

    // 3. the model saw an image content block AND the wire resolved its bytes.
    const withImage = requests.find((req) => req.messages.some((m) => m.content.some((c) => c.type === "image")));
    expect(withImage).toBeDefined();
    const image = withImage?.messages.flatMap((m) => m.content).find((c) => c.type === "image");
    expect(image).toMatchObject({ type: "image", content: { attachment_id: SHA, media_type: "image/png" } });
    const table = (withImage as unknown as { images?: Record<string, string> }).images;
    expect(table?.[SHA]).toContain("data:image/png;base64,");
  });

  it("accepts an attachment with EMPTY text (the empty-input 400 only applies without one)", async () => {
    const h = makeEngineHarness({ sessions: { att2: [] } });
    await activate(h, "sample-ws/att2");
    const res = await h.app.request("/api/turn", jsonRequest("POST", { input: "", attachments: [{ data: PNG.toString("base64") }] }));
    expect(res.status).toBe(202);
    await waitIdle(h);
    expect(readSessionLog(h, "att2")).toContain('"type":"user_message"');
  });

  it("still 400s an empty turn with no attachment, and rejects a non-image by content", async () => {
    const h = makeEngineHarness({ sessions: { att3: [] } });
    await activate(h, "sample-ws/att3");
    const empty = await h.app.request("/api/turn", jsonRequest("POST", { input: "  " }));
    expect(empty.status).toBe(400);
    const bad = await h.app.request(
      "/api/turn",
      jsonRequest("POST", { input: "x", attachments: [{ data: Buffer.from("not an image").toString("base64") }] }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("unsupported image format");
    // Nothing was written for the rejected request.
    expect(readdirSync(join(h.workspace, "att3")).filter((f) => f === "attachments")).toHaveLength(0);
  });
});
