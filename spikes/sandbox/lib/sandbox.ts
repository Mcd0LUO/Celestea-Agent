/**
 * W274 spike — spike-grade layered sandbox for the TS rewrite.
 *
 * NOT production code. This exists to measure what the TS side can achieve
 * against the Rust engine's sandbox (crates/tools/src/sandbox.rs):
 *   - v1 "userspace" path  : rlimits + timeout + output cap + cwd + env scrub
 *   - v2 OS path           : + bwrap namespaces (net/tmp/ro-root/pid)
 *
 * Layer order (outermost -> innermost), each layer optional and probe-gated:
 *
 *   node spawn(detached:true)          -> own process group  (group kill)
 *     [prlimit | /bin/sh 'ulimit ...'] -> RLIMIT_CPU/AS/NPROC/FSIZE/NOFILE/CORE
 *       [bwrap ...]                    -> user/mount/pid/net/ipc/uts ns, ro root,
 *                                         private tmpfs /tmp, optional seccomp
 *         /bin/sh -c 'ulimit ...; exec'-> rlimit fallback when prlimit absent
 *           the actual program
 *
 * Requires: node >= 20, /bin/sh. Optional: prlimit (util-linux), bwrap.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { toBlobBytes } from './seccomp-bpf.mjs';

// ---------------------------------------------------------------- limits ----

/** Mirrors Rust V2Limits::default() (sandbox.rs:252-263). */
export interface V2Limits {
  cpuSec: number;
  memMb: number;
  nproc: number;
  fsizeBytes: number;
  nofile: number;
  core: boolean;
}

export const DEFAULT_LIMITS: V2Limits = {
  cpuSec: 20,
  memMb: 2048,
  nproc: 512,
  fsizeBytes: 256 * 1024 * 1024,
  nofile: 256,
  core: true,
};

// ------------------------------------------------------------ host probe ----

export interface HostProbe {
  bwrapPath: string | null;
  bwrapVersion: string | null;
  /** true => bwrap is a usable drop-in for the v1 device contract. */
  bwrapUsable: boolean;
  /** reason the probe rejected bwrap, for the startup self-check log. */
  bwrapRejectReason: string | null;
  prlimitPath: string | null;
  rawUnshareWorks: boolean;
  shellUlimitWorks: boolean;
  nodeVersion: string;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function tryExec(file: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return { ok: true, out: out.toString() };
  } catch (e: any) {
    return { ok: false, out: `${e?.stdout ?? ''}${e?.stderr ?? ''}${e?.message ?? e}` };
  }
}

let probeCache: HostProbe | null = null;

/** Item 1/2: detect the external primitives actually available here. */
export function probeHost(): HostProbe {
  if (probeCache) return probeCache;

  const bwrapPath = which('bwrap');
  let bwrapVersion: string | null = null;
  let bwrapUsable = false;
  let bwrapRejectReason: string | null = null;

  if (bwrapPath) {
    const v = tryExec(bwrapPath, ['--version']);
    bwrapVersion = v.ok ? v.out.trim() : null;
    // >>> THE FIX vs Rust sandbox.rs:437-455 <<<
    // `--ro-bind / /` MUST come before `--dev /dev`; otherwise the host root
    // shadows the private devtmpfs and device nodes become EACCES.
    const probe = tryExec(bwrapPath, [
      '--unshare-all',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--',
      '/bin/sh', '-c', 'exec 3</dev/zero 2>/dev/null && printf ok || printf no',
    ]);
    bwrapUsable = probe.out.includes('ok');
    if (!bwrapUsable) bwrapRejectReason = `device probe failed: ${probe.out.trim() || '(no output)'}`;
  } else {
    bwrapRejectReason = 'bwrap not found on PATH';
  }

  const prlimitPath = which('prlimit');
  const rawProbe = tryExec('unshare', ['-Urn', 'true']);
  const shellProbe = tryExec('/bin/sh', ['-c', 'ulimit -v 65536 2>/dev/null && ulimit -t 1 && echo ok']);

  probeCache = {
    bwrapPath,
    bwrapVersion,
    bwrapUsable,
    bwrapRejectReason,
    prlimitPath,
    rawUnshareWorks: rawProbe.ok,
    shellUlimitWorks: shellProbe.out.includes('ok'),
    nodeVersion: process.version,
  };
  return probeCache;
}

// ------------------------------------------------------------------ errors ----

export type SandboxErrorCode =
  | 'timeout' | 'spawn_failed' | 'workdir_outside_root' | 'workdir_missing'
  | 'rlimit_unsupported' | 'internal';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: SandboxErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.detail = detail;
  }
  /** Stable one-line form, mirroring Rust's `run_shell-sandbox: code=... msg=...`. */
  render(): string {
    return `run_shell-sandbox: code=${this.code} msg=${this.message}`;
  }
}

