/**
 * B2 (F3 P1) — the filesystem store behind `remember` / `forget`.
 *
 * One workspace's GLOBAL memory folder holds the append-only `entries.jsonl`
 * (source of truth) and the rendered `MEMORY.md` (what the read side injects).
 * The store is the ONLY impure surface of the write side: [MemoryStoreIo] is
 * injected so tests drive the whole append/dedup/tombstone/render flow on a fake
 * filesystem, and so a host embedding can choose a different root.
 *
 * The project layer (`<ws>/.celestea/memory/`) is read-only by contract
 * (celestea-sources.ts), so only the global layer is ever written here.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { CelesteaHomeInput } from "@celestea/core";

import {
  foldMemoryLog,
  memoryEntryPaths,
  memoryLogHeader,
  parseMemoryLog,
  renderMemoryMarkdown,
  serializeMemoryLine,
  type MemoryLogLine,
  type MemoryLogState,
} from "../memory/log.js";

/** The thin filesystem seam (injected for tests). */
export interface MemoryStoreIo {
  /** File text, or null when it does not exist / cannot be read. */
  readText(file: string): string | null;
  /** Create the directory (recursive); existing is fine. */
  ensureDir(dir: string): void;
  /** Append text to a file, creating it. */
  append(file: string, text: string): void;
  /** Replace a file's whole content. */
  write(file: string, text: string): void;
}

/** Real filesystem. */
export const nodeMemoryStoreIo: MemoryStoreIo = {
  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
  },
  append(file, text) {
    appendFileSync(file, text, "utf8");
  },
  write(file, text) {
    writeFileSync(file, text, "utf8");
  },
};

/** Absolute paths + the io seam, resolved once per tool instance. */
export interface MemoryStore {
  paths: { dir: string; entries: string; memory: string };
  io: MemoryStoreIo;
}

/** Build a store for one workspace (GLOBAL layer only). */
export function memoryStoreOf(wsPath: string, input: CelesteaHomeInput = {}, io: MemoryStoreIo = nodeMemoryStoreIo): MemoryStore {
  return { paths: memoryEntryPaths(wsPath, input), io };
}

/** The current log lines of a store (empty when the file does not exist yet). */
export function readMemoryLog(store: MemoryStore): MemoryLogLine[] {
  const text = store.io.readText(store.paths.entries);
  return text === null ? [] : parseMemoryLog(text);
}

/** The effective state of a store. */
export function readMemoryState(store: MemoryStore): MemoryLogState {
  return foldMemoryLog(readMemoryLog(store));
}

/**
 * Append one line to the log and re-render `MEMORY.md` from the folded result.
 * The header is written the first time the log is created. Returns the new state.
 */
export function appendMemoryLine(store: MemoryStore, line: MemoryLogLine): MemoryLogState {
  const first = store.io.readText(store.paths.entries) === null;
  store.io.ensureDir(store.paths.dir);
  if (first) store.io.append(store.paths.entries, memoryLogHeader());
  store.io.append(store.paths.entries, serializeMemoryLine(line));
  const state = readMemoryState(store);
  store.io.write(store.paths.memory, renderMemoryMarkdown(state.entries));
  return state;
}
