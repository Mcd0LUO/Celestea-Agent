/**
 * tar.mjs — a tiny, zero-dependency reader for the .tgz files `pnpm pack`
 * produces. Used by `scripts/release-check.mjs` to inspect what actually ships.
 *
 * Only what the gate needs: the list of member paths and each regular file's
 * bytes. Handles the two extended-header forms pnpm's tar may emit (GNU
 * long-name 'L' and pax 'x'), skips directories, and ignores anything else.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** Read a NUL-terminated ASCII field from a 512-byte tar header. */
function field(header, start, length) {
  let end = start;
  while (end < start + length && header[end] !== 0) end += 1;
  return header.toString("latin1", start, end);
}

/** Parse a tar buffer into `Map<path, Buffer>` (regular files only). */
export function parseTar(buf) {
  const files = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    const sizeText = field(header, 124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
    } else if (type === "x") {
      const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(data.toString("utf8"));
      if (match !== null) longName = match[1];
    } else if (type === "0") {
      files.set(longName ?? name, data);
      longName = null;
    } else {
      longName = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Read a .tgz from disk into `Map<path, Buffer>`. */
export function readTarball(path) {
  return parseTar(gunzipSync(readFileSync(path)));
}

/** Decode a member as UTF-8 text (never throws on binary content). */
export function readText(files, name) {
  const buf = files.get(name);
  return buf === undefined ? null : buf.toString("utf8");
}
