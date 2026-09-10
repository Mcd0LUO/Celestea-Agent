# Sandbox primitive feasibility spike (W274)

Answers one question: **can the TypeScript rewrite reach parity with the Rust engine's
sandbox (`crates/tools/src/sandbox.rs`), and what external dependencies does that need?**

This directory is **spike-only** — no production code, nothing under `packages/` or
`apps/` is touched.

```
lib/sandbox.ts        spike-grade layered sandbox (probe -> build argv -> spawn -> reap)
lib/seccomp-bpf.mjs   port of the Rust seccomp_v2 filter builder (cBPF blob for bwrap)
01-host-probe.sh      host capability probe
02-bwrap-order.sh     ROOT CAUSE demo: bwrap argument-order bug
03-rlimit.ts          the five rlimit classes
03b-shell-ulimit.sh   pure-shell rlimit fallback (no prlimit binary)
04-pgroup.ts          process group, timeout kill, setsid escape
04b/04c               orphan / parent-death (SIGKILL) containment
05-output-cap.ts      per-stream cap + drain (no deadlock)
06-bwrap-layer.ts     ro root, private tmp, netns, pidns, seccomp, env scrub
07-confinement.ts     workdir confinement without chroot
run-all.sh            runs everything -> logs/run-all.log
```

Run: `./run-all.sh` (or any single script). Requires `/bin/sh`; uses `bwrap`, `prlimit`,
`perl`, `python3` when present.

---

## Headline findings

### 1. W268's premise is wrong: bwrap works on this host

W268 measured "`bwrap` 内 `/dev/zero` 不可读" and concluded production runs the v1
userspace fallback. The device failure is real, but the cause is **argument order in the
Rust code**, not the kernel or AppArmor:

```sh
# Rust sandbox.rs:700-709 and :437-455 both emit --dev BEFORE --ro-bind:
bwrap --unshare-all --dev /dev --proc /proc --ro-bind / / ...
#   -> /bin/sh: cannot open /dev/zero: Permission denied

# swap the two and every device works:
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc ...
#   -> DEV-OK
```

The later `--ro-bind / /` mounts the host root *over* the private devtmpfs, so the child
sees host device nodes through a read-only bind mount and every `open()` gets `EACCES`.
Because `bwrap_sandbox_usable()` (sandbox.rs:433-462) probes with the same broken order,
it returns `false`, `detect_provider()` (sandbox.rs:518-543) selects
`V2Provider::Userspace`, and production silently loses netns/tmpfs/ro-root — **on a host
where bubblewrap is fully functional**.

Raw `unshare -Urn` genuinely does fail here (`uid_map: Operation not permitted`,
`apparmor_restrict_unprivileged_userns=1`), so the *raw* provider really is unavailable —
but bwrap is not, because Ubuntu ships `/etc/apparmor.d/bwrap-userns-restrict`, which
grants `userns` to bwrap specifically.

### 2. Every Rust sandbox capability is reachable from TypeScript

| Rust capability | TS mechanism | Verdict |
|---|---|---|
| RLIMIT_CPU/AS/FSIZE/NOFILE/CORE | `prlimit --cpu --as --fsize --nofile --core --` | **parity** |
| …same, with no prlimit binary | `/bin/sh -c 'ulimit -t -v -f -n -c; exec "$0" "$@"'` | **parity, no external dep** |
| RLIMIT_NPROC | `prlimit --nproc` | **parity but dangerous** (see §3) |
| timeout + whole-group kill | `spawn(detached:true)` + `process.kill(-pid,'SIGKILL')` | **parity** |
| output cap + drain | stream reader that counts and discards past the cap | **parity** |
| private tmpfs /tmp | `bwrap --tmpfs /tmp` | **parity** |
| network isolation | `bwrap --unshare-all` | **parity** |
| read-only root | `bwrap --ro-bind / /` | **parity** |
| pid/ipc/uts/user namespaces | `bwrap --unshare-all` | **parity** |
| seccomp whitelist | `bwrap --seccomp FD` + TS-built cBPF blob | **parity, pure TS** |
| workdir + root check | lexical check in TS | **parity** |
| env sanitization | explicit `env` to `spawn` | **parity** |
| structured errors | error class with stable `code=` render | **parity** |
| chroot-style hiding | `bwrap --tmpfs <dir>` masking | **parity via bwrap** |
| raw `unshare+chroot` provider | needs `unshare(2)`/`chroot(2)` | **NOT reachable** (no CAP_SYS_CHROOT, CapEff=0) — **but unnecessary** |

Only the *raw namespace* provider is unreachable from Node, and it is unreachable for the
Rust engine too on this host. Nothing requires a Rust helper.

### 3. RLIMIT_NPROC is a trap on a shared UID

`RLIMIT_NPROC` counts **all threads owned by the real UID**, not the sandboxed tree. With
uid 1003 owning ~347 threads system-wide:

```
nproc=346  -> bwrap: Can't fork for pid 1: Resource temporarily unavailable
nproc=348  -> reached-child        (works)
```

So any `nproc` limit below the UID's current thread count makes bwrap fail to create its
namespaces (`EAGAIN`) — and on the userspace path it makes `fork()` fail inside the
sandbox. The Rust default of `nproc = 512` sits only ~165 threads above today's count;
under load, sandboxed commands would start failing or silently changing provider.
**Recommendation: derive the cap from the current UID thread count (count + headroom), or
drop NPROC as a per-sandbox control.**

### 4. Orphan containment differs sharply between layers

Parent is `SIGKILL`ed (uncatchable — Node `exit` handlers cannot run, and Rust's
`kill_on_drop` has the same hole):

```
mode=bwrap     'sleep 240' before=3 after=0   VERDICT: CONTAINED
mode=userspace 'sleep 240' before=1 after=1   VERDICT: ORPHAN LEAK
```

`--die-with-parent` + pid-namespace teardown contains the tree; the userspace path leaks
it. Separately, a child that calls `setsid()` survives `killpg` on the userspace path
(1 escapee reparented to init) and is contained under bwrap (0).

### 5. Consequence for the stop-loss line

The stop-loss condition was ">12 person-days and still no parity, or a Rust helper must be
kept". **Neither holds.** With `bwrap` + `prlimit` (both already installed, no new system
packages) plus pure-TS code, the TS side reaches parity with the Rust *userspace* path and
in fact exceeds it (the Rust engine is currently stuck on userspace because of the
argument-order bug). The only dependency is two ordinary util-linux/bubblewrap binaries
that the Rust engine already depends on, so "zero Rust" is preserved.

---

## Safety notes learned while spiking

* **Never pattern-kill on this host.** `pkill -f 'sleep 60'` matched the `sleep` child of
  `/server-center/worker-ops/center-sentinel.sh` (a **root-owned production watchdog**).
  The sentinel self-healed and lost at most one tick, but the lesson stands: kill by
  recorded pid, never by command pattern. The scripts here use unique sleep durations
  (4523/3007/6017) and uid-scoped `ps` filters for exactly this reason.
* `--seccomp FD` needs the blob on a **known fd**; `stdio: ['ignore','pipe','pipe', fd]`
  and `--seccomp 3` is the clean way from Node.