// ------------------------------------------------------------------- result ----

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  meta: {
    provider: 'bwrap' | 'userspace';
    netIsolated: boolean;
    privateTmp: boolean;
    seccomp: boolean;
    readonlyRoot: boolean;
    rlimitVia: 'prlimit' | 'shell-ulimit' | 'none';
  };
}

export interface RunOptions {
  program: string;
  args?: string[];
  cwd?: string;
  /** Root the resolved cwd must stay inside. Defaults to cwd. */
  root?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  limits?: Partial<V2Limits>;
  /** isolate the network namespace (default true). */
  isolateNet?: boolean;
  /** private tmpfs /tmp (default true). */
  privateTmp?: boolean;
  /** install the seccomp syscall whitelist via bwrap (default false). */
  seccomp?: boolean;
  /** force the v1 userspace path even when bwrap is usable (parity comparison). */
  disableBwrap?: boolean;
}

/** Env allowlist — mirrors Rust ENV_ALLOWLIST (sandbox.rs:108-109). */
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM'];

export function scrubEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { TMPDIR: '/tmp' };
  for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) out[k] = process.env[k]!;
  return { ...out, ...extra };
}

// -------------------------------------------------------------- argv build ----

interface Built {
  file: string;
  args: string[];
  extraFds: number[];   // fds handed to the child beyond stdio
  cleanup: () => void;
  meta: RunResult['meta'];
}

function buildCommand(opts: Required<Pick<RunOptions, 'program' | 'args' | 'cwd'>> & {
  limits: V2Limits; isolateNet: boolean; privateTmp: boolean; seccomp: boolean;
  probe: HostProbe; disableBwrap: boolean;
}): Built {
  const { program, args, cwd, limits, isolateNet, privateTmp, seccomp, probe } = opts;
  const bwrapOk = probe.bwrapUsable && !opts.disableBwrap;
  const extraFds: number[] = [];
  const cleanups: Array<() => void> = [];
  let rlimitVia: RunResult['meta']['rlimitVia'] = 'none';

  // ---- layer 4 (innermost): shell ulimit, used only when prlimit is absent.
  let innerFile = program;
  let innerArgs = [...args];
  if (!probe.prlimitPath) {
    if (!probe.shellUlimitWorks) {
      throw new SandboxError('rlimit_unsupported',
        'no prlimit binary and /bin/sh has no usable ulimit builtin; rlimits cannot be enforced');
    }
    const ul = [
      `ulimit -t ${limits.cpuSec}`,
      `ulimit -v ${limits.memMb * 1024}`,
      `ulimit -u ${limits.nproc}`,
      `ulimit -f ${Math.floor(limits.fsizeBytes / 1024)}`,
      `ulimit -n ${limits.nofile}`,
      limits.core ? 'ulimit -c 0' : 'ulimit -c unlimited',
    ].join('; ');
    innerArgs = ['-c', `${ul}; exec "$0" "$@"`, innerFile, ...innerArgs];
    innerFile = '/bin/sh';
    rlimitVia = 'shell-ulimit';
  }

  // ---- layer 3: bwrap namespaces.
  let bwrapApplied = false;
  if (bwrapOk && probe.bwrapPath) {
    const b: string[] = ['--unshare-all', '--die-with-parent'];
    // ORDER MATTERS: root bind first, then the private devtmpfs on top.
    b.push('--ro-bind', '/', '/');
    b.push('--dev', '/dev');
    b.push('--proc', '/proc');
    if (!isolateNet) b.push('--share-net');
    if (privateTmp) b.push('--tmpfs', '/tmp');
    else b.push('--bind', '/tmp', '/tmp');
    b.push('--bind', cwd, cwd);
    b.push('--chdir', cwd);
    if (seccomp) {
      const blob = join(tmpdir(), `w274-seccomp-${process.pid}-${Date.now()}.bpf`);
      writeFileSync(blob, toBlobBytes());
      const fd = openSync(blob, 'r');
      extraFds.push(fd);
      cleanups.push(() => { try { closeSync(fd); } catch {} try { unlinkSync(blob); } catch {} });
      b.push('--seccomp', String(3)); // stdio[3] in the child
    }
    b.push('--', innerFile, ...innerArgs);
    innerFile = probe.bwrapPath;
    innerArgs = b;
    bwrapApplied = true;
  } else if (seccomp) {
    // seccomp without bwrap would need a native helper (see report gap table).
    throw new SandboxError('rlimit_unsupported',
      'seccomp requested but no usable bwrap; TS has no setrlimit/seccomp syscall path',
      { bwrapRejectReason: probe.bwrapRejectReason });
  }

  // ---- layer 2: prlimit (applies to bwrap and is inherited by its child).
  let outerFile = innerFile;
  let outerArgs = innerArgs;
  if (probe.prlimitPath) {
    outerFile = probe.prlimitPath;
    outerArgs = [
      `--cpu=${limits.cpuSec}`,
      `--as=${limits.memMb * 1024 * 1024}`,
      `--nproc=${limits.nproc}`,
      `--fsize=${limits.fsizeBytes}`,
      `--nofile=${limits.nofile}`,
      `--core=${limits.core ? 0 : 'unlimited'}`,
      '--', innerFile, ...innerArgs,
    ];
    rlimitVia = 'prlimit';
  }

  return {
    file: outerFile,
    args: outerArgs,
    extraFds,
    cleanup: () => { for (const c of cleanups) c(); },
    meta: {
      provider: bwrapApplied ? 'bwrap' : 'userspace',
      netIsolated: bwrapApplied && isolateNet,
      privateTmp: bwrapApplied && privateTmp,
      seccomp: bwrapApplied && seccomp,
      readonlyRoot: bwrapApplied,
      rlimitVia,
    },
  };
}

