/**
 * read_image (W804, multimodal P0 section 6) — read an image from the session's
 * attachments or from the sandbox roots and hand it to a vision-capable model.
 *
 * Two channels (section 6.3):
 *   1. the tool VALUE (persisted, logged): metadata plus value.attachments — a
 *      list of [ImageRef]s. It NEVER contains bytes.
 *   2. the model-visible image block: deriveMessagesFrom reads value.attachments
 *      and projects an ImageContent onto the same tool message; the wire layer
 *      then delivers it in a following user message (shape B, section 3.3).
 *
 * The capability gate (section 6.6) is OPTIMISTIC: the host passes
 * imageInputAllowed = false only when the target model was EXPLICITLY configured
 * with input_modalities excluding "image". An optimistic default that the
 * upstream rejects is handled by the section 7.6 downgrade, not here.
 */

import { open } from "node:fs/promises";
import { basename } from "node:path";

import type { Tool, ToolExecOutcome, ToolSpec } from "@celestea/core";

import { optionalStringArg } from "../args.js";
import { descParam } from "../desc.js";
import { contractFailure, isToolFailure } from "../errors.js";
import { ATTACHMENT_MAX_BYTES, AttachmentError, type AttachmentStore } from "../attachments/store.js";

/** The frozen contract description; mirrored by contracts/tools.json. */
export const READ_IMAGE_DESCRIPTION =
  "Read an image (PNG/JPEG/WebP/GIF) and attach it to the conversation so a vision-capable model can see it. Returns metadata; the image content block is delivered with the tool result. Fails on models without image input.";

export interface ReadImageToolOptions {
  /** The session's content-addressed store; the tool cannot exist without it. */
  attachments: AttachmentStore;
  /**
   * false = the target model's input_modalities was EXPLICITLY configured without
   * "image"; the tool then refuses before touching any file (section 6.6).
   */
  imageInputAllowed?: boolean;
  /** The model id, for the refusal text (the user must be able to switch). */
  model?: string;
}

export function readImageSpec(): ToolSpec {
  return {
    name: "read_image",
    description: READ_IMAGE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Filesystem path of the image to read (PNG/JPEG/WebP/GIF; format detected by content, not extension).",
        },
        attachment_id: {
          type: "string",
          description: "Content-addressed id of an already-uploaded attachment (from a user message). Use instead of path.",
        },
        desc: descParam(),
      },
      required: [],
      additionalProperties: false,
    },
  };
}

async function run(args: unknown, options: ReadImageToolOptions): Promise<ToolExecOutcome> {
  if (options.imageInputAllowed === false) {
    const model = options.model !== undefined && options.model !== "" ? options.model : "unknown";
    throw contractFailure(
      "read_image",
      "unsupported_modality",
      `当前模型 "${model}" 的 input_modalities 未包含 image（按配置显式排除），read_image 未执行。\n请改用文本工具，或在该模型的 provider 设置里打开 input_modalities（加入 "image"）。`,
    );
  }
  const path = optionalStringArg(args, "path");
  const attachmentId = optionalStringArg(args, "attachment_id");
  if ((path === undefined) === (attachmentId === undefined)) {
    throw contractFailure("read_image", "invalid_arg", "exactly one of 'path' or 'attachment_id' is required");
  }

  let bytes: Buffer;
  let name: string | undefined;
  let sourcePath: string | null = null;
  if (path !== undefined) {
    bytes = await readBoundedImage(path);
    name = basename(path);
    sourcePath = path;
  } else {
    const found = await options.attachments.readById(attachmentId as string);
    if (found === null) {
      throw contractFailure("read_image", "not_found", `attachment '${attachmentId as string}' was not found in this session`);
    }
    bytes = found.bytes;
    name = found.ref.name;
  }

  let ref;
  try {
    ref = await options.attachments.put({ bytes, ...(name === undefined || name === "" ? {} : { name }) });
  } catch (e) {
    if (e instanceof AttachmentError) throw contractFailure("read_image", e.code, e.message);
    throw e;
  }

  const value: Record<string, unknown> = {
    ok: true,
    ...(sourcePath === null ? {} : { path: sourcePath }),
    media_type: ref.media_type,
    bytes: bytes.length,
    width: ref.width,
    height: ref.height,
    sha256: ref.attachment_id,
    attachment_id: ref.attachment_id,
    attachments: [ref],
  };
  const render = `read image ${ref.media_type} ${ref.width}x${ref.height} (${bytes.length} bytes)`;
  return { value, render };
}

/**
 * B2 / W812 P1-3 (R3): read the image with a HARD byte ceiling. The attachment
 * store already rejects >4 MiB, but only AFTER the whole file was buffered, so a
 * huge path would spike RSS (or OOM) before that check ran. Open + stat + read
 * at most the cap, so the oversize case never allocates the file at all.
 */
async function readBoundedImage(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    throw contractFailure("read_image", "io", `cannot read '${path}': ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) throw contractFailure("read_image", "io", `'${path}' is a directory, not a file`);
    if (info.size > ATTACHMENT_MAX_BYTES) {
      throw contractFailure(
        "read_image",
        "too_large",
        `image is ${info.size} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte limit`,
      );
    }
    const size = Number(info.size);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } catch (e) {
    if (isToolFailure(e)) throw e;
    throw contractFailure("read_image", "io", `cannot read '${path}': ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function readImageTool(options: ReadImageToolOptions): Tool {
  const spec = readImageSpec();
  return {
    spec: () => spec,
    execute: async (args) => (await run(args, options)).value,
    executeWith: async (input) => run(input.args, options),
  };
}
