#!/bin/sh
# W274 sandbox spike - ROOT CAUSE demo.
#
# W268 concluded "bwrap 内 /dev/zero 不可读" and that production therefore runs the
# v1 userspace fallback. That conclusion is WRONG on this host: device access
# fails only because the bubblewrap argument order puts `--dev /dev` BEFORE
# `--ro-bind / /`. The later `--ro-bind / /` mounts the host root *over* the
# private devtmpfs, so the child sees the host's device nodes through a
# read-only bind mount and every open() gets EACCES.
#
# Rust: crates/tools/src/sandbox.rs:700-709 (wrap_bwrap) and :437-455
# (bwrap_sandbox_usable) both emit:
#     --unshare-all --dev /dev --proc /proc --ro-bind / / ...
# so `bwrap_sandbox_usable` returns false -> detect_provider() picks
# V2Provider::Userspace -> production silently runs the userspace path.
#
# Swapping to `--ro-bind / / --dev /dev --proc /proc` fixes it completely.
set -u

say() { printf '\n### %s\n' "$1"; }

say "A) RUST ORDER (--dev before --ro-bind /) - the shipped behaviour"
bwrap --unshare-all --dev /dev --proc /proc --ro-bind / / --tmpfs /tmp -- \
  /bin/sh -c 'exec 3</dev/zero && echo "DEV-OK" || echo "DEV-DENIED"' 2>&1
echo "exit=$?"

say "B) FIXED ORDER (--ro-bind / before --dev /)"
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- \
  /bin/sh -c 'exec 3</dev/zero && echo "DEV-OK" || echo "DEV-DENIED"' 2>&1
echo "exit=$?"

say "C) FIXED ORDER, full device smoke (/dev/zero, /dev/null, /dev/urandom)"
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- \
  /bin/sh -c 'exec 3</dev/zero; exec 4</dev/null; head -c4 /dev/urandom >/dev/null && echo ALL-DEV-OK' 2>&1
echo "exit=$?"

say "D) FIXED ORDER: namespaces really are in effect"
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- \
  /bin/sh -c 'echo "pid-in-ns=$$ (pid 1-2 => --unshare-pid active)"; echo "net ifaces: $(ip -o link 2>/dev/null | wc -l) (1 => --unshare-net active)"' 2>&1
echo "exit=$?"

say "E) FIXED ORDER: read-only root, writable workdir, private /tmp"
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --bind "$PWD" "$PWD" -- \
  /bin/sh -c "touch /etc/w274-probe 2>&1; echo \"root ro rc=\$?\"; \
    echo w274 > /tmp/w274-probe && echo \"private /tmp writable: \$(cat /tmp/w274-probe)\"; \
    echo w274 > '$PWD/.w274-probe' && echo 'workdir writable: yes' && rm -f '$PWD/.w274-probe'" 2>&1
echo "exit=$?"

say "F) FIXED ORDER: network isolated (no DNS answer inside, answer outside)"
printf 'inside : '; timeout 10 bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- \
  /bin/sh -c 'getent hosts example.com 2>&1 | head -1; echo "(no address line above => isolated)"' 2>&1
printf 'outside: '; timeout 10 /bin/sh -c 'getent hosts example.com 2>&1 | head -1'