// ------------------------------------------------------------------- runner ----

export async function runSandboxed(opts: RunOptions): Promise<RunResult> {
  const probe = probeHost();
  const limits: V2Limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const cwd = resolve(opts.cwd ?? process.cwd());
  const root = resolve(opts.root ?? cwd);

  // workdir confinement: no chroot available, so this is a lexical check.
  if (cwd !== root && !cwd.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new SandboxError('workdir_outside_root',
      `workdir escapes the sandbox root (workdir=${cwd} root=${root})`, { cwd, root });
  }
  if (!existsSync(cwd)) {
    throw new SandboxError('workdir_missing', `workdir does not exist: ${cwd}`, { cwd });
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutput = opts.maxOutputBytes ?? 64 * 1024;

  const built = buildCommand({
    program: opts.program, args: opts.args ?? [], cwd, limits,
    isolateNet: opts.isolateNet ?? true,
    privateTmp: opts.privateTmp ?? true,
    seccomp: opts.seccomp ?? false,
    probe,
    disableBwrap: opts.disableBwrap ?? false,
  });

  const stdio: Array<any> = ['ignore', 'pipe', 'pipe', ...built.extraFds];

  let child: ChildProcess;
  try {
    child = spawn(built.file, built.args, {
      cwd,
      env: scrubEnv(opts.env),
      stdio,
      detached: true,          // own process group => process.kill(-pid) reaps the tree
    });
  } catch (e: any) {
    built.cleanup();
    throw new SandboxError('spawn_failed', `${built.file}: ${e?.message ?? e}`);
  }
  built.cleanup();

  const started = Date.now();
  let stdoutBytes = 0, stderrBytes = 0;
  let stdout = '', stderr = '';
  let stdoutTruncated = false, stderrTruncated = false;
  let timedOut = false;

  // Item 2: cap + DRAIN (never let the child block on a full pipe).
  const sink = (whichStream: 'out' | 'err') => (chunk: Buffer) => {
    if (whichStream === 'out') {
      stdoutBytes += chunk.length;
      if (stdout.length < maxOutput) {
        stdout += chunk.toString('utf8', 0, maxOutput - stdout.length);
        if (stdoutBytes > maxOutput) stdoutTruncated = true;
      } else stdoutTruncated = true;
    } else {
      stderrBytes += chunk.length;
      if (stderr.length < maxOutput) {
        stderr += chunk.toString('utf8', 0, maxOutput - stderr.length);
        if (stderrBytes > maxOutput) stderrTruncated = true;
      } else stderrTruncated = true;
    }
    // chunk is consumed either way -> the pipe drains, no backpressure deadlock.
  };
  child.stdout?.on('data', sink('out'));
  child.stderr?.on('data', sink('err'));

  const pid = child.pid!;
  const killGroup = (sig: NodeJS.Signals) => {
    // kill the whole process group; fall back to the direct child.
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
  };

  // Item 2: timeout kills the ENTIRE group, not just the leader.
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGKILL');
    // bounded grace: escalate again in case a member raced the group kill
    setTimeout(() => killGroup('SIGKILL'), 250).unref();
  }, timeoutMs);

  const onParentExit = () => killGroup('SIGKILL');
  process.once('exit', onParentExit);
  process.once('SIGINT', onParentExit);
  process.once('SIGTERM', onParentExit);

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (res) => child.once('close', (c, s) => res({ code: c, signal: s })),
  );

  clearTimeout(timer);
  process.removeListener('exit', onParentExit);
  process.removeListener('SIGINT', onParentExit);
  process.removeListener('SIGTERM', onParentExit);

  return {
    code, signal, stdout, stderr,
    stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated, timedOut,
    durationMs: Date.now() - started,
    meta: built.meta,
  };
}
