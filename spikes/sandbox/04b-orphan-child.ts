/** Helper for 04c: sandbox a long sleep, publish its pid, then hang forever. */
import { runSandboxed } from './lib/sandbox.ts';
import { writeFileSync } from 'node:fs';
const marker = process.argv[2]!;             // marker file path
const useBwrap = process.argv[3] !== 'nobwrap';
const r = runSandboxed({
  program: '/bin/sh',
  args: ['-c', 'echo $$ > "$PWD/$(basename ' + marker + ')"; exec sleep 240'],
  cwd: process.cwd(),                    // bind-mounted => marker visible on host
  timeoutMs: 600_000,
  disableBwrap: !useBwrap,               // compare userspace vs bwrap on one box
});
// NB: SIGKILL cannot be caught in Node — that is exactly why this test matters.
r.then((x) => console.log('sandbox exited', x.code, JSON.stringify(x.meta)));
setInterval(() => {}, 1000);                  // keep the node parent alive
