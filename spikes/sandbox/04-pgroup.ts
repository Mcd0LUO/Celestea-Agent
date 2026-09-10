/**
 * W274 spike — item 2/4: process-group creation, timeout kill, orphan cleanup.
 *
 * Rust does this with `process_group(0)` + `killpg(SIGKILL)` + `kill_on_drop`.
 * Node's equivalents: `spawn(..., {detached:true})` (setsid => the child leads
 * a new process group) + `process.kill(-pid, 'SIGKILL')`.
 *
 * Run:  npx tsx spikes/sandbox/04-pgroup.ts
 */
import { runSandboxed } from './lib/sandbox.ts';
import { execSync } from 'node:child_process';

const line = (s: string) => console.log(`\n### ${s}`);
// uid-scoped: unrelated processes owned by other users must not pollute the count
const psCount = (pat: string) =>
  Number(execSync(`ps -u $(id -u) -eo pid=,args= | grep -F '${pat}' | grep -v grep | wc -l`).toString().trim());

/** Kill by exact pid (never pattern-kill: the pattern would match our own shell). */
const killPids = (pat: string) => {
  const rows = execSync(`ps -u $(id -u) -eo pid=,args= | grep -F '${pat}' | grep -v grep || true`)
    .toString().trim().split('\n').filter(Boolean);
  for (const row of rows) {
    const pid = Number(row.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid && pid !== process.ppid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
};

line('1) normal completion: descendants that outlive the leader are NOT auto-reaped');
{
  const r = await runSandboxed({
    program: '/bin/sh',
    args: ['-c', 'sleep 4523 & echo "bg-pid=$!"; echo done'],
    timeoutMs: 10_000,
  });
  console.log('result:', r.code, JSON.stringify(r.stdout.trim()), 'provider=', r.meta.provider);
  const left = psCount('sleep 4523');
  console.log(`sleep 4523 still alive after normal exit: ${left} (expect >=1 => leak on graceful path)`);
  killPids('sleep ' + '4523');
}

line('2) TIMEOUT kills the WHOLE process group (leader + grandchildren)');
{
  const before = psCount('w274-marker');
  const r = await runSandboxed({
    program: '/bin/sh',
    // leader (sh) + two background grandchildren, all sharing the process group
    args: ['-c', 'sleep 3007 & sleep 3007 & wait'],
    timeoutMs: 1500,
  });
  console.log('timedOut =', r.timedOut, 'code =', r.code, 'signal =', r.signal);
  await new Promise((res) => setTimeout(res, 500));
  const after = psCount('sleep 3007');
  console.log(`'sleep 3007' processes before=${before} after timeout=${after} (expect 0 => group killed)`);
  console.log('ps evidence:');
  try { console.log(execSync("ps -eo pid,pgid,args | grep 'sleep 3007' | grep -v grep || echo '  (none left)'").toString()); }
  catch { console.log('  (none left)'); }
}

line('3) escaping the group: a child that calls setsid() — userspace vs bwrap');
{
  for (const disableBwrap of [true, false]) {
    killPids('sleep ' + '6017');
    await new Promise((r) => setTimeout(r, 300));
    const r = await runSandboxed({
      program: '/bin/sh',
      args: ['-c', 'setsid sleep 6017 >/dev/null 2>&1 & echo "setsid-child=$!"; sleep 5'],
      timeoutMs: 1200,
      disableBwrap,
    });
    await new Promise((res) => setTimeout(res, 500));
    const escaped = psCount('sleep 6017');
    const rows = execSync(`ps -u $(id -u) -eo pid=,pgid=,ppid=,args= | grep -F 'sleep 6017' | grep -v grep || true`).toString().trim();
    console.log(
      `provider=${r.meta.provider.padEnd(9)} timedOut=${r.timedOut} ` +
      `setsid'd children surviving the group kill = ${escaped} ` +
      (escaped > 0 ? '=> ESCAPE' : '=> contained'),
    );
    if (rows) console.log('    survivors (pid/pgid/ppid/args):\n' + rows.split('\n').map((l) => '      ' + l.trim()).join('\n'));
  }
  killPids('sleep ' + '6017');
  console.log('=> GAP on the userspace path (killpg cannot reach setsid());');
  console.log('=> the bwrap pid-namespace reaps it because the ns init exit kills the tree.');
}

line('4) parent-death cleanup: does the tree survive SIGKILL of the Node parent?');
{
  console.log('see 04c-orphan-driver.sh — run by run-all.sh; result:');
  console.log(execSync('grep -A5 "mode=" ../../spikes/sandbox/logs/run-all.log | grep -E "mode=|AFTER" || true').toString().trim());
}
