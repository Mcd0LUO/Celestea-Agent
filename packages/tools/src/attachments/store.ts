/**
 * W804 (multimodal P0 section 5): the per-session, content-addressed attachment
 * store.
 *
 * Layout: <session-dir>/attachments/<sha256>.<ext>. The session directory is
 * renamed wholesale by trash/archive, so attachments follow it with no second
 * lifecycle. Bytes NEVER enter the session log: the log carries only an
 * [ImageRef].
 *
 * P0 scope (user decision 2026-09-16): sniff the four magic-byte formats, reject
 * oversize/oversized-pixel inputs, store the ORIGINAL bytes unchanged (no
 * re-encode, no downscale). Dimensions are read from the header via image-size.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { imageSize } from "image-size";
import type { ImageMediaType, ImageRef } from "@celestea/core";

/** Directory name under the session dir. */
export const ATTACHMENTS_DIRNAME = "attachments";
/** P0 stored-byte ceiling (section 5.3 "bytes <= 4 MiB", original bytes). */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
/** P0 decoded-pixel ceiling (decompression-bomb guard). */
export const ATTACHMENT_MAX_PIXELS = 40_000_000;
/** P0 single-side pixel ceiling. */
export const ATTACHMENT_MAX_SIDE = 8192;

export type AttachmentErrorCode =
  | "unsupported_media_type"
  | "too_large"
  | "too_many_pixels"
  | "decode_failed"
  | "not_found"
  | "io";

/** A structured attachment failure; read_image maps it onto a ToolFailure. */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Magic-byte sniffing (section 5.4): the extension is NEVER trusted. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6) {
    const head = b.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Header-only dimensions; a header image-size cannot read is a decode failure. */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  let out: { width?: number; height?: number };
  try {
    out = imageSize(bytes) as { width?: number; height?: number };
  } catch (e) {
    throw new AttachmentError("decode_failed", `cannot read image header: ${e instanceof Error ? e.message : String(e)}`);
  }
  const width = out.width ?? 0;
  const height = out.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AttachmentError("decode_failed", "image header carries no usable dimensions");
  }
  return { width, height };
}

/** One already-stored attachment: its reference plus the raw bytes. */
export interface StoredAttachment {
  ref: ImageRef;
  bytes: Buffer;
}

export interface AttachmentStore {
  /** The attachments/ directory this store owns. */
  readonly dir: string;
  /** Validate + content-address + atomically store one image; returns its ref. */
  put(input: { bytes: Uint8Array; name?: string }): Promise<ImageRef>;
  /** Bytes by attachment_id (scans the directory for <id>.<ext>); null = absent. */
  readById(id: string): Promise<StoredAttachment | null>;
  /** A data URL for the request-time projection, or null when absent. */
  readDataUrl(id: string): Promise<string | null>;
}

/** Create the store over one session's attachments/ directory. */
export function createAttachmentStore(dir: string): AttachmentStore {
  return {
    dir,
    async put(input: { bytes: Uint8Array; name?: string }): Promise<ImageRef> {
      const bytes = Buffer.isBuffer(input.bytes)
        ? input.bytes
        : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
      if (bytes.length === 0) throw new AttachmentError("decode_failed", "the image is empty");
      const media = sniffImageMediaType(bytes);
      if (media === null) {
        throw new AttachmentError("unsupported_media_type", "unsupported image format (expected PNG, JPEG, WebP or GIF, detected by content)");
      }
      if (bytes.length > ATTACHMENT_MAX_BYTES) {
        throw new AttachmentError("too_large", `image is ${bytes.length} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte limit`);
      }
      const { width, height } = readImageDimensions(bytes);
      if (width > ATTACHMENT_MAX_SIDE || height > ATTACHMENT_MAX_SIDE || width * height > ATTACHMENT_MAX_PIXELS) {
        throw new AttachmentError("too_many_pixels", `image is ${width}x${height}, over the pixel limit`);
      }
      const id = createHash("sha256").update(bytes).digest("hex");
      const ref: ImageRef = { attachment_id: id, media_type: media, width, height };
      if (input.name !== undefined && input.name !== "") ref.name = input.name;
      const target = join(dir, `${id}.${EXTENSIONS[media]}`);
      await mkdir(dir, { recursive: true });
      // Content addressing dedupes within the session: the same bytes are one file.
      let exists = false;
      try {
        const entries = await readdir(dir);
        exists = entries.includes(`${id}.${EXTENSIONS[media]}`);
      } catch {
        exists = false;
      }
      if (!exists) {
        const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, bytes);
        try {
          await rename(tmp, target);
        } catch (e) {
          await unlink(tmp).catch(() => undefined);
          throw new AttachmentError("io", `cannot store attachment: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return ref;
    },

    async readById(id: string): Promise<StoredAttachment | null> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return null;
      }
      const name = entries.find((entry) => entry.startsWith(`${id}.`));
      if (name === undefined) return null;
      const bytes = await readFile(join(dir, name));
      const media = sniffImageMediaType(bytes);
      if (media === null) return null;
      const { width, height } = readImageDimensions(bytes);
      return { ref: { attachment_id: id, media_type: media, width, height }, bytes };
    },

    async readDataUrl(id: string): Promise<string | null> {
      const found = await this.readById(id);
      if (found === null) return null;
      return `data:${found.ref.media_type};base64,${found.bytes.toString("base64")}`;
    },
  };
}
