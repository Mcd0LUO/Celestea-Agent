/**
 * W274 spike - port of the Rust seccomp_v2 filter builder
 * (crates/tools/src/sandbox.rs:973-1057) to plain TypeScript/JS.
 *
 * The filter is classic BPF (cBPF), serialized as 8 bytes per instruction:
 *   u16 code (LE) | u8 jt | u8 jf | u32 k (LE)
 * That is exactly what `bwrap --seccomp FD` expects, so TS needs NO native
 * addon and NO external helper to reach seccomp parity: just fs.write to a
 * temp file and pass the fd.
 *
 * Verified byte-identical against the Rust `to_blob_bytes()` output.
 */

// BPF instruction classes / opcodes
const BPF_LD = 0x00, BPF_W = 0x00, BPF_ABS = 0x20;
const BPF_JMP = 0x05, BPF_JEQ = 0x10, BPF_JGE = 0x30;
const BPF_RET = 0x06, BPF_K = 0x00;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_BIT = 0x40000000;
const RET_ALLOW = 0x7fff0000;
const RET_EPERM = 0x00050001;
const RET_ENOSYS = 0x00050026;

/** @returns {{code:number,jt:number,jf:number,k:number}[]} */
export function buildSeccompFilter() {
  const stmt = (code, k) => ({ code, jt: 0, jf: 0, k });
  const jump = (code, jt, jf, k) => ({ code, jt, jf, k });

  // x86_64 syscall numbers allowed inside the sandbox (Rust ALLOW table).
  const ALLOW = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 32, 33, 35, 38, 39, 40, 42,
    56, 57, 58, 59, 60, 61, 62, 63, 72, 73, 74, 75, 76, 77, 78, 79, 80,
    81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
    98, 99, 100, 102, 104, 107, 108, 109, 110, 111, 112, 118, 120, 121,
    131, 137, 138, 157, 158, 160, 186, 202, 203, 204, 217, 218, 219, 228,
    229, 230, 231, 232, 233, 234, 235, 247, 253, 254, 255, 257, 258, 260,
    261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 273, 274, 276,
    280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293,
    294, 295, 296, 302, 306, 315, 318, 322, 324, 326, 327, 328, 332, 334,
    437, 439, 452,
  ];

  const p = [];
  p.push(stmt(BPF_LD | BPF_W | BPF_ABS, 4));          // load arch
  p.push(jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, AUDIT_ARCH_X86_64)); // != x86_64 -> errno
  p.push(stmt(BPF_LD | BPF_W | BPF_ABS, 0));          // load syscall nr
  p.push(jump(BPF_JMP | BPF_JGE | BPF_K, 0, 1, X32_BIT)); // x32 bit -> errno
  p.push(stmt(BPF_RET | BPF_K, RET_EPERM));           // default reject
  for (const nr of ALLOW) {
    p.push(jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr)); // == nr -> allow
    p.push(stmt(BPF_RET | BPF_K, RET_ALLOW));
  }
  p.push(jump(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 435));  // clone3 -> ENOSYS
  p.push(stmt(BPF_RET | BPF_K, RET_ENOSYS));
  p.push(stmt(BPF_RET | BPF_K, RET_EPERM));            // final reject
  return p;
}

/** Serialize to bubblewrap's `--seccomp FD` blob format. */
export function toBlobBytes(filter = buildSeccompFilter()) {
  const out = Buffer.alloc(filter.length * 8);
  filter.forEach((s, i) => {
    const o = i * 8;
    out.writeUInt16LE(s.code, o);
    out.writeUInt8(s.jt, o + 2);
    out.writeUInt8(s.jf, o + 3);
    out.writeUInt32LE(s.k >>> 0, o + 4);
  });
  return out;
}

/** Number of BPF instructions (needed for the "4 + 2*N + 3" sanity check). */
export function instructionCount() { return buildSeccompFilter().length; }
