/**
 * W274 spike — item 2/3: the five rlimit classes from Node.
 *
 * Two independent mechanisms, both verified here:
 *   (a) `prlimit` binary (util-linux) — preferred, sets soft+hard.
 *   (b) `/bin/sh` `ulimit` builtin inside a `sh -c 'ulimit ...; exec "$0" "$@"'`
 *       preamble — pure-shell fallback, needs no external binary at all.
 *
 * Run:  npx tsx spikes/sandbox/03-rlimit.ts
 */
import { runSandboxed, probeHost, DEFAULT_LIMITS } from './lib/sandbox.ts';

const probe = probeHost();
const line = (s: string) => console.log(`\n### ${s}`);
const show = (r: any) => ({
  code: r.code, signal: r.signal,
  stdout: r.stdout.trim().slice(0, 300),
  stderr: r.stderr.trim().slice(0, 300),
  timedOut: r.timedOut,
  meta: `${r.meta.provider}/rlimit=${r.meta.rlimitVia}`,
});

console.log('probe:', JSON.stringify(probe));

line('0) the limits actually land in the child: `ulimit -a` inside the sandbox');
{
  const r = await runSandboxed({
    program: '/bin/sh', args: ['-c', 'ulimit -a'],
    limits: { cpuSec: 7, memMb: 512, nproc: 128, fsizeBytes: 8 * 1024 * 1024, nofile: 64, core: true },
  });
  console.log(r.stdout);
  console.log('meta =', JSON.stringify(r.meta));
}

line('1) RLIMIT_CPU=1 — busy loop must be killed by the kernel');
{
  const r = await runSandboxed({
    program: '/bin/sh', args: ['-c', 'while :; do :; done'],
    timeoutMs: 20_000, limits: { cpuSec: 1 },
  });
  console.log(show(r));
}

line('2) RLIMIT_AS=512MiB — 3GiB allocation must fail');
{
  const r = await runSandboxed({
    program: 'python3', args: ['-c', 'b = bytearray(3*1024*1024*1024); print("ALLOCATED", len(b))'],
    timeoutMs: 20_000, limits: { memMb: 512 },
  });
  console.log(show(r));
}

line('3) RLIMIT_FSIZE=1MiB — writing 100MiB must stop at the cap');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'dd if=/dev/zero of=/tmp/w274-fsize bs=1M count=100 2>&1; echo "rc=$?"; ls -l /tmp/w274-fsize'],
    timeoutMs: 20_000, limits: { fsizeBytes: 1024 * 1024 },
  });
  console.log(show(r));
}

line('4) RLIMIT_NOFILE=32 — fd exhaustion must hit the cap');
{
  const py = [
    'import os,sys',
    'n=0',
    'try:',
    '    while True:',
    "        os.open('/dev/null', os.O_RDONLY); n+=1",
    'except OSError as e:',
    "    print('opened', n, 'extra fds then failed:', e.strerror)",
  ].join('\n');
  const r = await runSandboxed({
    program: 'python3', args: ['-c', py],
    timeoutMs: 20_000, limits: { nofile: 32 },
  });
  console.log(show(r));
}

line('5) RLIMIT_NPROC — FINDING: it counts the UID\'s THREADS, not the sandbox tree');
{
  // NB: /proc inside the sandbox is a FRESH procfs (--unshare-pid), so the
  // count must be taken on the HOST, before sandboxing.
  const { execSync } = await import('node:child_process');
  const threads = Number(execSync('ps -u $(id -u) -L -o lwp= | wc -l').toString().trim());
  console.log(`host-wide threads owned by uid $(id -u) = ${threads}`);
  for (const n of [24, threads - 1, threads + 1, 512]) {
    const r = await runSandboxed({
      program: '/bin/sh', args: ['-c', 'echo reached-child'],
      timeoutMs: 20_000, limits: { nproc: n },
    });
    console.log(`  nproc=${String(n).padEnd(6)} -> code=${r.code} stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim())}`);
  }
}

line('6) limits observed by the child when prlimit IS used');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'echo "AS(KiB)=$(ulimit -v) CPU=$(ulimit -t) FSIZE(blocks)=$(ulimit -f) NOFILE=$(ulimit -n)"'],
    limits: DEFAULT_LIMITS,
  });
  console.log(show(r));
  console.log('interpretation: prlimit --as / --cpu / --fsize-mb / --nofile map 1:1 onto ulimit -v/-t/-f/-n');
}
