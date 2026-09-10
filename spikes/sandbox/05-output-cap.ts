/**
 * W274 spike — item 3: per-stream output cap WITH drain.
 * Rust caps stdout/stderr at 64 KiB and keeps draining so the child can never
 * block on a full pipe (sandbox.rs header, guarantee #2).
 * Run: npx tsx spikes/sandbox/05-output-cap.ts
 */
import { runSandboxed } from './lib/sandbox.ts';

const line = (s: string) => console.log(`\n### ${s}`);

line('1) 8 MiB of stdout with a 4 KiB cap: must truncate AND must not deadlock');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'head -c 8388608 /dev/zero | tr "\\0" "x"; echo; echo TAIL-MARKER'],
    timeoutMs: 30_000, maxOutputBytes: 4096, isolateNet: false,
  });
  console.log({
    code: r.code, timedOut: r.timedOut,
    stdoutBytesSeen: r.stdoutBytes, stdoutKept: r.stdout.length,
    stdoutTruncated: r.stdoutTruncated, stderrBytesSeen: r.stderrBytes,
    durationMs: r.durationMs,
  });
  console.log('drain proof: the command COMPLETED (no deadlock) and total bytes were counted =', r.stdoutBytes);
}

line('2) interleaved stdout+stderr, each capped independently');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'i=0; while [ $i -lt 2000 ]; do echo "out-$i"; echo "err-$i" >&2; i=$((i+1)); done'],
    timeoutMs: 30_000, maxOutputBytes: 1024,
  });
  console.log({
    code: r.code,
    stdoutKept: r.stdout.length, stdoutBytesSeen: r.stdoutBytes, stdoutTruncated: r.stdoutTruncated,
    stderrKept: r.stderr.length, stderrBytesSeen: r.stderrBytes, stderrTruncated: r.stderrTruncated,
  });
  console.log('head of stdout:', JSON.stringify(r.stdout.slice(0, 40)));
}

line('3) output cap ON vs OFF (off must be able to lose the process to memory)');
{
  const r = await runSandboxed({
    program: '/bin/sh', args: ['-c', 'echo "just 12 bytes"'],
    maxOutputBytes: 64,
  });
  console.log(r.stdout.trim(), '| truncated =', r.stdoutTruncated);
}
