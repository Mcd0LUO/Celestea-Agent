/**
 * W847 W0: the third-party header parser -> in-repo header parser replacement, pinned
 * against the OLD dependency's output.
 *
 * The expected {width,height} below were frozen by running the removed parser over
 * this exact corpus before it was removed (the raw probe output is in
 * results/W847-W0分批升级.md). The test never imports the removed parser, so the
 * values are the counter-proof: the new parser must reproduce dimensions it did
 * not compute from itself.
 *
 * The corpus is synthetic on purpose: the header parser only reads headers, and
 * building the exact header bytes lets every format's arithmetic be covered
 * (including Apple CgBI PNG, VP8X/VP8/VP8L WebP and SOF0 JPEG).
 */
import { describe, expect, it } from "vitest";

import { AttachmentError } from "./store.js";
import { readImageHeader } from "./image-header.js";
import { readImageDimensions } from "./store.js";

const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};
const u16le = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
};
const u24le = (n: number): Buffer => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(w: number, h: number): Buffer {
  return Buffer.concat([PNG_SIG, u32be(13), Buffer.from("IHDR"), u32be(w), u32be(h), Buffer.alloc(5)]);
}
/** Apple's CgBI wrapper: the IHDR name sits at offset 28, width at 32/height 36. */
function pngCgBI(w: number, h: number): Buffer {
  return Buffer.concat([
    PNG_SIG,
    u32be(8),
    Buffer.from("CgBI"),
    Buffer.alloc(8),
    u32be(13),
    Buffer.from("IHDR"),
    u32be(w),
    u32be(h),
    Buffer.alloc(5),
  ]);
}
function gif(w: number, h: number): Buffer {
  return Buffer.concat([Buffer.from("GIF89a"), u16le(w), u16le(h), Buffer.from([0, 0, 0])]);
}
function webpVp8x(w: number, h: number): Buffer {
  const payload = Buffer.concat([Buffer.from([0, 0, 0, 0]), u24le(w - 1), u24le(h - 1)]);
  const chunk = Buffer.concat([Buffer.from("VP8X"), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}
function webpLossy(w: number, h: number): Buffer {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h)]);
  const chunk = Buffer.concat([Buffer.from("VP8 "), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}
function webpLossless(w: number, h: number): Buffer {
  const w1 = w - 1;
  const h1 = h - 1;
  const payload = Buffer.from([
    0x2f,
    w1 & 0xff,
    ((w1 >> 8) & 0x3f) | ((h1 & 0x3) << 6),
    (h1 >> 2) & 0xff,
    (h1 >> 10) & 0xf,
    0,
    0,
    0,
    0,
    0,
  ]);
  const chunk = Buffer.concat([Buffer.from("VP8L"), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}
/** SOF0 JPEG: the scan finds FF C0 after a 16-byte APP0 and reads height/width. */
function jpeg(w: number, h: number): Buffer {
  const b = Buffer.alloc(29);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  b[4] = 0x00;
  b[5] = 0x10;
  b[20] = 0xff;
  b[21] = 0xc0;
  b[22] = 0x00;
  b[23] = 0x11;
  b[24] = 0x08;
  b.writeUInt16BE(h, 25);
  b.writeUInt16BE(w, 27);
  return b;
}

/** A real 1x1 PNG (existing test fixture) so at least one case is not synthetic. */
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** expected = removed parser output over the same bytes (frozen before removal). */
const CASES: Array<{ name: string; bytes: Buffer; width: number; height: number }> = [
  { name: "real png 1x1", bytes: REAL_PNG, width: 1, height: 1 },
  { name: "png 1x1", bytes: png(1, 1), width: 1, height: 1 },
  { name: "png 640x480", bytes: png(640, 480), width: 640, height: 480 },
  { name: "png 8192x1", bytes: png(8192, 1), width: 8192, height: 1 },
  { name: "png CgBI 12x7", bytes: pngCgBI(12, 7), width: 12, height: 7 },
  { name: "gif 1x1", bytes: gif(1, 1), width: 1, height: 1 },
  { name: "gif 320x200", bytes: gif(320, 200), width: 320, height: 200 },
  { name: "webp VP8X 640x480", bytes: webpVp8x(640, 480), width: 640, height: 480 },
  { name: "webp lossy 5x4", bytes: webpLossy(5, 4), width: 5, height: 4 },
  { name: "webp lossless 3x2", bytes: webpLossless(3, 2), width: 3, height: 2 },
  { name: "jpeg 1x1", bytes: jpeg(1, 1), width: 1, height: 1 },
  { name: "jpeg 640x480", bytes: jpeg(640, 480), width: 640, height: 480 },
];

const MALFORMED: Array<{ name: string; bytes: Buffer }> = [
  {
    name: "truncated png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0, 0, 0, 0]),
  },
  {
    name: "jpeg without SOF",
    bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(20), Buffer.from([0xff, 0xd9])]),
  },
  { name: "webp with bad VP8X flags", bytes: badVp8x() },
  { name: "not an image", bytes: Buffer.from("not an image") },
];

function badVp8x(): Buffer {
  const payload = Buffer.concat([Buffer.from([0xc0, 0, 0, 0]), u24le(9), u24le(9)]);
  const chunk = Buffer.concat([Buffer.from("VP8X"), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

describe("W847 W0 · in-repo parser equals the frozen pre-removal output", () => {
  it("reproduces every frozen dimension", () => {
    for (const c of CASES) {
      expect(readImageHeader(c.bytes), c.name).toEqual({ width: c.width, height: c.height });
    }
  });

  it("throws on malformed headers", () => {
    for (const c of MALFORMED) {
      expect(() => readImageHeader(c.bytes), c.name).toThrowError();
    }
  });

  it("the store wrapper maps a malformed header to decode_failed", () => {
    for (const c of MALFORMED) {
      expect(() => readImageDimensions(c.bytes), c.name).toThrowError(AttachmentError);
      try {
        readImageDimensions(c.bytes);
      } catch (e) {
        expect((e as AttachmentError).code, c.name).toBe("decode_failed");
      }
    }
  });

  it("the store wrapper returns the same dimensions for a valid image", () => {
    expect(readImageDimensions(CASES[1]!.bytes)).toEqual({ width: 1, height: 1 });
    expect(readImageDimensions(CASES[3]!.bytes)).toEqual({ width: 8192, height: 1 });
  });
});

