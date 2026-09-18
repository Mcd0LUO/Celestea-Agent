/**
 * W847 W0: in-repo, header-only image dimensions for the four attachment formats
 * (PNG / JPEG / WebP / GIF).
 *
 * WHY THIS EXISTS: the attachment store only ever feeds bytes that
 * `sniffImageMediaType` already accepted, so those four sniffed formats are the
 * entire surface. Replacing that third-party dependency with this port removes
 * the only external runtime dependency of packages/*. The offsets and branch order
 * are a faithful port of the removed parser (MIT) for exactly those four types, so
 * {width,height} of a stored image stays byte-for-byte identical (see
 * image-header.test.ts, whose expected values were frozen from the dependency
 * before it was removed).
 */
import type { ImageMediaType } from "@celestea/core";

/** A header that cannot be parsed as one of the four sniffed formats. */
export class ImageHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageHeaderError";
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** ASCII compare window (the compared literals are ASCII, so latin1 is exact). */
function ascii(b: Buffer, start: number, end: number): string {
  return b.subarray(start, end).toString("latin1");
}

function hex(b: Buffer, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    out += (b[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function u16le(b: Buffer, offset: number): number {
  return b.readUInt16LE(offset);
}
function i16le(b: Buffer, offset: number): number {
  return b.readInt16LE(offset);
}
function u24le(b: Buffer, offset: number): number {
  return b.readUInt16LE(offset) + ((b[offset + 2] ?? 0) << 16);
}

/** the removed parser PNG.validate + calculate, including Apple's CgBI layout. */
function pngSize(b: Buffer): { width: number; height: number } {
  if (ascii(b, 1, 8) !== "PNG\r\n\u001a\n") throw new ImageHeaderError("Invalid PNG");
  let chunkName = ascii(b, 12, 16);
  if (chunkName === "CgBI") chunkName = ascii(b, 28, 32);
  if (chunkName !== "IHDR") throw new ImageHeaderError("Invalid PNG");
  if (ascii(b, 12, 16) === "CgBI") return { width: b.readUInt32BE(32), height: b.readUInt32BE(36) };
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** the removed parser GIF.validate + calculate (logical screen descriptor). */
function gifSize(b: Buffer): { width: number; height: number } {
  if (!/^GIF8[79]a/.test(ascii(b, 0, 6))) throw new ImageHeaderError("Invalid GIF");
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** the removed parser WEBP.validate + calculate (VP8X / VP8 / VP8L chunks). */
function webpSize(b: Buffer): { width: number; height: number } {
  if (!(ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" && ascii(b, 12, 15) === "VP8")) {
    throw new ImageHeaderError("Invalid WebP");
  }
  const chunkHeader = ascii(b, 12, 16);
  const input = b.subarray(20, 30);
  if (chunkHeader === "VP8X") {
    const flags = input[0] ?? 0;
    if ((flags & 0xc0) === 0 && (flags & 0x01) === 0) {
      return { width: 1 + u24le(input, 4), height: 1 + u24le(input, 7) };
    }
    throw new ImageHeaderError("Invalid WebP");
  }
  if (chunkHeader === "VP8 " && (input[0] ?? 0) !== 0x2f) {
    return { width: i16le(input, 6) & 0x3fff, height: i16le(input, 8) & 0x3fff };
  }
  if (chunkHeader === "VP8L" && hex(input, 3, 6) !== "9d012a") {
    const b1 = input[1] ?? 0;
    const b2 = input[2] ?? 0;
    const b3 = input[3] ?? 0;
    const b4 = input[4] ?? 0;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  throw new ImageHeaderError("Invalid WebP");
}

function readUInt(b: Buffer, bits: 16 | 32, offset: number, bigEndian: boolean): number {
  if (bits === 16) return bigEndian ? b.readUInt16BE(offset) : b.readUInt16LE(offset);
  return bigEndian ? b.readUInt32BE(offset) : b.readUInt32LE(offset);
}

/**
 * the removed parser JPEG EXIF orientation scan. The returned orientation never
 * changes the dimensions, but parsing it (and failing on a corrupt block exactly
 * like the dependency did) is part of byte-for-byte parity.
 */
function readJpegExif(input: Buffer, index: number): void {
  const exifBlock = input.subarray(2, index);
  const align = hex(exifBlock, 6, 8);
  const bigEndian = align === "4d4d";
  const littleEndian = align === "4949";
  if (!bigEndian && !littleEndian) return;
  const entries = readUInt(exifBlock, 16, 14, bigEndian);
  for (let n = 0; n < entries; n += 1) {
    const start = 14 + 2 + n * 12;
    if (start > exifBlock.length) return;
    const block = exifBlock.subarray(start, start + 12);
    if (readUInt(block, 16, 0, bigEndian) !== 274) continue;
    if (readUInt(block, 16, 2, bigEndian) !== 3) return;
    if (readUInt(block, 32, 4, bigEndian) !== 1) return;
    readUInt(block, 16, 8, bigEndian);
    return;
  }
}

/** the removed parser JPG.validate + calculate (SOF0/SOF1/SOF2 scan). */
function jpegSize(b: Buffer): { width: number; height: number } {
  let input = b.subarray(4);
  while (input.length > 0) {
    const i = input.readUInt16BE(0);
    if (i > input.length) throw new ImageHeaderError("Corrupt JPG, exceeded buffer limits");
    if (input[i] !== 0xff) {
      input = input.subarray(1);
      continue;
    }
    if (hex(input, 2, 6) === "45786966") readJpegExif(input, i);
    const next = input[i + 1];
    if (next === 0xc0 || next === 0xc1 || next === 0xc2) {
      return { width: input.readUInt16BE(i + 7), height: input.readUInt16BE(i + 5) };
    }
    input = input.subarray(i + 2);
  }
  throw new ImageHeaderError("Invalid JPG, no size found");
}

/**
 * Dimensions from a PNG / JPEG / WebP / GIF header. Throws ImageHeaderError when
 * the bytes are not one of the four sniffed formats or the header is unreadable.
 */
export function readImageHeader(bytes: Uint8Array): { width: number; height: number } {
  const b = asBuffer(bytes);
  if (ascii(b, 1, 8) === "PNG\r\n\u001a\n") return pngSize(b);
  if (hex(b, 0, 2) === "ffd8") return jpegSize(b);
  if (/^GIF8[79]a/.test(ascii(b, 0, 6))) return gifSize(b);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return webpSize(b);
  throw new ImageHeaderError("unsupported image format");
}

/** Re-exported for callers that switch on the detected type. */
export type { ImageMediaType };

