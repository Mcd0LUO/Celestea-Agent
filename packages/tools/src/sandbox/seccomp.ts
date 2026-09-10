/**
 * Pure-TS cBPF seccomp whitelist (W274 §3.6), handed to `bwrap --seccomp FD`.
 *
 * Classic BPF needs no native addon and no helper process: 8 bytes per
 * instruction (`u16 code | u8 jt | u8 jf | u32 k`, little-endian) written to a
 * regular file whose fd is passed as fd 3. The instruction stream is a
 * field-for-field port of the engine's `seccomp_v2` builder, so the two sandboxes
 * deny the same syscalls.
 *
 * Semantics: x86_64 only; unknown arch → `EPERM`; x32-flagged numbers → `EPERM`;
 * everything outside the whitelist → `EPERM`, except `clone3` → `ENOSYS` (so
 * glibc falls back to `clone` instead of failing outright).
 */

import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_JGE = 0x30;
const BPF_RET = 0x06;
const BPF_K = 0x00;

const AUDIT_ARCH_X86_64 = 0xc000_003e;
const X32_BIT = 0x4000_0000;
const RET_ALLOW = 0x7fff_0000;
const RET_EPERM = 0x0005_0001;
const RET_ENOSYS = 0x0005_0026;
const SYSCALL_CLONE3 = 435;

/** x86_64 syscall numbers the sandbox allows (engine `ALLOW` table). */
const ALLOWED_SYSCALLS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  32, 33, 35, 38, 39, 40, 42, 56, 57, 58, 59, 60, 61, 62, 63, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,
  84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 102, 104, 107, 108, 109, 110, 111, 112,
  118, 120, 121, 131, 137, 138, 157, 158, 160, 186, 202, 203, 204, 217, 218, 219, 228, 229, 230, 231, 232, 233,
  234, 235, 247, 253, 254, 255, 257, 258, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 273, 274,
  276, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 302, 306, 315, 318,
  322, 324, 326, 327, 328, 332, 334, 437, 439, 452,
];

export interface BpfInstruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

const stmt = (code: number, k: number): BpfInstruction => ({ code, jt: 0, jf: 0, k });
const jump = (code: number, jt: number, jf: number, k: number): BpfInstruction => ({ code, jt, jf, k });

/** The full filter: 4 header/jump slots + 2 per allowed syscall + 3 tail slots. */
export function buildSeccompFilter(): BpfInstruction[] {
  const program: BpfInstruction[] = [
    stmt(BPF_LD | BPF_W | BPF_ABS, 4),
    jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, AUDIT_ARCH_X86_64),
    stmt(BPF_LD | BPF_W | BPF_ABS, 0),
    jump(BPF_JMP | BPF_JGE | BPF_K, 0, 1, X32_BIT),
    stmt(BPF_RET | BPF_K, RET_EPERM),
  ];
  for (const nr of ALLOWED_SYSCALLS) {
    program.push(jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr), stmt(BPF_RET | BPF_K, RET_ALLOW));
  }
  program.push(jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, SYSCALL_CLONE3), stmt(BPF_RET | BPF_K, RET_ENOSYS));
  program.push(stmt(BPF_RET | BPF_K, RET_EPERM));
  return program;
}

/** Serialize to the blob `bwrap --seccomp FD` expects. */
export function toBlobBytes(program: BpfInstruction[] = buildSeccompFilter()): Buffer {
  const out = Buffer.alloc(program.length * 8);
  program.forEach((ins, i) => {
    const at = i * 8;
    out.writeUInt16LE(ins.code, at);
    out.writeUInt8(ins.jt, at + 2);
    out.writeUInt8(ins.jf, at + 3);
    out.writeUInt32LE(ins.k >>> 0, at + 4);
  });
  return out;
}

export function instructionCount(program: BpfInstruction[] = buildSeccompFilter()): number {
  return program.length;
}

export interface SeccompBlobHandle {
  /** Open read-only fd, passed to the child as fd 3 (`--seccomp 3`). */
  readonly fd: number;
  dispose(): void;
}

let counter = 0;

/**
 * Materialize the filter in a private temp file and open it. The caller must
 * call `dispose()` after spawn (the child holds its own dup of the fd).
 */
export function openSeccompBlob(dir: string = tmpdir()): SeccompBlobHandle {
  counter += 1;
  const path = join(dir, `celestea-seccomp-${process.pid}-${Date.now()}-${counter}.bpf`);
  writeFileSync(path, toBlobBytes(), { mode: 0o600 });
  const fd = openSync(path, "r");
  return {
    fd,
    dispose: () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}
