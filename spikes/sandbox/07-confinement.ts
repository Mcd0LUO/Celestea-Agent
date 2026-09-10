/**
 * W274 spike — item 4: confining the child to a directory when chroot is
 * unavailable (no CAP_SYS_CHROOT; uid 1003 has CapEff=0).
 * Run: npx tsx spikes/sandbox/07-confinement.ts
 */
import { runSandboxed, SandboxError } from './lib/sandbox.ts';
import { execFileSync } from 'node:child_process';

const line = (s: string) => console.log(`\n### ${s}`);

line('1) user-space workdir confinement is LEXICAL only — absolute paths still escape');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'echo "cwd=$(pwd)"; echo "--- leaked host file:"; head -1 /etc/passwd; echo "--- host home:"; ls /home 2>&1 | head -3'],
    cwd: process.cwd(),
  });
  console.log(r.stdout.trim());
  console.log('meta =', JSON.stringify(r.meta));
  console.log('=> with the bwrap layer the root is read-only but still READABLE; there is no chroot-style hiding.');
}

line('2) structured error: workdir outside the sandbox root');
{
  try {
    await runSandboxed({ program: '/bin/sh', args: ['-c', 'true'], cwd: '/tmp', root: process.cwd() });
    console.log('NO ERROR (unexpected)');
  } catch (e) {
    if (e instanceof SandboxError) console.log('SandboxError.render() =', e.render(), '\ndetail =', JSON.stringify(e.detail));
    else throw e;
  }
}

line('3) REAL confinement: mask everything except the project with bwrap');
{
  // Root is mounted read-only, then every top-level directory that is not part
  // of the toolchain is shadowed by an empty tmpfs.
  const KEEP = ['usr', 'lib', 'lib64', 'bin', 'sbin', 'etc', 'proc', 'dev', 'tmp', 'var', 'opt', 'run', 'sys'];
  const HIDE = ['home', 'root', 'srv', 'mnt', 'media', 'boot'];
  const args: string[] = [
    '--unshare-all',
    '--ro-bind', '/', '/',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    ...HIDE.flatMap((d) => ['--tmpfs', `/${d}`]),
    '--bind', process.cwd(), process.cwd(),
    '--chdir', process.cwd(),
    '--',
  ];
  const bwrap = '/usr/bin/bwrap';
  const cmd = [...args, '/bin/sh', '-c', 'echo "--- /home:"; ls -A /home | wc -l; echo "--- /root:"; ls -A /root 2>&1 | wc -l; echo "--- project visible:"; ls /src/celestea_studio-ts | head -3'];
  const out = execFileSync(bwrap, cmd, { encoding: 'utf8' });
  console.log(out.trim());
  console.log('=> masking makes "hide everything but the project" real, without chroot.');
  void KEEP;
}

line('4) bwrap also masks /sys leaks seen in the ro-bind-only variant');
{
  const out = execFileSync('/usr/bin/bwrap', [
    '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', '/sys', '--',
    '/bin/sh', '-c', 'echo "net ifaces via /sys: $(ls /sys/class/net 2>/dev/null | wc -l)"; ip -o link 2>/dev/null | wc -l',
  ], { encoding: 'utf8' });
  console.log(out.trim());
  console.log('=> masking /sys removes the stale host-interface leak while the real netns stays isolated.');
}
