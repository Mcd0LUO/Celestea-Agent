/**
 * W274 spike — item 3/4: the bwrap OS layer from Node.
 * Verifies read-only root, private tmpfs, net isolation, pid ns, seccomp and
 * env scrubbing — i.e. what the Rust *userspace* path does NOT provide.
 * Run: npx tsx spikes/sandbox/06-bwrap-layer.ts
 */
import { runSandboxed, probeHost } from './lib/sandbox.ts';

const line = (s: string) => console.log(`\n### ${s}`);
const probe = probeHost();
console.log('probe:', JSON.stringify(probe));

line('0) startup self-check: bwrap usable with the CORRECTED argument order?');
console.log('bwrapUsable =', probe.bwrapUsable, '| rejectReason =', probe.bwrapRejectReason);

line('1) read-only root');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'touch /etc/w274 2>&1; echo "root-rc=$?"; mkdir /opt/w274 2>&1; echo "mkdir-rc=$?"'],
  });
  console.log(r.stdout.trim(), '\nmeta =', JSON.stringify(r.meta));
}

line('2) private tmpfs /tmp (host /tmp must not see it)');
{
  const r = await runSandboxed({
    program: '/bin/sh', args: ['-c', 'echo secret > /tmp/w274-private && cat /tmp/w274-private'],
  });
  console.log('inside:', JSON.stringify(r.stdout.trim()));
  const { existsSync } = await import('node:fs');
  console.log('outside (host /tmp/w274-private exists?) =', existsSync('/tmp/w274-private'), '=> private tmp works');
}

line('3) network namespace isolated');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'ip -o link 2>/dev/null | wc -l; getent hosts example.com 2>&1 | head -1; echo "(empty above => isolated)"'],
  });
  console.log('inside :', JSON.stringify(r.stdout.trim()));
  console.log('meta.netIsolated =', r.meta.netIsolated);
  const h = await runSandboxed({ program: '/bin/sh', args: ['-c', 'getent hosts example.com | head -1'], isolateNet: false });
  console.log('host net (--share-net):', JSON.stringify(h.stdout.trim()), '| meta.netIsolated =', h.meta.netIsolated);
}

line('4) pid namespace (processes inside cannot see the host tree)');
{
  const r = await runSandboxed({ program: '/bin/sh', args: ['-c', 'echo "visible procs: $(ls -d /proc/[0-9]* | wc -l)"; echo "self pid=$$"'] });
  console.log(r.stdout.trim());
}

line('5) seccomp whitelist installed from a TS-built BPF blob');
{
  const den = await runSandboxed({
    program: 'perl', args: ['-e', 'my $r = syscall(101,0,0,0); print "ptrace rc=$r errno=".($!||0)."\n";'],
    seccomp: true,
  });
  console.log('with seccomp   :', JSON.stringify(den.stdout.trim()), '| meta.seccomp =', den.meta.seccomp);
  const all = await runSandboxed({
    program: 'perl', args: ['-e', 'my $r = syscall(101,0,0,0); print "ptrace rc=$r errno=".($!||0)."\n";'],
    seccomp: false,
  });
  console.log('without seccomp:', JSON.stringify(all.stdout.trim()), '| meta.seccomp =', all.meta.seccomp);
  const ok = await runSandboxed({
    program: '/bin/sh', args: ['-c', 'echo hello; ls /etc | head -2; head -c4 /dev/zero | xxd | head -1'],
    seccomp: true,
  });
  console.log('ordinary work under seccomp still fine:', ok.code === 0, JSON.stringify(ok.stdout.trim().slice(0, 80)));
}

line('6) env scrubbing — host secrets never reach the child');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'echo "HOME=[$HOME]"; env | wc -l; echo "TMPDIR=$TMPDIR"'],
    env: { MY_EXPLICIT: 'yes' },
  });
  console.log(r.stdout.trim());
  console.log('=> HOME is empty (allowlist drops it), TMPDIR pinned to /tmp, env count small');
}
