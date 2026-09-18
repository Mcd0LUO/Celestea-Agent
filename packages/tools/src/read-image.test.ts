/**
 * W804 (multimodal P0, stage 4): read_image against a REAL filesystem.
 *
 * No mocks: a real mkdtemp directory, the real content-addressed store, the real
 * in-repo header parser and the real guarded registry. The assertions pin the
 * two channels (value carries only refs; the image block reaches derive) and the
 * red line (no base64 anywhere in the tool value / log row).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { deriveMessagesFrom, messageImages, type Sandbox, type SessionEvent } from "@celestea/core";
import { assembleTools, createAttachmentStore, sniffImageMediaType, type AttachmentStore } from "@celestea/tools";

/** A real 1x1 PNG (magic bytes + IHDR width/height = 1). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { dir: string; store: AttachmentStore } {
  const dir = mkdtempSync(join(tmpdir(), "w804-store-"));
  dirs.push(dir);
  return { dir, store: createAttachmentStore(join(dir, "attachments")) };
}

function stubSandbox(): Sandbox {
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024, workdir: "/tmp", root: "/tmp", extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W804: the read_image test never executes a command"));
  return { config, run: refuse, spawn: refuse };
}

function toolsWith(store: AttachmentStore, imageInputAllowed?: boolean) {
  return assembleTools({ guard: null, env: {}, sandbox: stubSandbox(), attachments: store, ...(imageInputAllowed === undefined ? {} : { imageInputAllowed }) });
}

describe("attachment store (real fs, content addressing)", () => {
  it("sniffs PNG, stores under <sha256>.png and reports dimensions", async () => {
    const { store } = tempStore();
    const ref = await store.put({ bytes: PNG_1X1, name: "dot.png" });
    expect(ref.media_type).toBe("image/png");
    expect(ref.width).toBe(1);
    expect(ref.height).toBe(1);
    expect(ref.name).toBe("dot.png");
    expect(ref.attachment_id).toMatch(/^[0-9a-f]{64}$/);
    const files = readdirSync(store.dir);
    expect(files).toEqual([ref.attachment_id + ".png"]);
    expect(readFileSync(join(store.dir, files[0]!)).equals(PNG_1X1)).toBe(true);
  });

  it("dedupes identical bytes to one file", async () => {
    const { store } = tempStore();
    const a = await store.put({ bytes: PNG_1X1, name: "a.png" });
    const b = await store.put({ bytes: PNG_1X1, name: "b.png" });
    expect(a.attachment_id).toBe(b.attachment_id);
    expect(readdirSync(store.dir)).toHaveLength(1);
  });

  it("rejects a non-image by content, never by extension", async () => {
    const { store } = tempStore();
    await expect(store.put({ bytes: Buffer.from("not an image") })).rejects.toMatchObject({ code: "unsupported_media_type" });
    expect(sniffImageMediaType(Buffer.from("\u0089PNG"))).toBeNull();
  });

  it("round-trips by id and yields a data URL only on demand", async () => {
    const { store } = tempStore();
    const ref = await store.put({ bytes: PNG_1X1 });
    const found = await store.readById(ref.attachment_id);
    expect(found?.ref.media_type).toBe("image/png");
    expect(found?.bytes.equals(PNG_1X1)).toBe(true);
    expect(await store.readDataUrl(ref.attachment_id)).toContain("data:image/png;base64,");
    expect(await store.readById("0".repeat(64))).toBeNull();
  });
});

describe("read_image tool (real registry dispatch)", () => {
  it("reads a local path, writes the store and returns refs only (no base64)", async () => {
    const { dir, store } = tempStore();
    const pngPath = join(dir, "logo.png");
    writeFileSync(pngPath, PNG_1X1);
    const tools = toolsWith(store);
    const out = await tools.registry.dispatch({ call_id: "c1", name: "read_image", args: { path: pngPath } });
    expect(out.error).toBeNull();
    const value = out.value as { ok: boolean; path: string; media_type: string; bytes: number; width: number; height: number; attachment_id: string; attachments: Array<{ attachment_id: string; media_type: string; width: number; height: number; name?: string }> };
    expect(value.ok).toBe(true);
    expect(value.path).toBe(pngPath);
    expect(value.media_type).toBe("image/png");
    expect(value.width).toBe(1);
    expect(value.height).toBe(1);
    expect(value.attachments).toHaveLength(1);
    expect(value.attachments[0]).toMatchObject({ media_type: "image/png", width: 1, height: 1, name: "logo.png" });
    // RED LINE: the persisted value carries references only.
    const json = JSON.stringify(value);
    expect(json).not.toContain("data:");
    expect(json).not.toContain("base64");
    expect(json).not.toContain(PNG_1X1.toString("base64"));
  });

  it("reads an already-uploaded attachment by id", async () => {
    const { store } = tempStore();
    const ref = await store.put({ bytes: PNG_1X1 });
    const tools = toolsWith(store);
    const out = await tools.registry.dispatch({ call_id: "c2", name: "read_image", args: { attachment_id: ref.attachment_id } });
    expect(out.error).toBeNull();
    expect((out.value as { attachment_id: string }).attachment_id).toBe(ref.attachment_id);
  });

  it("enforces the path XOR attachment_id and the explicit-exclusion gate", async () => {
    const { store } = tempStore();
    const tools = toolsWith(store);
    const neither = await tools.registry.dispatch({ call_id: "c3", name: "read_image", args: {} });
    expect(neither.error).toContain("code=invalid_arg");
    const both = await tools.registry.dispatch({ call_id: "c4", name: "read_image", args: { path: "/tmp/x.png", attachment_id: "a".repeat(64) } });
    expect(both.error).toContain("code=invalid_arg");

    const excluded = toolsWith(store, false);
    const gate = await excluded.registry.dispatch({ call_id: "c5", name: "read_image", args: { path: "/tmp/x.png" } });
    expect(gate.error).toContain("code=unsupported_modality");
    expect(gate.error).toContain("input_modalities");
  });

  it("maps a missing attachment to not_found and a bad file to io", async () => {
    const { store } = tempStore();
    const tools = toolsWith(store);
    const missing = await tools.registry.dispatch({ call_id: "c6", name: "read_image", args: { attachment_id: "b".repeat(64) } });
    expect(missing.error).toContain("code=not_found");
    const bad = await tools.registry.dispatch({ call_id: "c7", name: "read_image", args: { path: join(tmpdir(), "w804-does-not-exist.png") } });
    expect(bad.error).toContain("code=io");
  });

  it("projects the tool result into an image block, with no bytes in the log row", async () => {
    const { store } = tempStore();
    const ref = await store.put({ bytes: PNG_1X1, name: "dot.png" });
    const events: SessionEvent[] = [
      { type: "tool_call", id: "c1", name: "read_image", args: {} },
      { type: "tool_result", id: "c1", value: { ok: true, attachment_id: ref.attachment_id, attachments: [ref] }, error: null },
    ];
    const tool = deriveMessagesFrom(events).find((m) => m.role === "tool");
    expect(tool?.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(messageImages(tool!)).toEqual([ref]);
    expect(JSON.stringify(tool)).not.toContain("base64");
  });
});
